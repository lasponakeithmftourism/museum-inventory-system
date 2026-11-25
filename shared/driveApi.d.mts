export const DRIVE_SCOPE: string;

export type DriveAttachment = { id: string; name: string; size?: string; mimeType?: string };
export type DriveRecord = { id: string; inventoryId: string; year: string };
export type DriveUpload = {
  name: string;
  transfer?: { id: string; folderId: string; accountId: string };
};
export type DriveSession = { token: string; accountId: string };

export class DriveAuthorizationError extends Error {}
export function validDriveId(value: unknown): value is string;
export function googleFetch(url: string | URL, options?: RequestInit, timeout?: number): Promise<Response>;
export function getDriveUser(token: string): Promise<{ email: string; accountId: string }>;
export function prepareFolder(token: string, project: string, record: DriveRecord, rootName: string): Promise<string>;
export function trashRecordFolder(token: string, project: string, recordId: string, folderId: string, action: 'check' | 'trash'): Promise<void>;
export function uploadFile(session: DriveSession, folderId: string, picked: DriveUpload, readBlob: () => Blob | Promise<Blob>): Promise<void>;
export function listFolderAttachments(token: string, folderId: string): Promise<DriveAttachment[]>;
