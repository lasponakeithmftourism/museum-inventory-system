import { FirebaseError } from 'firebase/app';
import { collection, doc, getDocsFromServer, runTransaction, serverTimestamp } from 'firebase/firestore';
import type { DocumentReference, Firestore, Transaction } from 'firebase/firestore';
import { ITEM_FIELDS, PRINT_FIELDS, readItem, readPrintSettings } from './records';
import type { Item, PrintSettings, SavedItem } from './records';
import { readDriveFolderId } from './driveAttachments';

const INVENTORY_YEAR = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', year: 'numeric' });
const MAX_INVENTORY_NUMBER = 999;
type InventoryHead = { number: number; recordId: string };

function inventoryNumbers(documentId: string, inventoryId: unknown) {
  const numbers = new Map<string, number>();
  for (const id of [documentId, inventoryId]) {
    if (typeof id !== 'string') continue;
    const match = /^(\d{4})-(\d{3})$/.exec(id.trim());
    if (!match) continue;
    const [, year, digits] = match;
    numbers.set(year, Math.max(numbers.get(year) ?? 0, Number(digits)));
  }
  return numbers;
}

async function readInventorySequence(db: Firestore, transaction: Transaction, year: string, deletedId?: string) {
  const ref = doc(db, 'museumSettings', `inventorySequence-${year}`);
  const settings = (await transaction.get(ref)).data();
  const savedCounter = settings?.lastIssued;
  const lastIssued = Number.isInteger(savedCounter) && savedCounter >= 0 && savedCounter <= MAX_INVENTORY_NUMBER ? savedCounter : 0;
  const cached = settings?.current;
  if (cached?.lastIssued === lastIssued &&
    typeof cached.recordId === 'string' && cached.recordId && !cached.recordId.includes('/') && cached.recordId !== deletedId) {
    const record = await transaction.get(doc(db, 'museumCollections', cached.recordId));
    if (record.exists()) {
      const number = inventoryNumbers(record.id, record.data().inventoryId).get(year);
      if (number && number === cached.number) return { ref, lastIssued, head: { number, recordId: record.id } };
    }
  }

  return { ref, lastIssued, head: await findLatestInventoryRecord(db, transaction, year, deletedId) };
}

async function findLatestInventoryRecord(db: Firestore, transaction: Transaction, year: string, deletedId?: string) {
  const existing = await getDocsFromServer(collection(db, 'museumCollections'));
  const candidates = existing.docs
    .filter(record => record.id !== deletedId)
    .map(record => ({ recordId: record.id, number: inventoryNumbers(record.id, record.data().inventoryId).get(year) ?? 0 }))
    .filter(record => record.number > 0)
    .sort((a, b) => b.number - a.number);
  for (const candidate of candidates) {
    const record = await transaction.get(doc(db, 'museumCollections', candidate.recordId));
    if (record.exists() && inventoryNumbers(record.id, record.data().inventoryId).get(year) === candidate.number) {
      return candidate;
    }
  }
  return { number: 0, recordId: '' };
}

function formatInventoryId(year: string, number: number) {
  return `${year}-${String(number).padStart(3, '0')}`;
}

function writeInventorySequence(transaction: Transaction, ref: DocumentReference, head: InventoryHead, previousCounter: number) {
  // Older versions use the high-water mark. Their writes invalidate the cached live head.
  const lastIssued = Math.max(previousCounter, head.number);
  transaction.set(ref, { lastIssued, current: { ...head, lastIssued } }, { merge: true });
}

async function createItem(db: Firestore, record: Item) {
  const year = INVENTORY_YEAR.format(new Date());
  // The record's identity also identifies its Drive folder and survives inventory ID reuse.
  const ref = doc(collection(db, 'museumCollections'));
  return runTransaction(db, async transaction => {
    const sequence = await readInventorySequence(db, transaction, year);
    let number = sequence.head.number + 1;
    if (number <= MAX_INVENTORY_NUMBER) {
      const legacyRef = doc(db, 'museumCollections', formatInventoryId(year, number));
      if ((await transaction.get(legacyRef)).exists()) {
        number = (await findLatestInventoryRecord(db, transaction, year)).number + 1;
      }
    }
    if (number > MAX_INVENTORY_NUMBER) throw new Error(`The ${year} inventory sequence has reached ${MAX_INVENTORY_NUMBER}.`);
    const inventoryId = formatInventoryId(year, number);
    transaction.set(ref, { ...record, inventoryId, lastUpdated: serverTimestamp() });
    writeInventorySequence(transaction, sequence.ref, { number, recordId: ref.id }, sequence.lastIssued);
    return { id: ref.id, inventoryId };
  });
}

export async function writeItem(db: Firestore, form: Item, original?: SavedItem) {
  const itemTitle = form.itemTitle.trim();
  if (!itemTitle) throw new Error('Item Title is required.');
  const record = { ...form, itemTitle };
  if (!original) return createItem(db, record);

  const ref = doc(db, 'museumCollections', original.id);
  await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) throw new Error('This record was deleted. Close the editor to return to the register.');

    const current = readItem(snapshot.id, snapshot.data());
    if (current.deletionPending) throw new Error('This record is pending deletion. Open its details to finish deleting it.');
    const changes: Partial<Item> = {};
    for (const key of ITEM_FIELDS) {
      if (key === 'inventoryId' || key === 'lastUpdated' || record[key] === original[key]) continue;
      if (current[key] !== original[key] && current[key] !== record[key]) {
        throw new Error(`“${original.inventoryId}” changed while you were editing. Reopen it to review the latest version.`);
      }
      changes[key] = record[key];
    }
    if (Object.keys(changes).length) transaction.update(ref, { ...changes, lastUpdated: serverTimestamp() });
  });
  return { id: original.id, inventoryId: original.inventoryId };
}

function verifyRecordForDeletion(current: SavedItem, original: SavedItem) {
  if (current.driveFolderId !== original.driveFolderId || ITEM_FIELDS.some(key => current[key] !== original[key])) {
    throw new Error('This record changed. Review the latest details before deleting it.');
  }
}

async function deleteRecord(db: Firestore, transaction: Transaction, ref: DocumentReference, item: SavedItem) {
  const sequences = [];
  for (const [year, number] of inventoryNumbers(item.id, item.inventoryId)) {
    const sequence = await readInventorySequence(db, transaction, year, item.id);
    sequences.push({ ...sequence, lastIssued: Math.max(sequence.lastIssued, number) });
  }
  for (const sequence of sequences) {
    writeInventorySequence(transaction, sequence.ref, sequence.head, sequence.lastIssued);
  }
  transaction.delete(ref);
}

export async function deleteItem(db: Firestore, item: SavedItem, trashFolder?: () => Promise<void>) {
  if (item.driveFolderId && !trashFolder) throw new Error('Connect Google Drive to delete this record and its attachments.');
  const ref = doc(db, 'museumCollections', item.id);
  const folderId = await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) return '';
    const current = readItem(snapshot.id, snapshot.data());
    verifyRecordForDeletion(current, item);

    if (current.driveFolderId) {
      // Keep the record and its Drive reference until Drive confirms the folder is in Trash.
      if (!current.deletionPending) transaction.update(ref, { deletionPending: true });
      return current.driveFolderId;
    }
    await deleteRecord(db, transaction, ref, current);
    return '';
  });

  if (!folderId || !trashFolder) return;
  await trashFolder();
  await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) return;
    const current = readItem(snapshot.id, snapshot.data());
    verifyRecordForDeletion(current, item);
    if (!current.deletionPending) throw new Error('The pending deletion could not be verified. Try deleting the record again.');
    await deleteRecord(db, transaction, ref, current);
  });
}

export async function rememberDriveFolder(db: Firestore, recordId: string, folderId: string) {
  if (!readDriveFolderId(folderId)) throw new Error('Google Drive did not return a valid folder.');
  const ref = doc(db, 'museumCollections', recordId);
  return runTransaction(db, async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) throw new Error('This record was deleted. Attachments could not be uploaded.');
    if (snapshot.data().deletionPending === true) {
      throw new Error('This record is pending deletion. Attachments could not be uploaded.');
    }
    const existing = readDriveFolderId(snapshot.data().driveFolderId);
    if (existing) return existing;
    transaction.update(ref, { driveFolderId: folderId });
    return folderId;
  });
}

export async function writePrintSettings(db: Firestore, next: PrintSettings, original: PrintSettings) {
  const changedFields = PRINT_FIELDS.filter(key => next[key] !== original[key]);
  if (!changedFields.length) return;

  const ref = doc(db, 'museumSettings', 'print');
  await runTransaction(db, async transaction => {
    const data = (await transaction.get(ref)).data();
    const current = readPrintSettings(data);
    const changes: Partial<PrintSettings> = {};
    for (const key of changedFields) {
      if (current[key] !== original[key] && current[key] !== next[key]) {
        throw new Error('Print settings changed. Reopen Print setup to review the latest version.');
      }
      changes[key] = next[key];
    }
    if (new TextEncoder().encode(JSON.stringify({ ...data, ...changes })).byteLength > 950 * 1024) {
      throw new Error('These print settings are too large. Shorten the text or choose smaller images.');
    }
    transaction.set(ref, changes, { merge: true });
  });
}

export function firestoreMessage(error: unknown, action: string) {
  if (error instanceof FirebaseError) {
    if (error.code === 'permission-denied') return `${action} Check your account’s Firestore access.`;
    if (error.code === 'unavailable' || error.code === 'deadline-exceeded') {
      return `${action} Check your connection to Firebase and try again.`;
    }
    return `${action} ${error.message}`;
  }
  return error instanceof Error ? error.message : action;
}
