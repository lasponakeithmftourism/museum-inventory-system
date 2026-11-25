import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { collection, doc, onSnapshot, type Firestore } from 'firebase/firestore';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth';
import {
  Archive, ArrowDownToLine, ArrowUpRight, BookOpen, Building2, Camera, Check, ChevronDown,
  CircleAlert, FileText, HardDrive, Image, LoaderCircle, LogOut, MapPin, Moon, Plus,
  Search, ShieldCheck, Shirt, SlidersHorizontal, Tag, X, Trash2, Pencil, PackageOpen, Printer, Settings2,
  type LucideIcon,
} from 'lucide-react';
import logoUrl from './assets/manolo-fortich-seal.png';
import printLogoUrl from './assets/manolo-fortich-seal-print.png';
import { auth, db, setupError, signInMessage } from './firebase';
import { deleteItem, firestoreMessage, rememberDriveFolder, writeItem, writePrintSettings } from './collectionStore';
import { AttachmentEditor, RecordDriveFiles, useDriveConnection, useRecordAttachments } from './RecordAttachments';
import type { DriveConnectionControls } from './RecordAttachments';
import { driveFailure } from './driveAttachments';
import type { DriveAccount, DriveBridge, DriveRecord } from './driveAttachments';
import { createWebDrive } from './webDrive';
import {
  CATEGORY_LABELS, CONDITIONS, DEFAULT_PRINT_SETTINGS, EMPTY_ITEM, FIELD_LABELS, ITEM_FIELDS, OWNERSHIP_STATUSES, TYPES,
  compareInventoryIds, conditionTone, inventoryYears, matchesInventoryFilters, readItem, readPrintSettings, recordInventoryYear, recordsCsv,
} from './records';
import type { Item, PrintRecordFilters, PrintSettings, SavedItem } from './records';
import { PrintPreview, PrintRecordFilterFields } from './PrintPreview';
import { BrowserRegisterPreview } from './BrowserRegisterPreview';
import { StickerTagDialog } from './StickerTag';
import { TagGenerator } from './TagGenerator';
import { PRINT_IMAGE_TYPES, preparePrintImage } from './printImage';
import { DEFAULT_PRINT_LAYOUT, printGeometry, printPageCss } from './printLayout';
import type { PrintFormat, PrintLayout } from './printLayout';

type SyncStatus = 'loading' | 'cached' | 'synced' | 'error';
type PrintSelection = { items: SavedItem[]; filters: PrintRecordFilters; ownershipFilter: string; search: string };
type DeleteError = { message: string; reconnect: boolean };
type ThemeSwitchProps = { darkMode: boolean; onToggleTheme: () => void };

const SYNC_LABELS: Record<SyncStatus, string> = {
  loading: 'Connecting to Firebase', cached: 'Showing cached records',
  synced: 'Synced', error: 'Firebase sync unavailable',
};

const TYPE_ICONS = new Map<string, LucideIcon>([
  ['Artwork', Image], ['Book', BookOpen], ['Costume', Shirt], ['Building', Building2], ['Heritage Site', MapPin],
  ['Old Photos', Camera], ['Old Documents', FileText],
]);

const iconForType = (type: string) => TYPE_ICONS.get(type) ?? Archive;
const THEME_STORAGE_KEY = 'museum-desk-theme';
const REGISTER_TIME = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila', hourCycle: 'h12', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const REGISTER_DATE = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'full' });

function readDarkMode() {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark';
  } catch {
    return false;
  }
}

export default function App() {
  const [darkMode, setDarkMode] = useState(readDarkMode);
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useLayoutEffect(() => {
    const theme = darkMode ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // The theme still applies for this session when storage is unavailable.
    }
  }, [darkMode]);

  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, account => {
      setError('');
      setUser(account);
      setAuthChecked(true);
    });
  }, []);

  async function login(email: string, password: string) {
    if (!auth || busy) return;
    setBusy(true);
    setError('');
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (error) {
      setError(signInMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function toggleTheme() {
    setDarkMode(enabled => !enabled);
  }

  if (!auth || !db) return <SetupScreen error={setupError} />;
  if (!authChecked) return <div className="loading-screen" role="status"><LoaderCircle className="spin"/> Checking your sign-in…</div>;
  if (!user) return <LoginScreen onLogin={login} busy={busy} error={error}
    darkMode={darkMode} onToggleTheme={toggleTheme} />;

  const session = auth;
  return <Register key={user.uid} user={user} database={db} onSignOut={() => signOut(session)}
    darkMode={darkMode} onToggleTheme={toggleTheme} />;
}

function Register({ user, database, onSignOut, darkMode, onToggleTheme }: {
  user: User; database: Firestore; onSignOut: () => Promise<void>;
} & ThemeSwitchProps) {
  const [items, setItems] = useState<SavedItem[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('loading');
  const [collectionError, setCollectionError] = useState('');
  const [printError, setPrintError] = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('All types');
  const [ownershipFilter, setOwnershipFilter] = useState('All statuses');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tagDialog, setTagDialog] = useState<SavedItem | 'generator' | null>(null);
  const [editing, setEditing] = useState<SavedItem | null | 'new'>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<DeleteError | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [printSettings, setPrintSettings] = useState<PrintSettings | null>(null);
  const [printSetupOpen, setPrintSetupOpen] = useState(false);
  const [printSelection, setPrintSelection] = useState<PrintSelection | null>(null);
  const [printFormat, setPrintFormat] = useState<PrintFormat>('summary');
  const [printLayout, setPrintLayout] = useState<PrintLayout>(DEFAULT_PRINT_LAYOUT);
  const [drive] = useState(() => window.museumDrive ?? createWebDrive());
  const driveAccount = useMemo(() => ({
    project: import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim() ?? '', uid: user.uid,
  }), [user.uid]);
  const driveConnection = useDriveConnection(driveAccount, drive);
  const connectingDrive = Boolean(driveConnection.activity);

  useEffect(() => {
    let loadedFromServer = false;
    return onSnapshot(collection(database, 'museumCollections'), { includeMetadataChanges: true }, snapshot => {
      // The SDK cache can still contain documents from a previous sign-in.
      if (!snapshot.metadata.fromCache) loadedFromServer = true;
      if (!loadedFromServer) return;
      const records = snapshot.docs.map(record => readItem(record.id, record.data({ serverTimestamps: 'estimate' })));
      records.sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
      setItems(records);
      setSelectedId(id => id && records.some(record => record.id === id) ? id : null);
      setSyncStatus(snapshot.metadata.fromCache ? 'cached' : 'synced');
    }, failure => {
      setItems([]);
      setSyncStatus('error');
      setCollectionError(firestoreMessage(failure, 'Could not load collection records.'));
    });
  }, [database]);

  useEffect(() => {
    let loadedFromServer = false;
    return onSnapshot(doc(database, 'museumSettings', 'print'), { includeMetadataChanges: true }, snapshot => {
      if (!snapshot.metadata.fromCache) loadedFromServer = true;
      if (loadedFromServer) setPrintSettings(readPrintSettings(snapshot.data()));
    }, failure => setPrintError(firestoreMessage(failure, 'Could not load print settings.')));
  }, [database]);

  const categoryLabel = typeFilter === 'All types'
    ? null
    : Object.entries(CATEGORY_LABELS).find(([type]) => type === typeFilter)?.[1] ?? typeFilter;
  const categoryItems = useMemo(() => typeFilter === 'All types' ? items : items.filter(item => item.itemType === typeFilter),
    [items, typeFilter]);

  const matchingItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter(item => (
      (ownershipFilter === 'All statuses' || item.ownershipLoanStatus === ownershipFilter) &&
      (!term || ITEM_FIELDS.some(field => item[field].toLowerCase().includes(term)))
    ));
  }, [items, search, ownershipFilter]);
  const filtered = useMemo(() => typeFilter === 'All types' ? matchingItems : matchingItems.filter(item => item.itemType === typeFilter),
    [matchingItems, typeFilter]);

  const selected = items.find(item => item.id === selectedId);
  const types = [...new Set([...TYPES, ...items.map(item => item.itemType), typeFilter])].filter(type => type !== 'All types');
  const statuses = [...new Set([...OWNERSHIP_STATUSES, ...items.map(item => item.ownershipLoanStatus), ownershipFilter])].filter(status => status !== 'All statuses');
  const ownedCount = categoryItems.filter(item => item.ownershipLoanStatus.toLowerCase() === 'owned').length;
  const loansCount = categoryItems.filter(item => /\b(loan|borrowed)\b/i.test(item.ownershipLoanStatus)).length;
  const attentionCount = categoryItems.filter(item => conditionTone(item.condition) !== 'good').length;

  const liveSelection = useMemo<PrintSelection>(() => ({
    items: filtered, filters: { year: '', types: typeFilter === 'All types' ? [] : [typeFilter] },
    ownershipFilter, search: search.trim(),
  }),
    [filtered, typeFilter, ownershipFilter, search]);
  const selection = useMemo(() => {
    if (!printSelection) return liveSelection;
    const { items, filters } = printSelection;
    return { ...printSelection, items: items.filter(item => matchesInventoryFilters(item, filters)) };
  }, [liveSelection, printSelection]);
  const previewItems = printSelection?.items;
  const printYears = useMemo(() => inventoryYears(previewItems ?? []), [previewItems]);
  const printTypes = useMemo(() => [...new Set([...TYPES, ...(previewItems ?? []).map(item => item.itemType)])], [previewItems]);
  const page = useMemo(() => printGeometry(printLayout), [printLayout]);
  const RegisterPreview = window.museumPrinting ? PrintPreview : BrowserRegisterPreview;
  const printDocument = useMemo(() => <PrintDocument {...selection} format={printFormat} settings={printSettings ?? DEFAULT_PRINT_SETTINGS}/>,
    [selection, printFormat, printSettings]);

  function openRecord(id: string) {
    setDeleteError(null);
    setSelectedId(id);
  }

  function finishEdit(inventoryId: string, uploaded: number) {
    setEditing(null);
    setSelectedId(null);
    const message = editing === 'new' ? `Record ${inventoryId} added to the register.` : 'Record updated.';
    setNotice(uploaded > 0 ? `${message} ${uploaded} ${uploaded === 1 ? 'file' : 'files'} uploaded to Google Drive.` : message);
  }

  async function removeItem(item: SavedItem) {
    if (deleting || connectingDrive) return;
    const driveNotice = item.driveFolderId ? ' Its folder and attachments will be moved to Google Drive Trash.' : '';
    if (!window.confirm(`Delete “${item.itemTitle}” (${item.inventoryId}) from the register?${driveNotice} The register deletion cannot be undone.`)) return;
    setDeleting(true);
    setDeleteError(null);
    let reconnect = false;
    async function updateDrive(action: 'check' | 'trash') {
      if (!drive) throw new Error('Configure Google Drive for this website to delete linked records.');
      try {
        await drive.trashFolder(driveAccount, item.id, item.driveFolderId, action);
      } catch (failure) {
        reconnect = true;
        throw new Error(driveFailure(failure, 'Could not move the folder to Google Drive Trash.'));
      }
    }
    try {
      if (item.driveFolderId) await updateDrive('check');
      await deleteItem(database, item, item.driveFolderId ? () => updateDrive('trash') : undefined);
      setSelectedId(null);
      setNotice(item.driveFolderId ? 'Record deleted. Its folder is in Google Drive Trash.' : 'Record deleted.');
    } catch (failure) {
      setDeleteError({ message: firestoreMessage(failure, 'Could not delete this record.'), reconnect });
      if (reconnect) void driveConnection.refreshConnection();
    } finally {
      setDeleting(false);
    }
  }

  async function connectDrive(retryDeletion = false) {
    if (deleting) return;
    try {
      const connection = await driveConnection.connect();
      if (retryDeletion && connection?.email) {
        setDeleteError(null);
        setNotice('Google Drive connected. Try deleting the record again.');
      }
    } catch (failure) {
      if (retryDeletion) setDeleteError({ message: driveFailure(failure, 'Could not connect Google Drive.'), reconnect: true });
    }
  }

  async function savePrintSettings(next: PrintSettings, original: PrintSettings) {
    await writePrintSettings(database, next, original);
    setPrintSetupOpen(false);
    setNotice('Print header, footer, and signatories saved.');
  }

  function openPrintPreview() {
    setPrintSelection({ ...liveSelection, items: matchingItems });
  }

  function exportCsv() {
    const url = URL.createObjectURL(new Blob([recordsCsv(filtered)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'museum-collections-register.csv';
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function signOutFromRegister() {
    setSigningOut(true);
    setError('');
    try {
      await onSignOut();
    } catch (failure) {
      setError(firestoreMessage(failure, 'Could not sign out.'));
      setSigningOut(false);
    }
  }

  const loading = syncStatus === 'loading';
  const syncLabel = SYNC_LABELS[syncStatus];
  const canPrint = !!printSettings || !!printError;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand">
        <AppLogo />
        <div><strong>Municipal Tourism Office</strong><span>MUSEUM INVENTORY SYSTEM</span></div>
      </div>
      <div className="side-section-label">WORKSPACE</div>
      <button className={`nav-item ${typeFilter === 'All types' ? 'active' : ''}`} onClick={() => {
        setTypeFilter('All types');
        setOwnershipFilter('All statuses');
        setSearch('');
      }}><Archive size={18}/><span>Collections</span><span className="nav-count">{items.length}</span></button>
      <button type="button" className="nav-item" aria-haspopup="dialog" onClick={() => setTagDialog('generator')}>
        <Tag size={18}/><span>Tag Generator</span>
      </button>
      <div className="side-section-label category-label">COLLECTIONS</div>
      {Object.entries(CATEGORY_LABELS).map(([type, label]) => {
        const Icon = iconForType(type);
        return <button key={type} className={`nav-item ${typeFilter === type ? 'selected' : ''}`} aria-pressed={typeFilter === type}
          onClick={() => setTypeFilter(typeFilter === type ? 'All types' : type)}>
          <Icon size={17}/><span>{label}</span><span className="nav-count muted">{items.filter(item => item.itemType === type).length}</span>
        </button>;
      })}
      <div className="sidebar-bottom">
        <div className="sidebar-drive">
          {driveConnection.connection.email ? <div className="sidebar-drive-status" role="status">
            <Check size={16} aria-hidden="true"/>
            <div><b>Google Drive connected</b><small title={driveConnection.connection.email}>{driveConnection.connection.email}</small></div>
          </div> : <button className="button button-light" type="button"
            disabled={!drive || driveConnection.checking || connectingDrive || deleting || signingOut} onClick={() => void connectDrive()}>
            {driveConnection.checking || connectingDrive
              ? <LoaderCircle className="spin" size={16} aria-hidden="true"/>
              : <HardDrive size={16} aria-hidden="true"/>}
            {driveConnection.checking ? 'Checking Google Drive…' : connectingDrive ? 'Connecting…' : 'Connect Google Drive'}
          </button>}
          {!drive && <p>Google Drive setup required.</p>}
          {driveConnection.error && <p className="sidebar-drive-error" role="alert">{driveConnection.error}</p>}
        </div>
        <ThemeSwitch darkMode={darkMode} onToggleTheme={onToggleTheme}/>
        <div className="sync-card" data-sync-status={syncStatus}>
          <div className="sync-icon"><ShieldCheck size={17}/></div><div><b>{syncLabel}</b></div><span className="status-dot"/>
        </div>
        <div className="profile">
          <div className="avatar">{(user.email || 'M').slice(0, 1).toUpperCase()}</div>
          <div className="profile-info"><b>{user.email}</b><small>Admin</small></div>
          <button className="icon-button" title="Sign out" aria-label="Sign out" disabled={signingOut} onClick={signOutFromRegister}><LogOut size={16}/></button>
        </div>
      </div>
    </aside>
    <main className="main-area">
      <header className="topbar">
        <div className="breadcrumbs"><span>Collections</span><span className="crumb-sep">/</span><b>{categoryLabel ?? 'Register'}</b></div>
        <div className="top-actions">
          <div className="cloud-status" role="status" data-sync-status={syncStatus}><span className="status-dot"/> {syncLabel}</div>
          <button className="button button-light" disabled={!printSettings} onClick={() => setPrintSetupOpen(true)}><Settings2 size={15}/> Print setup</button>
          <button className="button button-light" disabled={!canPrint} onClick={openPrintPreview}><Printer size={15}/> Print register</button>
          <button className="button button-light" disabled={loading || syncStatus === 'error'} onClick={exportCsv}><ArrowDownToLine size={16}/> Export CSV</button>
          <button className="button button-primary" onClick={() => setEditing('new')}><Plus size={17}/> Add record</button>
        </div>
      </header>
      <div className="content">
        <div className="welcome-row">
          <div>
            <h1>Museum Inventory System</h1>
          </div>
          <RegisterClock/>
        </div>
        <section className="stats-grid">
          <Stat label="Total records" value={categoryItems.length} icon={<Archive size={18}/>} caption={categoryLabel ?? 'Across all collection types'} tone="sand"/>
          <Stat label="Owned by museum" value={ownedCount} icon={<ShieldCheck size={18}/>} caption="Ownership marked as owned" tone="green"/>
          <Stat label="On loan / borrowed" value={loansCount} icon={<ArrowUpRight size={18}/>} caption="Records with loan status" tone="blue"/>
          <Stat label="Needs attention" value={attentionCount} icon={<CircleAlert size={18}/>} caption="Condition review suggested" tone="amber"/>
        </section>
        <section className="register-card">
          <div className="register-header">
            <div><h2>{categoryLabel ?? 'All'} Collection Records</h2><span>{filtered.length} {filtered.length === 1 ? 'record' : 'records'} shown</span></div>
            <div className="register-actions">
              <div className="searchbox">
                <Search size={16}/><input aria-label="Search collection" placeholder="Search records…" value={search} onChange={e => setSearch(e.target.value)}/>
                {search && <button className="clear-search" aria-label="Clear search" onClick={() => setSearch('')}><X size={14}/></button>}
              </div>
              <label className="filter-select"><SlidersHorizontal size={15}/>
                <select aria-label="Collection type" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
                  <option>All types</option>{types.map(type => <option key={type}>{type}</option>)}
                </select><ChevronDown size={14}/>
              </label>
              <label className="filter-select">
                <select aria-label="Ownership status" value={ownershipFilter} onChange={e => setOwnershipFilter(e.target.value)}>
                  <option>All statuses</option>{statuses.map(status => <option key={status}>{status}</option>)}
                </select><ChevronDown size={14}/>
              </label>
            </div>
          </div>
          {collectionError && <div className="inline-error" role="alert">{collectionError}</div>}
          {printError && <div className="inline-error" role="alert">{printError}</div>}
          {error && <div className="inline-error" role="alert">{error}</div>}
          <div className="table-wrap"><table><thead><tr><th>INVENTORY ID</th><th>ITEM</th><th>TYPE</th><th>CREATOR / SOURCE</th><th>CONDITION</th><th>LOCATION</th><th>OWNERSHIP</th><th></th></tr></thead><tbody>
            {filtered.map(item => {
              const Icon = iconForType(item.itemType);
              return <tr className="record-row" key={item.id} onClick={() => openRecord(item.id)}>
                <td><span className="inventory-id">{item.inventoryId}</span></td>
                <td><div className="item-cell"><div className="item-thumb"><Icon size={17}/></div>
                  <div><b>{item.itemTitle || 'Untitled record'}</b><small>{item.dateCreatedEstimated || 'Date not recorded'}</small></div>
                </div></td>
                <td><TypeBadge value={item.itemType}/></td>
                <td className="muted-cell">{item.creatorArtistMaker || item.donorSellerSource || '—'}</td>
                <td><Condition value={item.condition}/></td>
                <td className="location-cell"><MapPin size={13}/>{item.currentLocation || 'Unassigned'}</td>
                <td><span className="ownership-badge">{item.ownershipLoanStatus}</span></td>
                <td><button className="row-arrow" aria-label={`Open ${item.itemTitle || item.inventoryId}`}><ArrowUpRight size={16}/></button></td>
              </tr>;
            })}
            {!filtered.length && <tr><td colSpan={8}>
              <div className="empty-state">
                <div className="empty-icon">{loading ? <LoaderCircle className="spin" size={22}/> : <PackageOpen size={22}/>}</div>
                {loading ? <b>Loading collection records…</b> : syncStatus === 'error' ? <b>Records unavailable</b> :
                  categoryLabel && !categoryItems.length ? <b>No records in {categoryLabel}</b> :
                  categoryItems.length ? <><b>No matching records</b><span>Try another search or filter.</span></> :
                  <><b>Your register is ready</b><span>Add the first collection record to begin documenting your holdings.</span>
                    <button className="button button-primary" onClick={() => setEditing('new')}><Plus size={16}/> Add first record</button></>}
              </div>
            </td></tr>}
          </tbody></table></div>
          <div className="table-footer"><span>Showing <b>{filtered.length}</b> of <b>{categoryItems.length}</b> records</span>
            {syncStatus === 'synced' && <span className="footer-live"><span className="status-dot"/> Live updates on</span>}
          </div>
        </section>
      </div>
    </main>
    {tagDialog === 'generator' && <TagGenerator items={items} logo={<AppLogo forPrint/>} onClose={() => setTagDialog(null)}/>}
    {tagDialog && tagDialog !== 'generator' && <StickerTagDialog item={tagDialog} logo={<AppLogo forPrint/>}
      onClose={() => setTagDialog(null)}/>}
    {!tagDialog && <>
      {page && <style>{printPageCss(page)}</style>}
      {printSelection ? <RegisterPreview job={{ kind: 'register', count: selection.items.length }} content={printDocument}
        layout={printLayout} page={page} onLayout={setPrintLayout} onClose={() => setPrintSelection(null)}
        onSetup={printSettings ? () => setPrintSetupOpen(true) : undefined}>
        <PrintRecordFilterFields filters={printSelection.filters} years={printYears} types={printTypes}
          onFilters={filters => setPrintSelection(previous => previous && { ...previous, filters })}/>
        <label className="field"><span>Format</span>
          <select value={printFormat} onChange={event => setPrintFormat(event.target.value as PrintFormat)}>
            <option value="summary">Summary register</option>
            <option value="full">Full record details</option>
          </select>
        </label>
      </RegisterPreview> : printDocument}
    </>}
    {printSetupOpen && printSettings && <PrintSetupModal settings={printSettings} onClose={() => setPrintSetupOpen(false)} onSave={savePrintSettings}/>}
    {selected && !tagDialog && <DetailPanel item={selected} driveAccount={driveAccount} drive={drive} onClose={() => setSelectedId(null)} onEdit={() => setEditing(selected)}
      onTag={() => setTagDialog(selected)}
      onDelete={() => removeItem(selected)} deleting={deleting} error={deleteError}
      connectingDrive={connectingDrive} onConnectDrive={() => void connectDrive(true)}/>}
    {editing && <ItemModal item={editing === 'new' ? null : editing} database={database} driveAccount={driveAccount} driveConnection={driveConnection}
      onClose={() => setEditing(null)} onSaved={finishEdit}/>}
    {notice && <div className="toast" role="status"><Check size={16}/>{notice}<button aria-label="Dismiss message" onClick={() => setNotice('')}><X size={15}/></button></div>}
  </div>;
}

function RegisterClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer: number;
    function tick() {
      const current = new Date();
      setNow(current);
      timer = window.setTimeout(tick, 1000 - current.getMilliseconds());
    }
    tick();
    return () => window.clearTimeout(timer);
  }, []);

  return <time className="register-clock" dateTime={now.toISOString()}>
    <span className="register-clock-time">{REGISTER_TIME.format(now)}</span>
    <span className="register-clock-date">{REGISTER_DATE.format(now)}</span>
  </time>;
}

function Stat({label,value,icon,caption,tone}:{label:string;value:number;icon:React.ReactNode;caption:string;tone:string}) { return <div className="stat-card"><div className="stat-top"><span>{label}</span><span className={`stat-icon ${tone}`}>{icon}</span></div><div className="stat-value">{value}</div><small>{caption}</small></div>; }
function Condition({ value }: { value: string }) {
  return <span className={`condition ${conditionTone(value)}`}><i/>{value.trim() || 'Not recorded'}</span>;
}

function TypeBadge({ value }: { value: string }) {
  return <span className={`type-badge ${value.toLowerCase().replace(/\s+/g, '-')}`}>{value}</span>;
}

function AppLogo({ forPrint = false }: { forPrint?: boolean }) {
  const pixels = forPrint ? 1024 : 4500;
  return <img className="app-logo" src={forPrint ? printLogoUrl : logoUrl} width={pixels} height={pixels}
    alt="Official seal of Manolo Fortich, Bukidnon"/>;
}

function SetupScreen({ error }: { error?: string }) {
  return <div className="setup-screen"><div className="setup-card">
    <AppLogo />
    <div className="eyebrow">MUSEUM COLLECTIONS</div>
    <h1>Connect your Firebase project</h1>
    <p>This desktop app stores records in your Firebase Firestore database. Set up the Firebase web app configuration in the project folder.</p>
    {error && <div className="form-error" role="alert">{error}</div>}
    <ol>
      <li>Copy <code>.env.example</code> to <code>.env.local</code>.</li>
      <li>Paste the Firebase project values into the matching <code>VITE_FIREBASE_*</code> fields.</li>
      <li>Enable Email/Password in Firebase Authentication and create your user account.</li>
      <li>Publish the supplied <code>firestore.rules</code> in Firebase Console.</li>
      <li>Restart the development app or rebuild the Windows installer to apply the settings.</li>
    </ol>
    <div className="setup-note"><ShieldCheck size={18}/><span>Firestore rules in this project require an authenticated Firebase user for every read and write.</span></div>
  </div></div>;
}
function ThemeSwitch({ darkMode, onToggleTheme, compact = false }: ThemeSwitchProps & { compact?: boolean }) {
  return <button className="theme-switch" type="button" role="switch" aria-label="Dark mode"
    aria-checked={darkMode} title={compact ? 'Dark mode' : undefined} onClick={onToggleTheme}>
    <Moon size={16} aria-hidden="true"/>
    {!compact && <span>Dark mode</span>}
    <span className="theme-switch-track" aria-hidden="true"/>
  </button>;
}

function LoginScreen({ onLogin, busy, error, darkMode, onToggleTheme }: {
  onLogin: (email: string, password: string) => void; busy: boolean; error: string;
} & ThemeSwitchProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    onLogin(email, password);
  }

  return <div className="login-screen"><div className="login-card">
    <ThemeSwitch darkMode={darkMode} onToggleTheme={onToggleTheme} compact/>
    <AppLogo />
    <div className="eyebrow">MUSEUM INVENTORY SYSTEM</div>
    <h1>Sign In</h1>
    <p>Welcome Back!</p>
    <form onSubmit={submit}>
      <label>Email address<input required type="email" autoComplete="username" placeholder="tourism@manolofortich.gov.ph" value={email} onChange={event => setEmail(event.target.value)} /></label>
      <label>Password<input required type="password" autoComplete="current-password" placeholder="Enter your password" value={password} onChange={event => setPassword(event.target.value)} /></label>
      {error && <div className="form-error">{error}</div>}
      <button className="button button-primary login-button" disabled={busy}>
        {busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />} Sign In
      </button>
    </form>
    <div className="login-secure"></div>
  </div></div>;
}
function DetailPanel({ item, driveAccount, drive, onClose, onEdit, onTag, onDelete, deleting, connectingDrive, onConnectDrive, error }: {
  item: SavedItem; driveAccount: DriveAccount; drive?: DriveBridge; onClose: () => void; onEdit: () => void; onTag: () => void; onDelete: () => void;
  deleting: boolean; connectingDrive: boolean; onConnectDrive: () => void; error: DeleteError | null;
}) {
  const entries = ITEM_FIELDS.filter(key => key !== 'lastUpdated');
  const busy = deleting || connectingDrive;
  return <div className="drawer-backdrop" onMouseDown={e => !busy && e.target === e.currentTarget && onClose()}>
    <aside className="detail-drawer" aria-label="Collection record">
      <div className="drawer-head">
        <div><span className="eyebrow">COLLECTION RECORD</span>
          <button className="drawer-close" aria-label="Close record" disabled={busy} onClick={onClose}><X size={18}/></button>
        </div>
        <div className="detail-id">{item.inventoryId}</div><h2>{item.itemTitle || 'Untitled record'}</h2><TypeBadge value={item.itemType}/>
      </div>
      <div className="drawer-buttons">
        <button className="button button-light" disabled={busy || item.deletionPending} onClick={onEdit}><Pencil size={15}/> Edit record</button>
        <button className="button button-light" disabled={busy || item.deletionPending} onClick={onTag}><Tag size={15}/> Print tag</button>
        <button className="button button-danger" disabled={busy} onClick={onDelete}>
          {deleting ? <LoaderCircle className="spin" size={15}/> : <Trash2 size={15}/>}
          {deleting ? 'Deleting…' : item.deletionPending ? 'Finish deletion' : 'Delete record'}
        </button>
        {error?.reconnect && <button className="button button-light" disabled={busy} onClick={onConnectDrive}>
          {connectingDrive ? 'Connecting…' : 'Connect Google Drive'}
        </button>}
      </div>
      {error && <div className="form-error" role="alert">{error.message}</div>}
      <div className="detail-fields">{entries.map(key => <div className={`detail-field ${key === 'description' || key === 'provenanceKnownHistory' || key === 'followUpRemarks' ? 'wide' : ''}`} key={key}>
        <span>{FIELD_LABELS[key]}</span><p>{item[key] || <i>Not recorded</i>}</p>
      </div>)}</div>
      {item.driveFolderId && <RecordDriveFiles key={item.driveFolderId} account={driveAccount} drive={drive} folderId={item.driveFolderId}/>}
      <div className="last-updated">Last updated {item.lastUpdated ? new Date(item.lastUpdated).toLocaleString() : '—'}</div>
    </aside>
  </div>;
}

function optionsWithCurrent(options: string[], current: string) {
  return current && !options.includes(current) ? [...options, current] : options;
}

function ItemModal({ item, database, driveAccount, driveConnection, onClose, onSaved }: {
  item: SavedItem | null; database: Firestore; driveAccount: DriveAccount; driveConnection: DriveConnectionControls;
  onClose: () => void; onSaved: (inventoryId: string, uploaded: number) => void;
}) {
  const [form, setForm] = useState<Item>(item ?? EMPTY_ITEM);
  const [saved, setSaved] = useState<{ record: DriveRecord; folderId: string } | null>(null);
  const [uploaded, setUploaded] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const attachments = useRecordAttachments(driveAccount, driveConnection);
  const busy = saving || Boolean(attachments.activity);

  function change(key:keyof Item,value:string) { setForm(prev=>({...prev,[key]:value})); }

  function close() {
    if (saved) onSaved(saved.record.inventoryId, uploaded);
    else onClose();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setSaving(true);
    setError('');
    let current = saved;
    let totalUploaded = uploaded;
    try {
      if (!current) {
        const { id, inventoryId } = await writeItem(database, form, item ?? undefined);
        const year = recordInventoryYear({ id, inventoryId, dateReceivedAssigned: form.dateReceivedAssigned }) || 'Undated';
        current = { record: { id, inventoryId, year }, folderId: item?.driveFolderId ?? '' };
        setSaved(current);
      }
      if (attachments.files.length) {
        if (!attachments.drive || !attachments.connection.email) throw new Error('Connect Google Drive to upload the selected files.');
        const candidate = current.folderId || await attachments.drive.prepareFolder(driveAccount, current.record);
        const folderId = await rememberDriveFolder(database, current.record.id, candidate);
        current = { ...current, folderId };
        setSaved(current);
        await attachments.upload(folderId, () => {
          totalUploaded += 1;
          setUploaded(totalUploaded);
        });
      }
      onSaved(current.record.inventoryId, totalUploaded);
    } catch (failure) {
      setError(current
        ? driveFailure(failure, 'Could not upload the selected files.')
        : firestoreMessage(failure, 'Could not save this record.'));
      if (current) await attachments.refreshConnection();
    } finally {
      setSaving(false);
    }
  }
  const originalDate = item?.dateReceivedAssigned;
  const legacyDate = originalDate && !/^\d{4}-\d{2}-\d{2}$/.test(originalDate);
  const textAreas: (keyof Item)[]=['description','provenanceKnownHistory','followUpRemarks'];
  return <div className="modal-backdrop" onMouseDown={e => !busy && e.target === e.currentTarget && close()}><form className="item-modal" role="dialog" aria-modal="true" aria-labelledby="item-editor-title" onSubmit={submit}><div className="modal-head"><div><span className="eyebrow">COLLECTION REGISTER</span><h2 id="item-editor-title">{item?'Edit collection record':'Add collection record'}</h2><p>Enter known information. Fields can be completed or updated later.</p></div><button type="button" className="drawer-close" aria-label="Close record editor" disabled={busy} onClick={close}><X size={18}/></button></div><div className="form-scroll"><fieldset className="form-grid" disabled={busy || Boolean(saved)}>
    <Field label="Inventory ID"><input disabled value={saved?.record.inventoryId ?? item?.inventoryId ?? 'Assigned automatically on save'}/></Field>
    <Field label="Item Title" required><input required placeholder="Name or short title" value={form.itemTitle} onChange={e=>change('itemTitle',e.target.value)}/></Field>
    <Field label="Item Type"><select value={form.itemType} onChange={e=>change('itemType',e.target.value)}>{optionsWithCurrent(TYPES, item?.itemType ?? '').map(t=><option key={t}>{t}</option>)}</select></Field>
    <Field label="Creator / Artist / Maker"><input placeholder="Person, group, or unknown" value={form.creatorArtistMaker} onChange={e=>change('creatorArtistMaker',e.target.value)}/></Field>
    <Field label="Date Created / Estimated"><input placeholder="e.g. c. 1950 or 2024" value={form.dateCreatedEstimated} onChange={e=>change('dateCreatedEstimated',e.target.value)}/></Field>
    <Field label="Date Received / Assigned"><input type={legacyDate ? 'text' : 'date'} value={form.dateReceivedAssigned} onChange={e=>change('dateReceivedAssigned',e.target.value)}/></Field>
    <Field label="Acquisition Method"><input placeholder="Donation, purchase, transfer…" value={form.acquisitionMethod} onChange={e=>change('acquisitionMethod',e.target.value)}/></Field>
    <Field label="Donor / Seller / Source"><input placeholder="Name or organization" value={form.donorSellerSource} onChange={e=>change('donorSellerSource',e.target.value)}/></Field>
    <Field label="Ownership / Loan Status"><select value={form.ownershipLoanStatus} onChange={e=>change('ownershipLoanStatus',e.target.value)}>{optionsWithCurrent(OWNERSHIP_STATUSES, item?.ownershipLoanStatus ?? '').map(t=><option key={t}>{t}</option>)}</select></Field>
    <Field label="Condition"><select value={form.condition} onChange={e=>change('condition',e.target.value)}><option value="">Select condition</option>{optionsWithCurrent(CONDITIONS, item?.condition ?? '').map(t=><option key={t}>{t}</option>)}</select></Field>
    <Field label="Current Location"><input placeholder="Gallery, room, shelf, site…" value={form.currentLocation} onChange={e=>change('currentLocation',e.target.value)}/></Field>
    <Field label="Supporting Record Reference"><input placeholder="Accession form, deed, file no.…" value={form.supportingRecordReference} onChange={e=>change('supportingRecordReference',e.target.value)}/></Field>
    {textAreas.map(key=><Field key={key} label={FIELD_LABELS[key]} wide><textarea rows={key==='description'?3:2} placeholder={key==='description'?'Describe the item, materials, dimensions, or identifying features…':'Add known history or notes…'} value={form[key]} onChange={e=>change(key,e.target.value)}/></Field>)}
  </fieldset>
    <fieldset className="attachment-fieldset" disabled={busy}><AttachmentEditor attachments={attachments}
      folderId={saved?.folderId || item?.driveFolderId || ''}/></fieldset>
    {error && <div className="form-error modal-error" role="alert">{error}</div>}
  </div><div className="modal-footer">
    <span><ShieldCheck size={14}/> {saved ? `Record ${saved.record.inventoryId} is saved` : 'Changes sync to Firebase'}</span>
    <div>
      <button className="button button-light" type="button" disabled={busy} onClick={close}>{saved ? 'Close editor' : 'Cancel'}</button>
      <button className="button button-primary" disabled={busy}>
        {saving ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/>}
        {saving ? (attachments.files.length ? 'Uploading files…' : 'Saving…')
          : saved ? (attachments.files.length ? 'Retry uploads' : 'Done') : item ? 'Save changes' : 'Save record'}
      </button>
    </div>
  </div></form></div>;
}
function Field({label,children,required,wide}:{label:string;children:React.ReactNode;required?:boolean;wide?:boolean}) { return <label className={`field ${wide?'wide':''}`}><span>{label}{required&&<i> *</i>}</span>{children}</label>; }


const SIGNATORIES = [
  ['Prepared by', 'preparedByName', 'preparedByTitle'],
  ['Noted by', 'reviewedByName', 'reviewedByTitle'],
  ['Approved by', 'approvedByName', 'approvedByTitle'],
] as const;

const PRINT_CONTENT = [
  { label: 'Custom header', text: 'headerText', image: 'headerImage', rows: 4, placeholder: 'Enter office or letterhead text' },
  { label: 'Custom footer', text: 'footerText', image: 'footerImage', rows: 2, placeholder: 'Enter contact details or a document note' },
] as const;
type PrintImageField = typeof PRINT_CONTENT[number]['image'];
type PrintContentType = 'text' | 'image';

function PrintSetupModal({ settings, onClose, onSave }: {
  settings: PrintSettings; onClose: () => void; onSave: (next: PrintSettings, original: PrintSettings) => Promise<void>;
}) {
  const [original] = useState(settings);
  const [form, setForm] = useState(settings);
  const [contentTypes, setContentTypes] = useState<Record<PrintImageField, PrintContentType>>({
    headerImage: settings.headerImage ? 'image' : 'text',
    footerImage: settings.footerImage ? 'image' : 'text',
  });
  const [uploading, setUploading] = useState<PrintImageField | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const busy = saving || uploading !== null;

  function change(key: keyof PrintSettings, value: string) {
    setForm(previous => ({ ...previous, [key]: value }));
  }

  function chooseContentType(key: PrintImageField, type: PrintContentType) {
    setContentTypes(previous => ({ ...previous, [key]: type }));
    setError('');
  }

  async function chooseImage(key: PrintImageField, file: File) {
    setUploading(key);
    setError('');
    try {
      change(key, await preparePrintImage(file));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not prepare this image.');
    } finally {
      setUploading(null);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const next = { ...form };
    for (const { label, image } of PRINT_CONTENT) {
      if (contentTypes[image] === 'text') next[image] = '';
      else if (!next[image]) {
        setError(`Choose an image for the ${label.toLowerCase()}.`);
        return;
      }
    }
    setSaving(true);
    setError('');
    try {
      await onSave(next, original);
    } catch (failure) {
      setError(firestoreMessage(failure, 'Could not save print settings.'));
    } finally {
      setSaving(false);
    }
  }

  return <div className="modal-backdrop" onMouseDown={e => !busy && e.target === e.currentTarget && onClose()}>
    <form className="item-modal print-settings-modal" role="dialog" aria-modal="true" aria-labelledby="print-setup-title" onSubmit={submit}>
      <div className="modal-head">
        <div><span className="eyebrow">PRINT CONFIGURATION</span><h2 id="print-setup-title">Header, footer & signatories</h2></div>
        <button type="button" className="drawer-close" aria-label="Close print setup" disabled={busy} onClick={onClose}><X size={18}/></button>
      </div>
      <div className="form-scroll">
        {error && <div className="form-error print-setup-error" role="alert">{error}</div>}
        <fieldset className="form-grid" disabled={busy}>
          {PRINT_CONTENT.map(({ label, text, image, rows, placeholder }) => <fieldset className="print-content-field" key={image}>
            <legend>{label}</legend>
            <label className="field print-content-type"><span>Content type</span>
              <select aria-label={`${label} content type`} value={contentTypes[image]}
                onChange={event => chooseContentType(image, event.target.value as PrintContentType)}>
                <option value="text">Text</option><option value="image">Image</option>
              </select>
            </label>
            {contentTypes[image] === 'text' ? <label className="field">
              <span>Text</span><textarea aria-label={`${label} text`} rows={rows} placeholder={placeholder}
                value={form[text]} onChange={event => change(text, event.target.value)}/>
            </label> : <div className="print-image-editor">
              <label className="field"><span>Image file</span>
                <input type="file" aria-label={`${label} image file`} accept={PRINT_IMAGE_TYPES} onChange={event => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file) void chooseImage(image, file);
                }}/>
              </label>
              {uploading === image && <small role="status">Preparing image…</small>}
              {form[image] && <>
                <img className="print-image-sample" src={form[image]} alt={`${label} preview`}/>
                <button type="button" className="button button-light" onClick={() => {
                  change(image, '');
                  chooseContentType(image, 'text');
                }}>Remove image</button>
              </>}
            </div>}
          </fieldset>)}
          <div className="form-section-title">SIGNATORY BLOCKS <span>Only signatories with a name appear in print.</span></div>
          {SIGNATORIES.map(([label, nameKey, titleKey]) => <div className="signatory-edit" key={label}>
            <b>{label}</b>
            <input aria-label={`${label} name`} placeholder="Full name" value={form[nameKey]} onChange={e => change(nameKey, e.target.value)}/>
            <input aria-label={`${label} title`} placeholder="Position / title" value={form[titleKey]} onChange={e => change(titleKey, e.target.value)}/>
          </div>)}
        </fieldset>
      </div>
      <div className="modal-footer">
        <span><ShieldCheck size={14}/> Saved to this Firebase project</span>
        <div>
          <button className="button button-light" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="button button-primary" disabled={busy}>{saving ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/>} Save print setup</button>
        </div>
      </div>
    </form>
  </div>;
}

function PrintDocument({ items, settings, format, filters, ownershipFilter, search }: PrintSelection & {
  settings: PrintSettings; format: PrintFormat;
}) {
  const orderedItems = [...items].sort(compareInventoryIds);
  const headerLines = settings.headerText.split('\n');
  const columns: (keyof Item)[] = ['inventoryId', 'itemTitle', 'itemType', 'creatorArtistMaker', 'condition', 'currentLocation', 'ownershipLoanStatus', 'dateReceivedAssigned'];
  const types = filters.types.length ? filters.types.join(', ') : 'All collection types';
  const footer = settings.footerImage ? <img className="print-footer-image" src={settings.footerImage} alt="Custom footer"/> : settings.footerText;
  const signatories = SIGNATORIES.map(([label, nameKey, titleKey]) => ({
    label, name: settings[nameKey].trim(), title: settings[titleKey].trim(),
  })).filter(({ name }) => name);

  const content = <>
    <header className="print-header">
      <div className={`print-letterhead${settings.headerImage ? ' print-letterhead-with-image' : ''}`}>
        {settings.headerImage ? <img className="print-header-image" src={settings.headerImage} alt="Custom header"/> : <>
          <AppLogo forPrint/>
          <div className="print-header-text">{headerLines.map((line, index) => <div className={index === headerLines.length - 1 ? 'print-office-name' : ''} key={index}>{line || '\u00a0'}</div>)}</div>
        </>}
      </div>
      <div className="print-heading"><h1>MUSEUM COLLECTIONS REGISTER</h1><span>{filters.year || 'All years'} · {items.length} {items.length === 1 ? 'record' : 'records'}</span></div>
    </header>
    <div className="print-meta">{types} · {ownershipFilter}{search && ` · Search “${search}”`}</div>
    {format === 'summary' ? <table className="print-table">
      <thead><tr>{columns.map(column => <th key={column}>{FIELD_LABELS[column]}</th>)}</tr></thead>
      <tbody>{orderedItems.map(item => <tr key={item.id}>{columns.map(column => <td key={column}>{item[column] || '—'}</td>)}</tr>)}</tbody>
    </table> : <div className="print-records">{orderedItems.map(item => <section className="print-record" key={item.id}>
      <h2>{item.itemTitle || 'Untitled record'} <small>({item.inventoryId})</small></h2>
      <div className="print-field-grid">{ITEM_FIELDS.map(field => <div className="print-field" key={field}>
        <b>{FIELD_LABELS[field]}</b><span>{field === 'lastUpdated' && item.lastUpdated ? new Date(item.lastUpdated).toLocaleString() : item[field] || '—'}</span>
      </div>)}</div>
    </section>)}</div>}
    {signatories.length > 0 && <div className="print-signatories">
      {signatories.map(({ label, name, title }) => <div className="print-signatory" key={label}>
        <div className="signature-space"/>
        <b>{name}</b>
        {title && <span>{title}</span>}
        <small>{label}</small>
      </div>)}
    </div>}
  </>;

  return <div className="print-document">
    {footer ? <>
      {/* The repeated table footer reserves the matching height on each page. */}
      <table className="print-page-flow" role="presentation">
        <tbody><tr><td>{content}</td></tr></tbody>
        <tfoot aria-hidden="true"><tr><td><div className="print-footer">{footer}</div></td></tr></tfoot>
      </table>
      <footer className="print-footer print-page-footer">{footer}</footer>
    </> : content}
  </div>;
}
