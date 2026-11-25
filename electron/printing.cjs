const { ipcMain } = require('electron');

function printOptions(geometry) {
  const { width, height, landscape, margins } = geometry ?? {};
  const validSize = value => Number.isFinite(value) && value >= 100 && value <= 500;
  const validMargin = value => Number.isFinite(value) && value >= 0;
  const paperWidth = landscape ? height : width;
  const paperHeight = landscape ? width : height;
  if (!validSize(width) || !validSize(height) || typeof landscape !== 'boolean' || !margins
      || ['top', 'right', 'bottom', 'left'].some(side => !validMargin(margins[side]))
      || margins.left + margins.right >= paperWidth || margins.top + margins.bottom >= paperHeight) {
    throw new Error('The margins must fit on the selected paper.');
  }

  const pixels = millimetres => Math.round(millimetres * 96 / 25.4);
  return {
    silent: false,
    printBackground: true,
    pageSize: { width: Math.round(width * 1000), height: Math.round(height * 1000) },
    landscape,
    margins: {
      marginType: 'custom',
      top: pixels(margins.top), right: pixels(margins.right),
      bottom: pixels(margins.bottom), left: pixels(margins.left),
    },
  };
}

function registerPrintHandlers(appUrl) {
  function registerWindow(event) {
    if (event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== appUrl) {
      throw new Error('Printing is available from the collection register window.');
    }
    return event.sender;
  }

  ipcMain.handle('museum:print-preview', async event => {
    const contents = registerWindow(event);
    const pdf = await contents.printToPDF({ preferCSSPageSize: true, printBackground: true });
    return Uint8Array.from(pdf).buffer;
  });

  ipcMain.handle('museum:print', (event, geometry, request) => {
    const contents = registerWindow(event);
    const options = printOptions(geometry);
    if (request?.actualSize === true) options.scaleFactor = 100;
    return new Promise(resolve => {
      contents.print(options, (success, reason) => resolve({ success, reason }));
    });
  });
}

module.exports = { registerPrintHandlers };
