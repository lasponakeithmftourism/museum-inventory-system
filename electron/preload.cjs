const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('museumPrinting', {
  createPreview: () => ipcRenderer.invoke('museum:print-preview'),
  print: (geometry, options) => ipcRenderer.invoke('museum:print', geometry, options),
});

contextBridge.exposeInMainWorld('museumDrive', {
  status: account => ipcRenderer.invoke('museum:drive-status', account),
  connect: account => ipcRenderer.invoke('museum:drive-connect', account),
  disconnect: account => ipcRenderer.invoke('museum:drive-disconnect', account),
  pick: account => ipcRenderer.invoke('museum:drive-pick', account),
  release: (account, tokens) => ipcRenderer.invoke('museum:drive-release', account, tokens),
  prepareFolder: (account, record) => ipcRenderer.invoke('museum:drive-folder', account, record),
  trashFolder: (account, recordId, folderId, action) => ipcRenderer.invoke('museum:drive-trash-folder', account, recordId, folderId, action),
  upload: (account, folderId, token) => ipcRenderer.invoke('museum:drive-upload', account, folderId, token),
  list: (account, folderId) => ipcRenderer.invoke('museum:drive-list', account, folderId),
});
