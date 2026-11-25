import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { ChevronDown, LoaderCircle, Printer, Settings2, X } from 'lucide-react';
import { MARGIN_SIDES, PAPER_SIZES } from './printLayout';
import type { PrintGeometry, PrintLayout } from './printLayout';
import type { PrintRecordFilters } from './records';

type Preview = { content: ReactElement; page: PrintGeometry; url: string };

type PrintJob = { kind: 'register'; count: number } | { kind: 'tags'; count: number; sheets: number };

export function PrintPreview({ job, content, layout, page, onLayout, onSetup, onClose, children }: {
  job: PrintJob; content: ReactElement; layout: PrintLayout; page: PrintGeometry | null;
  onLayout: (layout: PrintLayout) => void; onSetup?: () => void; onClose: () => void; children: ReactNode;
}) {
  const desktop = window.museumPrinting;
  const { count } = job;
  const tags = job.kind === 'tags';
  const fits = job.kind === 'register' || job.sheets > 0;
  const unit = tags ? 'tag' : 'record';
  const sheets = job.kind === 'tags' && job.sheets > 0
    ? ` · ${job.sheets} ${job.sheets === 1 ? 'sheet' : 'sheets'}` : '';
  const [preview, setPreview] = useState<Preview>();
  const [previewError, setPreviewError] = useState('');
  const [printError, setPrintError] = useState('');
  const [printing, setPrinting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const previewUrl = preview && preview.content === content && preview.page === page ? preview.url : '';

  useEffect(() => {
    setPreviewError('');
    setPrintError('');
    if (!desktop || !page || !count || !fits) return;

    let canceled = false;
    let url = '';
    const timer = window.setTimeout(async () => {
      try {
        const images = [...document.querySelectorAll<HTMLImageElement>('.print-document img')];
        await Promise.all(images.map(image => image.decode()));
        if (canceled) return;
        const bytes = await desktop.createPreview();
        if (canceled) return;
        url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        setPreview({ content, page, url });
      } catch {
        if (!canceled) setPreviewError('Could not generate the print preview.');
      }
    }, 180);
    return () => {
      canceled = true;
      window.clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
  }, [attempt, content, count, desktop, fits, page]);

  const printDisabled = !page || !count || !fits || printing || (!!desktop && !previewUrl);

  async function print() {
    if (!page || printDisabled) return;
    // Remove the embedded PDF while Chromium renders the print document.
    flushSync(() => { setPrinting(true); setPrintError(''); });
    try {
      if (!desktop) {
        window.print();
        return;
      }
      const result = await desktop.print(page, tags ? { actualSize: true } : undefined);
      if (!result.success && !/cancel/i.test(result.reason ?? '')) {
        setPrintError(result.reason || (tags ? 'Could not print the tags.' : 'Could not print the register. Check your printer settings.'));
      }
    } catch {
      setPrintError('Could not open printer settings. Check that a printer is available and try again.');
    } finally {
      setPrinting(false);
    }
  }

  function close() {
    if (!printing) onClose();
  }

  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && close()}
    onKeyDown={event => { if (event.key === 'Escape') close(); }}>
    <section className="print-preview-dialog" data-print-kind={job.kind} role="dialog" aria-modal="true" aria-labelledby="preview-title">
      <div className="modal-head">
        <div>
          <h2 id="preview-title">{tags ? 'Tag Generator' : 'Print Preview'}</h2>
          <p aria-live="polite">{count} {unit}{count === 1 ? '' : 's'} selected{sheets}</p>
        </div>
        <button className="drawer-close" autoFocus aria-label={tags ? 'Close tag generator' : 'Close print preview'}
          disabled={printing} onClick={close}><X size={18}/></button>
      </div>
      <div className="print-preview-body">
        <aside className="print-preview-controls" aria-label="Print layout">
          <div className="print-controls-scroll">
            <fieldset disabled={printing} className="print-layout-fields">
              {children}
              <div className="print-paper-fields">
                <label className="field"><span>Paper size</span>
                  <select value={layout.paper} onChange={event => onLayout({ ...layout, paper: event.target.value as PrintLayout['paper'] })}>
                    {Object.entries(PAPER_SIZES).map(([paper, size]) => <option key={paper} value={paper}>{size.label}</option>)}
                  </select>
                </label>
                <label className="field"><span>Orientation</span>
                  <select value={layout.orientation} onChange={event => onLayout({ ...layout, orientation: event.target.value as PrintLayout['orientation'] })}>
                    <option value="portrait">Portrait</option>
                    <option value="landscape">Landscape</option>
                  </select>
                </label>
              </div>
              <fieldset className="print-margin-fields">
                <legend>Margins (mm)</legend>
                <div>
                  {MARGIN_SIDES.map(side => <label className="field" key={side}>
                    <span>{side[0].toUpperCase() + side.slice(1)}</span>
                    <input type="number" min="0" step="any" value={layout.margins[side]}
                      onChange={event => onLayout({ ...layout, margins: { ...layout.margins, [side]: event.target.value } })} />
                  </label>)}
                </div>
              </fieldset>
            </fieldset>
            {onSetup && <button className="button button-light" onClick={onSetup} disabled={printing}><Settings2 size={15}/> Print setup</button>}
          </div>
          <div className="print-preview-footer">
            {printError && <div className="form-error" role="alert">{printError}</div>}
            {tags && <p>Use Actual size (100%) in the printer dialog.</p>}
            <button className="button button-primary print-preview-action" onClick={print} disabled={printDisabled}>
              {printing ? <LoaderCircle className="spin" size={16}/> : <Printer size={16}/>}
              {desktop ? 'Print…' : 'Open browser preview'}
            </button>
          </div>
        </aside>
        <div className="print-preview-pane">
          {printing ? <div className="preview-message" role="status">Opening printer settings…</div>
            : !count ? <div className="preview-message">{tags ? 'Select inventory records to preview their tags.' : 'No records match the active filters.'}</div>
            : !page ? <div className="preview-message">Enter four margins that fit on the selected paper.</div>
            : !fits ? <div className="preview-message">Choose margins and paper that leave room for at least one tag.</div>
            : !desktop ? <div className="preview-message">Open your browser’s print preview to see the pages.</div>
            : previewError ? <div className="preview-message" role="alert">{previewError}<button className="button button-light" onClick={() => setAttempt(attempt + 1)}>Retry preview</button></div>
            : previewUrl ? <iframe className="print-preview-frame" title={tags ? 'Paginated tag preview' : 'Paginated register preview'} src={`${previewUrl}#toolbar=0&navpanes=0&view=FitH`} />
            : <div className="preview-message" role="status"><LoaderCircle className="spin" size={18}/> Preparing preview…</div>}
        </div>
      </div>
    </section>
  </div>;
}

export function PrintRecordFilterFields({ filters, years, types, onFilters }: {
  filters: PrintRecordFilters; years: string[]; types: string[]; onFilters: (filters: PrintRecordFilters) => void;
}) {
  const typeSummary = filters.types.length > 1 ? `${filters.types.length} selected` : filters.types[0] ?? 'All types';
  const yearOptions = filters.year && !years.includes(filters.year) ? [filters.year, ...years] : years;
  const typeOptions = [...new Set([...types, ...filters.types])];

  function toggleType(type: string) {
    const selected = filters.types.includes(type) ? filters.types.filter(value => value !== type) : [...filters.types, type];
    onFilters({ ...filters, types: selected });
  }

  return <>
    <label className="field"><span>Inventory year</span>
      <select value={filters.year} onChange={event => onFilters({ ...filters, year: event.target.value })}>
        <option value="">All years</option>
        {yearOptions.map(year => <option key={year} value={year}>{year}</option>)}
      </select>
    </label>
    <details className="print-type-picker">
      <summary><span>Collection types</span><b>{typeSummary}</b><ChevronDown size={14}/></summary>
      <div className="print-type-options">
        <button type="button" className="button button-light" aria-pressed={!filters.types.length}
          onClick={() => onFilters({ ...filters, types: [] })}>All types</button>
        {typeOptions.map(type => <label key={type}>
          <input type="checkbox" checked={filters.types.includes(type)} onChange={() => toggleType(type)}/>
          <span>{type}</span>
        </label>)}
      </div>
    </details>
  </>;
}
