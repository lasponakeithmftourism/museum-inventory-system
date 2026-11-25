const { BrowserWindow, dialog, ipcMain } = require('electron');
const { randomUUID } = require('node:crypto');
const { openAsBlob } = require('node:fs');
const { stat } = require('node:fs/promises');
const path = require('node:path');
const { productName } = require('../package.json');
const { hash, googleFetch, driveStatus, connectDrive, disconnectDrive, driveSession } = require('./driveAuth.cjs');

const GOOGLE_API = 'https://www.googleapis.com';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id, name, size, mimeType';
const validId = value => typeof value === 'string' && /^[\w-]{1,200}$/.test(value);
const validRecordId = value => typeof value === 'string' && value.length > 0 && value.length <= 1500;
const recordFolderKey = (project, recordId) => `record:${project}:${recordId}`;

async function checkResponse(response) {
  if (response.ok) return;
  const data = await response.json().catch(() => ({}));
  const reason = data.error?.errors?.[0]?.reason;
  if (reason === 'storageQuotaExceeded') throw new Error('The connected Google Drive is full. Free some space and retry.');
  if (response.status === 401) throw new Error('Google Drive sign-in expired. Connect your account again.');
  if (response.status === 404 || response.status === 403) {
    throw new Error('Google Drive could not access this folder or file. Check that the connected account has access.');
  }
  throw new Error(`Google Drive returned an error (${response.status}). Try again.`);
}

async function requestDrive(token, endpoint, parameters = {}, options = {}) {
  const url = new URL(endpoint, GOOGLE_API);
  url.search = new URLSearchParams(parameters).toString();
  return googleFetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  });
}

async function listFiles(token, filter, fields) {
  const files = [];
  let pageToken;
  do {
    const response = await requestDrive(token, '/drive/v3/files', {
      q: `trashed = false and ${filter}`, fields: `nextPageToken,files(${fields})`,
      orderBy: 'createdTime', spaces: 'drive', pageSize: '100',
      ...(pageToken && { pageToken }),
    });
    await checkResponse(response);
    const page = await response.json();
    files.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return files;
}

async function ensureFolder(token, parent, name, key) {
  const tag = hash(key);
  const [existing] = await listFiles(token,
    `'${parent}' in parents and mimeType = '${FOLDER_MIME}' and appProperties has { key='museumDesk' and value='${tag}' }`, 'id');
  if (existing) return existing.id;

  const response = await requestDrive(token, '/drive/v3/files', { fields: 'id' }, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent], appProperties: { museumDesk: tag } }),
  });
  await checkResponse(response);
  return (await response.json()).id;
}

async function prepareFolder(token, project, record) {
  if (!record || !validRecordId(record.id) ||
    typeof record.inventoryId !== 'string' || !record.inventoryId.trim() || record.inventoryId.length > 1500 ||
    !/^(\d{4}|Undated)$/.test(record.year)) throw new Error('This collection record has an invalid inventory ID.');

  const root = await ensureFolder(token, 'root', productName, `root:${project}`);
  const year = await ensureFolder(token, root, record.year, `year:${project}:${record.year}`);
  return ensureFolder(token, year, record.inventoryId.trim().replace(/[\\/]/g, '-').slice(0, 200), recordFolderKey(project, record.id));
}

async function readFolder(token, folderId) {
  if (!validId(folderId)) throw new Error('The record does not have a valid Google Drive folder.');
  const response = await requestDrive(token, `/drive/v3/files/${folderId}`, {
    fields: 'mimeType,trashed,explicitlyTrashed,appProperties,capabilities(canAddChildren,canTrash)',
    supportsAllDrives: 'true',
  });
  await checkResponse(response);
  const folder = await response.json();
  if (folder.mimeType !== FOLDER_MIME) throw new Error('The record’s Google Drive folder is unavailable.');
  return folder;
}

async function openFolder(token, folderId) {
  const folder = await readFolder(token, folderId);
  if (folder.trashed) throw new Error('The record’s Google Drive folder is in Trash.');
  return folder;
}

async function trashRecordFolder(token, project, recordId, folderId, action) {
  if (!validRecordId(recordId) || !['check', 'trash'].includes(action)) {
    throw new Error('Select the collection record to delete.');
  }
  const folder = await readFolder(token, folderId);
  if (folder.appProperties?.museumDesk !== hash(recordFolderKey(project, recordId))) {
    throw new Error('Google Drive could not verify that this folder belongs to the selected record.');
  }
  if (folder.explicitlyTrashed === true) return;
  if (!folder.capabilities?.canTrash) {
    throw new Error('Connect a Google account with permission to move this record’s folder to Trash.');
  }
  if (action === 'check') return;

  const response = await requestDrive(token, `/drive/v3/files/${folderId}`, {
    fields: 'explicitlyTrashed', supportsAllDrives: 'true',
  }, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
  await checkResponse(response);
  if ((await response.json()).explicitlyTrashed !== true) {
    throw new Error('Google Drive could not confirm the folder was moved to Trash. Try again.');
  }
}

async function generateFileId(token) {
  const response = await requestDrive(token, '/drive/v3/files/generateIds', { count: '1', space: 'drive' });
  await checkResponse(response);
  return (await response.json()).ids[0];
}

async function alreadyUploaded(token, id, folderId) {
  const response = await requestDrive(token, `/drive/v3/files/${id}`, { fields: 'id,trashed,parents' });
  if (response.status === 404) return false;
  await checkResponse(response);
  const file = await response.json();
  if (file.trashed || !file.parents?.includes(folderId)) {
    throw new Error('This upload was moved or trashed in Google Drive. Select the file again to upload a new copy.');
  }
  return true;
}

async function uploadFile(session, folderId, picked) {
  const { token, accountId } = session;
  const folder = await openFolder(token, folderId);
  if (!folder.capabilities?.canAddChildren) throw new Error('The connected Google account can’t add files to this record’s Drive folder.');
  if (picked.transfer) {
    if (picked.transfer.accountId !== accountId || picked.transfer.folderId !== folderId) {
      throw new Error('Reconnect the original Google Drive account or select the file again.');
    }
    if (await alreadyUploaded(token, picked.transfer.id, folderId)) return;
  } else {
    picked.transfer = { id: await generateFileId(token), folderId, accountId };
  }

  let blob;
  try {
    blob = await openAsBlob(picked.path);
  } catch {
    throw new Error(`Could not read “${picked.name}”. Select the file again.`);
  }
  const metadata = { id: picked.transfer.id, name: picked.name, parents: [folderId] };
  const endpoint = '/upload/drive/v3/files';
  if (blob.size === 0) {
    const boundary = randomUUID();
    const response = await requestDrive(token, endpoint, { uploadType: 'multipart', fields: 'id' }, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--${boundary}--\r\n`,
    });
    await checkResponse(response);
    return;
  }

  const start = await requestDrive(token, endpoint, { uploadType: 'resumable', fields: 'id' }, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(blob.size) },
    body: JSON.stringify(metadata),
  });
  await checkResponse(start);
  const uploadUrl = URL.parse(start.headers.get('Location') ?? '');
  if (uploadUrl?.origin !== GOOGLE_API || uploadUrl.pathname !== endpoint) {
    throw new Error('Google Drive did not return an upload session. Retry the attachment.');
  }
  const sent = await googleFetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Length': String(blob.size) },
    body: blob,
  }, 30 * 60_000);
  await checkResponse(sent);
}

function registerDriveHandlers(appUrl) {
  const pickedByWindow = new WeakMap();
  const queues = new Map();

  function handle(name, task, serial = true) {
    ipcMain.handle(`museum:drive-${name}`, async (event, identity, ...args) => {
      if (event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== appUrl) {
        throw new Error('Drive attachments are available from the collection register window.');
      }
      if (!identity || typeof identity.uid !== 'string' || !identity.uid || identity.uid.length > 128 ||
        !validId(identity.project)) throw new Error('Sign in to the collection register to use Google Drive.');

      const window = BrowserWindow.fromWebContents(event.sender);
      const profile = hash(JSON.stringify([identity.project, identity.uid]));
      if (!pickedByWindow.has(window)) pickedByWindow.set(window, new Map());
      const picks = pickedByWindow.get(window);
      const invoke = () => task({ window, profile, project: identity.project, picks }, ...args);
      if (!serial) return invoke();
      const running = (queues.get(profile) ?? Promise.resolve()).catch(() => {}).then(invoke);
      queues.set(profile, running);
      try {
        return await running;
      } finally {
        if (queues.get(profile) === running) queues.delete(profile);
      }
    });
  }

  handle('status', ({ profile }) => driveStatus(profile), false);
  handle('connect', ({ window, profile }) => connectDrive(window, profile));
  handle('disconnect', ({ profile }) => disconnectDrive(profile));
  handle('pick', async ({ window, profile, picks }) => {
    if (!(await driveStatus(profile)).email) throw new Error('Connect Google Drive before choosing attachments.');
    const { filePaths } = await dialog.showOpenDialog(window, {
      title: 'Choose photos or attachments', properties: ['openFile', 'multiSelections'],
    });
    const prior = new Set([...picks.values()].filter(pick => pick.profile === profile).map(pick => pick.path));
    const chosen = await Promise.all(filePaths.filter(file => !prior.has(file)).map(async file => {
      const info = await stat(file);
      const name = path.basename(file);
      if (!info.isFile()) throw new Error(`“${name}” is not a file.`);
      return { token: randomUUID(), name, size: info.size, path: file, profile };
    }));
    for (const file of chosen) picks.set(file.token, file);
    return chosen.map(({ token, name, size }) => ({ token, name, size }));
  });
  handle('release', ({ profile, picks }, tokens) => {
    if (!Array.isArray(tokens)) return;
    for (const token of tokens) if (picks.get(token)?.profile === profile) picks.delete(token);
  }, false);
  handle('folder', async ({ profile, project }, record) => {
    return prepareFolder((await driveSession(profile)).token, project, record);
  });
  handle('trash-folder', async ({ profile, project }, recordId, folderId, action) => {
    await trashRecordFolder((await driveSession(profile)).token, project, recordId, folderId, action);
  });
  handle('upload', async ({ profile, picks }, folderId, token) => {
    const file = picks.get(token);
    if (file?.profile !== profile) throw new Error('Select this attachment again before uploading it.');
    await uploadFile(await driveSession(profile), folderId, file);
  });
  handle('list', async ({ profile }, folderId) => {
    if (!(await driveStatus(profile)).email) return [];
    const { token } = await driveSession(profile);
    await openFolder(token, folderId);
    return listFiles(token, `'${folderId}' in parents and mimeType != '${FOLDER_MIME}'`, FILE_FIELDS);
  });
}

module.exports = { registerDriveHandlers };
