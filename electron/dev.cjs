const { spawn } = require('node:child_process');
const { resolve } = require('node:path');
const electron = require('electron');
const { productName } = require('../package.json');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const desktop = spawn(electron, [resolve(__dirname, '..')], { env, stdio: 'inherit' });
desktop.once('error', error => {
  console.error('Could not start ' + productName + ':', error.message);
  process.exitCode = 1;
});
desktop.once('exit', code => {
  process.exitCode = code ?? 1;
});
