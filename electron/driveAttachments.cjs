const { BrowserWindow, dialog, ipcMain } = require('electron');
const { randomUUID } = require('node:crypto');
const { openAsBlob } = require('node:fs');
const { stat } = require('node:fs/promises');
const path = require('node:path');
const { productName } = require('../package.json');
const { hash, driveStatus, connectDrive, disconnectDrive, driveSession } = require('./driveAuth.cjs');
const { validDriveId, prepareFolder, trashRecordFolder, uploadFile, listFolderAttachments } = require('../shared/driveApi.mjs');

function registerDriveHandlers(appUrl) {
  const pickedByWindow = new WeakMap();
  const queues = new Map();

  function handle(name, task, serial = true) {
    ipcMain.handle(`museum:drive-${name}`, async (event, identity, ...args) => {
      if (event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== appUrl) {
        throw new Error('Drive attachments are available from the collection register window.');
      }
      if (!identity || typeof identity.uid !== 'string' || !identity.uid || identity.uid.length > 128 ||
        !validDriveId(identity.project)) throw new Error('Sign in to the collection register to use Google Drive.');

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
    return prepareFolder((await driveSession(profile)).token, project, record, productName);
  });
  handle('trash-folder', async ({ profile, project }, recordId, folderId, action) => {
    await trashRecordFolder((await driveSession(profile)).token, project, recordId, folderId, action);
  });
  handle('upload', async ({ profile, picks }, folderId, token) => {
    const file = picks.get(token);
    if (file?.profile !== profile) throw new Error('Select this attachment again before uploading it.');
    await uploadFile(await driveSession(profile), folderId, file, () => openAsBlob(file.path));
  });
  handle('list', async ({ profile }, folderId) => {
    if (!(await driveStatus(profile)).email) return [];
    const { token } = await driveSession(profile);
    return listFolderAttachments(token, folderId);
  });
}

module.exports = { registerDriveHandlers };
