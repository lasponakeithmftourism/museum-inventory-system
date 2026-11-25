const { app, dialog, safeStorage, shell } = require('electron');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { readFile, rename, rm, stat, writeFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { parseEnv } = require('node:util');
const path = require('node:path');
const { productName } = require('../package.json');

const { DRIVE_SCOPE, googleFetch, getDriveUser } = require('../shared/driveApi.mjs');
const accessTokens = new Map();

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function credentialsPath(profile) {
  return path.join(app.getPath('userData'), `drive-${profile}.bin`);
}

async function readCredentials(profile) {
  try {
    const protectedData = await readFile(credentialsPath(profile));
    const { result } = await safeStorage.decryptStringAsync(protectedData);
    return JSON.parse(result);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('The saved Google Drive connection could not be opened. Disconnect it and connect again.');
  }
}

async function saveCredentials(profile, credentials) {
  const target = credentialsPath(profile);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const protectedData = await safeStorage.encryptStringAsync(JSON.stringify(credentials));
  try {
    await writeFile(temporary, protectedData, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readDesktopClient(file) {
  const info = await stat(file);
  if (!info.isFile() || info.size > 64 * 1024) throw new Error('Invalid Desktop OAuth JSON.');
  const { installed } = JSON.parse(await readFile(file, 'utf8'));
  if (typeof installed?.client_id !== 'string' ||
      !/^[\w-]+\.apps\.googleusercontent\.com$/.test(installed.client_id)) throw new Error('Invalid Desktop OAuth client.');
  return {
    client_id: installed.client_id,
    ...(typeof installed.client_secret === 'string' && { client_secret: installed.client_secret }),
  };
}

async function configuredClient() {
  try {
    let file = process.env.GOOGLE_DRIVE_DESKTOP_CLIENT_FILE?.trim();
    if (!file && !app.isPackaged) {
      const env = parseEnv(await readFile(path.join(app.getAppPath(), '.env.local'), 'utf8'));
      file = env.GOOGLE_DRIVE_DESKTOP_CLIENT_FILE?.trim();
    }
    return file ? await readDesktopClient(path.resolve(app.getAppPath(), file)) : null;
  } catch {
    return null;
  }
}

async function chooseClient(window) {
  const { filePaths } = await dialog.showOpenDialog(window, {
    title: 'Select the Google OAuth Desktop app JSON',
    properties: ['openFile'],
    filters: [{ name: 'Google OAuth client JSON', extensions: ['json'] }],
  });
  if (!filePaths.length) return null;
  try {
    return await readDesktopClient(filePaths[0]);
  } catch {
    throw new Error('Select the JSON for a Desktop app OAuth client from Google Cloud.');
  }
}

async function browserAuthorization(window, client) {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const redirect = `http://127.0.0.1:${server.address().port}/`;
  const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorization.search = new URLSearchParams({
    client_id: client.client_id, redirect_uri: redirect, response_type: 'code',
    scope: DRIVE_SCOPE, access_type: 'offline', prompt: 'consent select_account',
    state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  let timer;
  let cancel;
  try {
    const callback = new Promise((resolve, reject) => {
      cancel = () => reject(new Error('Google Drive sign-in was cancelled.'));
      window.once('closed', cancel);
      timer = setTimeout(() => reject(new Error('Google Drive sign-in timed out. Connect again to retry.')), 180_000);
      server.on('request', (request, response) => {
        const url = URL.parse(request.url, redirect);
        if (request.method !== 'GET' || url?.origin !== new URL(redirect).origin ||
          url.pathname !== '/' || url.searchParams.get('state') !== state) {
          response.writeHead(400).end('This Google Drive sign-in response is invalid.');
          return;
        }
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end('Return to ' + productName + ' to finish connecting Google Drive.');
        const code = url.searchParams.get('code');
        if (code && !url.searchParams.has('error')) resolve(code);
        else cancel();
      });
    });
    const [code] = await Promise.all([callback, shell.openExternal(authorization.href)]);
    return { code, redirect_uri: redirect, code_verifier: verifier, grant_type: 'authorization_code' };
  } finally {
    clearTimeout(timer);
    window.removeListener('closed', cancel);
    server.close();
  }
}

async function exchangeToken(client, parameters) {
  const response = await googleFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ ...client, ...parameters }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.access_token !== 'string') {
    const error = new Error(data.error === 'invalid_grant'
      ? 'Google Drive sign-in expired. Connect your account again.'
      : 'Google could not authorize Drive access. Check the OAuth Desktop app in Google Cloud.');
    error.code = data.error;
    throw error;
  }
  return data;
}

function rememberAccessToken(profile, refreshToken, tokens) {
  accessTokens.set(profile, {
    value: tokens.access_token, refreshToken,
    expires: Date.now() + (tokens.expires_in || 0) * 1000 - 30_000,
  });
}

async function driveStatus(profile) {
  const saved = await readCredentials(profile);
  return { email: saved?.refreshToken ? saved.email : null, configured: Boolean(saved?.client ?? await configuredClient()) };
}

async function connectDrive(window, profile) {
  const saved = await readCredentials(profile);
  const client = saved?.client ?? await configuredClient() ?? await chooseClient(window);
  if (!client) return { email: null, configured: false };
  if (!await safeStorage.isAsyncEncryptionAvailable() ||
    (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('The system credential store is unavailable. Google Drive could not be connected.');
  }
  if (!saved?.client) await saveCredentials(profile, { client });
  const tokens = await exchangeToken(client, await browserAuthorization(window, client));
  if (!tokens.refresh_token || !tokens.scope?.split(' ').includes(DRIVE_SCOPE)) {
    throw new Error('Google did not grant ongoing Drive access. Connect again and allow access to files created by the app.');
  }
  const account = await getDriveUser(tokens.access_token);
  await saveCredentials(profile, { client, refreshToken: tokens.refresh_token, ...account });
  rememberAccessToken(profile, tokens.refresh_token, tokens);
  return { email: account.email, configured: true };
}

async function disconnectDrive(profile) {
  const saved = await readCredentials(profile).catch(() => null);
  accessTokens.delete(profile);
  if (saved?.client) await saveCredentials(profile, { client: saved.client });
  else await rm(credentialsPath(profile), { force: true });
  return { email: null, configured: Boolean(saved?.client ?? await configuredClient()) };
}

async function driveSession(profile) {
  const saved = await readCredentials(profile);
  if (!saved?.refreshToken) throw new Error('Connect your Google Drive account to upload files.');
  const cached = accessTokens.get(profile);
  if (cached?.refreshToken === saved.refreshToken && cached.expires > Date.now()) {
    return { token: cached.value, accountId: saved.accountId };
  }
  try {
    const tokens = await exchangeToken(saved.client, { grant_type: 'refresh_token', refresh_token: saved.refreshToken });
    rememberAccessToken(profile, saved.refreshToken, tokens);
    return { token: tokens.access_token, accountId: saved.accountId };
  } catch (error) {
    if (error.code === 'invalid_grant') await saveCredentials(profile, { client: saved.client });
    throw error;
  }
}

module.exports = { hash, googleFetch, driveStatus, connectDrive, disconnectDrive, driveSession };
