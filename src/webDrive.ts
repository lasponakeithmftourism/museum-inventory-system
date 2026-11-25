import { productName } from '../package.json';
import {
  DRIVE_SCOPE, DriveAuthorizationError, getDriveUser, listFolderAttachments,
  prepareFolder, trashRecordFolder, uploadFile,
} from '../shared/driveApi.mjs';
import type { DriveSession, DriveUpload } from '../shared/driveApi.mjs';
import type { DriveBridge, DriveConnection } from './driveAttachments';

type TokenResponse = { access_token?: string; expires_in?: string | number; scope?: string; error?: string };
type GoogleOAuth = {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    include_granted_scopes: boolean;
    prompt: '' | 'select_account';
    login_hint?: string;
    callback: (response: TokenResponse) => void;
    error_callback: (error: { type: string }) => void;
  }): { requestAccessToken(): void };
};
type BrowserSession = DriveSession & { email: string; expiresAt: number };

let oauthLoading: Promise<GoogleOAuth> | undefined;

function googleOAuth() {
  return (window as Window & { google?: { accounts?: { oauth2?: GoogleOAuth } } }).google?.accounts?.oauth2;
}

function loadGoogleOAuth() {
  const existing = googleOAuth();
  if (existing) return Promise.resolve(existing);
  if (oauthLoading) return oauthLoading;

  oauthLoading = new Promise<GoogleOAuth>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    function fail() {
      window.clearTimeout(timer);
      script.remove();
      reject(new Error('Could not load Google sign-in. Check your connection and try again.'));
    }
    const timer = window.setTimeout(fail, 15_000);
    script.onerror = fail;
    script.onload = () => {
      const oauth = googleOAuth();
      if (!oauth) return fail();
      window.clearTimeout(timer);
      resolve(oauth);
    };
    document.head.appendChild(script);
  }).catch(failure => {
    oauthLoading = undefined;
    throw failure;
  });
  return oauthLoading;
}

function requestToken(oauth: GoogleOAuth, clientId: string, loginHint: string | undefined) {
  return new Promise<{ token: string; expiresAt: number }>((resolve, reject) => {
    function fail(message: string) {
      window.clearTimeout(timer);
      reject(new Error(message));
    }
    const timer = window.setTimeout(() => fail('Google Drive sign-in timed out. Connect again to retry.'), 180_000);
    try {
      oauth.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SCOPE,
        include_granted_scopes: false,
        prompt: loginHint ? '' : 'select_account',
        login_hint: loginHint,
        callback: response => {
          const lifetime = Number(response.expires_in);
          if (response.error || !response.access_token || !response.scope?.split(/\s+/).includes(DRIVE_SCOPE) ||
              !Number.isFinite(lifetime) || lifetime <= 30) {
            return fail('Google could not authorize Drive access. Connect again and allow access to app files.');
          }
          window.clearTimeout(timer);
          resolve({ token: response.access_token, expiresAt: Date.now() + (lifetime - 30) * 1000 });
        },
        error_callback: ({ type }) => {
          fail(type === 'popup_closed'
            ? 'Google Drive sign-in was cancelled.'
            : 'Could not open Google sign-in. Allow pop-ups for this site and try again.');
        },
      }).requestAccessToken();
    } catch {
      fail('Could not start Google Drive sign-in. Try connecting again.');
    }
  });
}

function chooseBrowserFiles() {
  return new Promise<File[]>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    const finish = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => finish([]), { once: true });
    document.body.appendChild(input);
    try {
      input.click();
    } catch {
      input.remove();
      reject(new Error('Could not open the file picker. Try choosing files again.'));
    }
  });
}

export function createWebDrive(): DriveBridge | undefined {
  const clientId = import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID?.trim();
  if (!clientId || !/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) return undefined;

  const picks = new Map<string, DriveUpload & { file: File }>();
  let session: BrowserSession | undefined;
  let loginHint: string | undefined;
  let connecting: Promise<DriveConnection> | undefined;

  function activeSession() {
    if (session && session.expiresAt <= Date.now()) session = undefined;
    return session;
  }

  async function withSession<T>(action: (current: BrowserSession) => Promise<T>) {
    const current = activeSession();
    if (!current) throw new Error('Connect Google Drive to use attachments.');
    try {
      return await action(current);
    } catch (failure) {
      if (failure instanceof DriveAuthorizationError && session === current) session = undefined;
      throw failure;
    }
  }

  const connect = async () => {
    const oauth = googleOAuth() ?? await loadGoogleOAuth();
    const token = await requestToken(oauth, clientId, loginHint);
    const identity = await getDriveUser(token.token);
    session = { ...token, ...identity };
    loginHint = identity.email;
    return { email: identity.email, configured: true, expiresAt: token.expiresAt };
  };

  return {
    async status() {
      if (!activeSession()) await loadGoogleOAuth();
      const current = activeSession();
      return { email: current?.email ?? null, configured: true, expiresAt: current?.expiresAt };
    },
    connect() {
      connecting ??= connect().finally(() => { connecting = undefined; });
      return connecting;
    },
    async disconnect() {
      session = undefined;
      loginHint = undefined;
      return { email: null, configured: true };
    },
    async pick() {
      if (!activeSession()) throw new Error('Connect Google Drive before choosing attachments.');
      return (await chooseBrowserFiles()).map(file => {
        const token = crypto.randomUUID();
        picks.set(token, { name: file.name, file });
        return { token, name: file.name, size: file.size };
      });
    },
    async release(_account, tokens) {
      for (const token of tokens) picks.delete(token);
    },
    prepareFolder(account, record) {
      return withSession(({ token }) => prepareFolder(token, account.project, record, productName));
    },
    async trashFolder(account, recordId, folderId, action) {
      if (!activeSession()) await loadGoogleOAuth();
      return withSession(({ token }) => trashRecordFolder(token, account.project, recordId, folderId, action));
    },
    async upload(_account, folderId, token) {
      const pick = picks.get(token);
      if (!pick) throw new Error('Select this attachment again before uploading it.');
      await withSession(current => uploadFile(current, folderId, pick, () => pick.file));
    },
    async list(_account, folderId) {
      if (!activeSession()) return [];
      return withSession(({ token }) => listFolderAttachments(token, folderId));
    },
  };
}
