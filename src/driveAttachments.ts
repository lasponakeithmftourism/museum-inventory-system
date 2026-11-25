import { validDriveId } from '../shared/driveApi.mjs';
import type { DriveAttachment, DriveRecord } from '../shared/driveApi.mjs';

export type DriveAccount = { project: string; uid: string };
export type DriveConnection = { email: string | null; configured: boolean };
export type LocalAttachment = { token: string; name: string; size: number };
export type { DriveAttachment, DriveRecord };

export interface DriveBridge {
  status(account: DriveAccount): Promise<DriveConnection>;
  connect(account: DriveAccount): Promise<DriveConnection>;
  disconnect(account: DriveAccount): Promise<DriveConnection>;
  pick(account: DriveAccount): Promise<LocalAttachment[]>;
  release(account: DriveAccount, tokens: string[]): Promise<void>;
  prepareFolder(account: DriveAccount, record: DriveRecord): Promise<string>;
  trashFolder(account: DriveAccount, recordId: string, folderId: string, action: 'check' | 'trash'): Promise<void>;
  upload(account: DriveAccount, folderId: string, token: string): Promise<void>;
  list(account: DriveAccount, folderId: string): Promise<DriveAttachment[]>;
}

export function readDriveFolderId(value: unknown) {
  return validDriveId(value) ? value : '';
}

export function driveFailure(error: unknown, fallback: string) {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
    : fallback;
}
