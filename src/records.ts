import { Timestamp } from 'firebase/firestore';
import { readDriveFolderId } from './driveAttachments';
import { isPrintImage } from './printImage';

export type Item = {
  inventoryId: string; itemTitle: string; description: string; itemType: string;
  creatorArtistMaker: string; dateCreatedEstimated: string; dateReceivedAssigned: string;
  acquisitionMethod: string; donorSellerSource: string; provenanceKnownHistory: string;
  ownershipLoanStatus: string; condition: string; currentLocation: string;
  supportingRecordReference: string; followUpRemarks: string; lastUpdated: string;
};

export type SavedItem = Item & { id: string; driveFolderId: string; deletionPending: boolean };
export type PrintRecordFilters = { year: string; types: string[] };

export const CATEGORY_LABELS = {
  Artifact: 'Artifacts', Artwork: 'Artworks', Book: 'Books', Costume: 'Costumes',
  'Old Photos': 'Old Photos', 'Old Documents': 'Old Documents',
};
export const TYPES = Object.keys(CATEGORY_LABELS);
export const OWNERSHIP_STATUSES = ['Owned', 'On loan', 'Borrowed', 'Pending transfer', 'Unknown'];
export const CONDITIONS = ['Excellent', 'Good', 'Fair', 'Poor', 'Needs conservation', 'Not assessed'];

export const EMPTY_ITEM: Item = {
  inventoryId: '', itemTitle: '', description: '', itemType: 'Artifact',
  creatorArtistMaker: '', dateCreatedEstimated: '', dateReceivedAssigned: '',
  acquisitionMethod: '', donorSellerSource: '', provenanceKnownHistory: '',
  ownershipLoanStatus: 'Owned', condition: '', currentLocation: '',
  supportingRecordReference: '', followUpRemarks: '', lastUpdated: '',
};

export const FIELD_LABELS: Record<keyof Item, string> = {
  inventoryId: 'Inventory ID', itemTitle: 'Item Title', description: 'Description',
  itemType: 'Item Type', creatorArtistMaker: 'Creator / Artist / Maker',
  dateCreatedEstimated: 'Date Created / Estimated', dateReceivedAssigned: 'Date Received / Assigned',
  acquisitionMethod: 'Acquisition Method', donorSellerSource: 'Donor / Seller / Source',
  provenanceKnownHistory: 'Provenance / Known History', ownershipLoanStatus: 'Ownership / Loan Status',
  condition: 'Condition', currentLocation: 'Current Location',
  supportingRecordReference: 'Supporting Record Reference', followUpRemarks: 'Follow-up / Remarks',
  lastUpdated: 'Last Updated',
};

export const ITEM_FIELDS = Object.keys(FIELD_LABELS) as (keyof Item)[];

export function readItem(id: string, data: Record<string, unknown>): SavedItem {
  const item = {
    ...EMPTY_ITEM, id, driveFolderId: readDriveFolderId(data.driveFolderId),
    deletionPending: data.deletionPending === true,
  };
  for (const key of ITEM_FIELDS) {
    const value = data[key];
    if (typeof value === 'string') item[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) item[key] = String(value);
    else item[key] = '';
  }
  item.inventoryId = item.inventoryId.trim() ? item.inventoryId : id;
  item.itemType = item.itemType.trim() || 'Uncategorized';
  item.ownershipLoanStatus = item.ownershipLoanStatus.trim() || 'Unknown';
  if (data.dateReceivedAssigned instanceof Timestamp) {
    item.dateReceivedAssigned = data.dateReceivedAssigned.toDate().toISOString().slice(0, 10);
  }
  const updated = data.lastUpdated;
  const date = updated instanceof Timestamp ? updated.toDate() : new Date(item.lastUpdated);
  item.lastUpdated = Number.isNaN(date.getTime()) ? '' : date.toISOString();
  return item;
}

export function recordInventoryYear(item: Pick<SavedItem, 'inventoryId' | 'id' | 'dateReceivedAssigned'>): string {
  const idPattern = /(?:^|-)(\d{4})-\d+$/;
  const inventoryId = idPattern.exec(item.inventoryId.trim()) ?? idPattern.exec(item.id.trim());
  if (inventoryId) return inventoryId[1];

  const receivedYears = item.dateReceivedAssigned.match(/\b\d{4}\b/g);
  return receivedYears?.length === 1 ? receivedYears[0] : '';
}

const INVENTORY_ID_ORDER = new Intl.Collator('en-PH', { numeric: true });

export function compareInventoryIds(a: Item, b: Item) {
  return INVENTORY_ID_ORDER.compare(a.inventoryId.trim(), b.inventoryId.trim());
}

export function inventoryYears(items: SavedItem[]) {
  return [...new Set(items.map(recordInventoryYear).filter(Boolean))].sort((a, b) => b.localeCompare(a));
}

export function matchesInventoryFilters(item: SavedItem, { year, types }: PrintRecordFilters) {
  return (!year || recordInventoryYear(item) === year) && (!types.length || types.includes(item.itemType));
}

export function conditionTone(condition: string) {
  if (/poor|repair|damaged|needs/i.test(condition)) return 'bad';
  if (!condition.trim() || /fair|unknown|not recorded|not assessed/i.test(condition)) return 'warn';
  return 'good';
}

export type PrintSettings = {
  headerText: string; footerText: string;
  headerImage: string; footerImage: string;
  preparedByName: string; preparedByTitle: string;
  reviewedByName: string; reviewedByTitle: string;
  approvedByName: string; approvedByTitle: string;
};

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  headerText: 'REPUBLIC OF THE PHILIPPINES\nPROVINCE OF BUKIDNON\nMUNICIPALITY OF MANOLO FORTICH\nMUNICIPAL TOURISM OFFICE',
  footerText: 'Municipal Museum · Collections Register',
  headerImage: '', footerImage: '',
  preparedByName: '', preparedByTitle: '', reviewedByName: '', reviewedByTitle: '',
  approvedByName: '', approvedByTitle: '',
};

export const PRINT_FIELDS = Object.keys(DEFAULT_PRINT_SETTINGS) as (keyof PrintSettings)[];

export function readPrintSettings(data: Record<string, unknown> = {}): PrintSettings {
  const settings = { ...DEFAULT_PRINT_SETTINGS };
  for (const key of PRINT_FIELDS) {
    const value = data[key];
    if (typeof value === 'string') settings[key] = value;
  }
  if (!isPrintImage(settings.headerImage)) settings.headerImage = '';
  if (!isPrintImage(settings.footerImage)) settings.footerImage = '';
  return settings;
}

export function recordsCsv(items: SavedItem[]): string {
  function quote(value: string) {
    const text = /^[\t\r\n]|^\s*[=+@＝＋－＠-]/u.test(value) ? `'${value}` : value;
    return `"${text.replace(/"/g, '""')}"`;
  }

  const rows = items.map(item => ITEM_FIELDS.map(field => quote(item[field])).join(','));
  const headers = ITEM_FIELDS.map(field => quote(FIELD_LABELS[field])).join(',');
  return '\ufeff' + [headers, ...rows].join('\r\n');
}
