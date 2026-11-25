export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export class DriveAuthorizationError extends Error {}

export async function googleFetch(url, options = {}, timeout = 30_000) {
  try {
    return await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
  } catch {
    throw new Error('Could not reach Google Drive. Check your internet connection and try again.');
  }
}

const GOOGLE_API = 'https://www.googleapis.com';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id, name, size, mimeType';
export const validDriveId = value => typeof value === 'string' && /^[\w-]{1,200}$/.test(value);
const validRecordId = value => typeof value === 'string' && value.length > 0 && value.length <= 1500;
const recordFolderKey = (project, recordId) => `record:${project}:${recordId}`;

async function checkResponse(response) {
  if (response.ok) return;
  const data = await response.json().catch(() => ({}));
  const reason = data.error?.errors?.[0]?.reason;
  if (reason === 'storageQuotaExceeded') throw new Error('The connected Google Drive is full. Free some space and retry.');
  if (response.status === 401) throw new DriveAuthorizationError('Google Drive sign-in expired. Connect your account again.');
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
  const tag = await hashKey(key);
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

export async function prepareFolder(token, project, record, rootName) {
  if (!record || !validRecordId(record.id) ||
    typeof record.inventoryId !== 'string' || !record.inventoryId.trim() || record.inventoryId.length > 1500 ||
    !/^(\d{4}|Undated)$/.test(record.year)) throw new Error('This collection record has an invalid inventory ID.');

  const root = await ensureFolder(token, 'root', rootName, `root:${project}`);
  const year = await ensureFolder(token, root, record.year, `year:${project}:${record.year}`);
  return ensureFolder(token, year, record.inventoryId.trim().replace(/[\\/]/g, '-').slice(0, 200), recordFolderKey(project, record.id));
}

async function readFolder(token, folderId) {
  if (!validDriveId(folderId)) throw new Error('The record does not have a valid Google Drive folder.');
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

export async function trashRecordFolder(token, project, recordId, folderId, action) {
  if (!validRecordId(recordId) || !['check', 'trash'].includes(action)) {
    throw new Error('Select the collection record to delete.');
  }
  const folder = await readFolder(token, folderId);
  if (folder.appProperties?.museumDesk !== await hashKey(recordFolderKey(project, recordId))) {
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

export async function uploadFile(session, folderId, picked, readBlob) {
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
    blob = await readBlob();
  } catch {
    throw new Error(`Could not read “${picked.name}”. Select the file again.`);
  }
  const metadata = { id: picked.transfer.id, name: picked.name, parents: [folderId] };
  const endpoint = '/upload/drive/v3/files';
  if (blob.size === 0) {
    const boundary = crypto.randomUUID();
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
  let uploadUrl;
  try {
    uploadUrl = new URL(start.headers.get('Location'));
  } catch {
    throw new Error('Google Drive did not return an upload session. Retry the attachment.');
  }
  if (uploadUrl.origin !== GOOGLE_API || uploadUrl.pathname !== endpoint) {
    throw new Error('Google Drive did not return an upload session. Retry the attachment.');
  }
  const sent = await googleFetch(uploadUrl, {
    method: 'PUT',
    body: blob,
  }, 30 * 60_000);
  await checkResponse(sent);
}

async function hashKey(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function getDriveUser(token) {
  const response = await requestDrive(token, '/drive/v3/about', { fields: 'user(emailAddress,permissionId)' });
  if (!response.ok) throw new Error('Could not open Google Drive. Check that the Google Drive API is enabled in your Google Cloud project.');
  const { user } = await response.json();
  if (!user?.emailAddress || !user?.permissionId) throw new Error('Google Drive did not return the connected account.');
  return { email: user.emailAddress, accountId: user.permissionId };
}

export async function listFolderAttachments(token, folderId) {
  await openFolder(token, folderId);
  return listFiles(token, `'${folderId}' in parents and mimeType != '${FOLDER_MIME}'`, FILE_FIELDS);
}
