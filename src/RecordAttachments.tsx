import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, FileText, FolderOpen, LoaderCircle, Paperclip, X } from 'lucide-react';
import { driveFailure } from './driveAttachments';
import type { DriveAccount, DriveAttachment, DriveConnection, LocalAttachment } from './driveAttachments';

export function useRecordAttachments(account: DriveAccount) {
  const drive = window.museumDrive;
  const [connection, setConnection] = useState<DriveConnection>({ email: null, configured: false });
  const [checking, setChecking] = useState(Boolean(drive));
  const [activity, setActivity] = useState('');
  const [error, setError] = useState('');
  const [files, setFiles] = useState<LocalAttachment[]>([]);
  const handles = useRef(new Set<string>());

  useEffect(() => {
    if (!drive) return;
    let active = true;
    const tokens = handles.current;
    drive.status(account).then(status => {
      if (active) setConnection(status);
    }).catch(failure => {
      if (active) setError(driveFailure(failure, 'Could not check the Google Drive connection.'));
    }).finally(() => { if (active) setChecking(false); });
    return () => {
      active = false;
      void drive.release(account, [...tokens]).catch(() => {});
      tokens.clear();
    };
  }, [drive, account]);

  async function run(message: string, action: () => Promise<void>) {
    if (activity) return;
    setActivity(message);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(driveFailure(failure, 'Could not use Google Drive.'));
    } finally {
      setActivity('');
    }
  }

  function connect() {
    if (drive) return run('Connecting to Google Drive…', async () => setConnection(await drive.connect(account)));
  }

  function disconnect() {
    if (drive) return run('Disconnecting Google Drive…', async () => setConnection(await drive.disconnect(account)));
  }

  function choose() {
    if (drive) return run('Choosing files…', async () => {
      const chosen = await drive.pick(account);
      for (const file of chosen) handles.current.add(file.token);
      setFiles(previous => [...previous, ...chosen]);
    });
  }

  function remove(token: string) {
    handles.current.delete(token);
    setFiles(previous => previous.filter(file => file.token !== token));
    void drive?.release(account, [token]).catch(() => {});
  }

  async function upload(folderId: string, onUploaded: () => void) {
    if (!drive) throw new Error('Open the desktop app to upload attachments.');
    try {
      for (const file of files) {
        setActivity(`Uploading ${file.name}…`);
        await drive.upload(account, folderId, file.token);
        remove(file.token);
        onUploaded();
      }
    } finally {
      setActivity('');
    }
  }

  async function refreshConnection() {
    if (drive) await drive.status(account).then(setConnection).catch(() => {});
  }

  return { drive, connection, checking, activity, error, files, connect, disconnect, choose, remove, upload, refreshConnection };
}

function fileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
}

export function AttachmentEditor({ attachments, folderId }: {
  attachments: ReturnType<typeof useRecordAttachments>;
  folderId: string;
}) {
  const { drive, connection, checking, activity, error, files, connect, disconnect, choose, remove } = attachments;
  return <section className="attachment-editor" aria-labelledby="attachments-title">
    <div className="attachment-heading">
      <h3 id="attachments-title"><Paperclip size={15}/> Photos &amp; attachments</h3>
      {connection.email && <button className="button button-light" type="button" onClick={choose} disabled={!!activity}>
        <Paperclip size={14}/> Add files
      </button>}
    </div>
    {!drive && <p>Open the desktop app to upload to Google Drive.</p>}
    {drive && checking && <p role="status">Checking Google Drive connection…</p>}
    {drive && !checking && (connection.email ? <div className="attachment-account">
      <span>Google Drive · {connection.email}</span>
      <button className="attachment-action" type="button" onClick={disconnect} disabled={!!activity}>Disconnect</button>
    </div> : <div className="attachment-connect">
      <p>Connect Google Drive to upload files when you save this record.</p>
      <button className="button button-light" type="button" onClick={connect} disabled={!!activity}>Connect Google Drive</button>
      {!connection.configured && <details>
        <summary>First-time Google Drive setup</summary>
        <p>Enable the Google Drive API in Google Cloud, configure OAuth consent, and create a Desktop app OAuth client. Download its JSON and select it when connecting.</p>
        <a href="https://developers.google.com/workspace/guides/create-credentials#desktop-app" target="_blank" rel="noreferrer">Google Cloud setup guide <ArrowUpRight size={12}/></a>
      </details>}
    </div>)}
    {folderId && <DriveFolderLink folderId={folderId}/>}
    {files.length > 0 && <ul className="attachment-files" aria-label="Files to upload">
      {files.map(file => <li key={file.token}>
        <FileText size={14}/>
        <span className="attachment-name">{file.name}</span>
        <small>{fileSize(file.size)}</small>
        <button className="attachment-remove" type="button" aria-label={`Remove ${file.name}`}
          onClick={() => remove(file.token)} disabled={!!activity}><X size={14}/></button>
      </li>)}
    </ul>}
    {activity && <p className="attachment-progress" role="status"><LoaderCircle className="spin" size={13}/> {activity}</p>}
    {error && <div className="form-error" role="alert">{error}</div>}
  </section>;
}

function DriveFolderLink({ folderId }: { folderId: string }) {
  return <a className="attachment-link" href={`https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`}
    target="_blank" rel="noreferrer"><FolderOpen size={15}/> Open Drive folder <ArrowUpRight size={13}/></a>;
}

export function RecordDriveFiles({ account, folderId }: { account: DriveAccount; folderId: string }) {
  const [files, setFiles] = useState<DriveAttachment[]>([]);
  const [loading, setLoading] = useState(Boolean(window.museumDrive));

  useEffect(() => {
    const drive = window.museumDrive;
    if (!drive) return;
    let active = true;
    drive.list(account, folderId).then(result => {
      if (active) setFiles(result);
    }).catch(() => {
      // The folder remains available in the browser under Google Drive's access rules.
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [account, folderId]);

  return <section className="record-attachments" aria-label="Photos and attachments">
    <div className="attachment-heading"><h3>Photos &amp; attachments</h3><DriveFolderLink folderId={folderId}/></div>
    {loading && <p role="status">Loading attachments…</p>}
    {files.length > 0 && <ul className="attachment-files">
      {files.map(file => <li key={file.id}>
        <FileText size={14}/>
        <a className="attachment-name" href={`https://drive.google.com/open?id=${encodeURIComponent(file.id)}`}
          target="_blank" rel="noreferrer">{file.name}</a>
        {file.size && <small>{fileSize(Number(file.size))}</small>}
        <ArrowUpRight size={13}/>
      </li>)}
    </ul>}
  </section>;
}
