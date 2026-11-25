import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { LoaderCircle, Printer, X } from 'lucide-react';
import { PAPER_SIZES, printGeometry, printPageCss } from './printLayout';
import type { PrintLayout } from './printLayout';
import type { Item } from './records';

export type StickerSize = 1 | 2;
type PaperSize = keyof typeof PAPER_SIZES;

export const DEFAULT_STICKER_LAYOUT: PrintLayout = {
  paper: 'Letter', orientation: 'portrait',
  margins: { top: '12.7', right: '12.7', bottom: '12.7', left: '12.7' },
};

export function StickerSizeField({ size, onSize, autoFocus, disabled }: {
  size: StickerSize; onSize: (size: StickerSize) => void; autoFocus?: boolean; disabled?: boolean;
}) {
  return <label className="field"><span>Tag size</span>
    <select autoFocus={autoFocus} value={size} disabled={disabled} onChange={event => onSize(event.target.value === '2' ? 2 : 1)}>
      <option value={1}>1 × 1 in</option>
      <option value={2}>2 × 2 in</option>
    </select>
  </label>;
}

export function StickerLabel({ item, size, logo }: { item: Item; size: StickerSize; logo: ReactElement }) {
  const fields = [
    ['Inventory No.', item.inventoryId],
    ['Name', item.itemTitle],
    ['Category', item.itemType],
    ['Acquisition', item.acquisitionMethod],
  ];
  return <article className="sticker-tag" data-size={size} aria-label="Collection sticker tag">
    {logo}
    <div className="sticker-tag-fields">
      {fields.map(([label, value]) => <p className="sticker-tag-field" key={label}>
        <strong>{label}:</strong> {value.trim() || '—'}
      </p>)}
    </div>
    <p className="sticker-tag-notice"><strong>PLEASE DO NOT<br/>REMOVE THIS TAG!</strong></p>
  </article>;
}

export function StickerTagDialog({ item, logo, onClose }: { item: Item; logo: ReactElement; onClose: () => void }) {
  const [size, setSize] = useState<StickerSize>(1);
  const [paper, setPaper] = useState<PaperSize>(DEFAULT_STICKER_LAYOUT.paper);
  const [printing, setPrinting] = useState(false);
  const [shortened, setShortened] = useState(false);
  const [error, setError] = useState('');
  const preview = useRef<HTMLDivElement>(null);
  const printContent = useRef<HTMLDivElement>(null);
  const page = printGeometry({ ...DEFAULT_STICKER_LAYOUT, paper });

  useLayoutEffect(() => {
    const fields = [...(preview.current?.querySelectorAll('.sticker-tag-field') ?? [])];
    setShortened(fields.some(field => field.scrollHeight > field.clientHeight + 1 || field.scrollWidth > field.clientWidth + 1));
  }, [item, size]);

  async function printTag() {
    if (!page || printing) return;
    setPrinting(true);
    setError('');
    try {
      await printContent.current?.querySelector('img')?.decode();
      if (!window.museumPrinting) {
        window.print();
        return;
      }
      const result = await window.museumPrinting.print(page, { actualSize: true });
      if (!result.success && !/cancel/i.test(result.reason ?? '')) {
        setError(result.reason || 'Could not print the sticker tag.');
      }
    } catch {
      setError('Could not print the sticker tag. Check your printer settings and try again.');
    } finally {
      setPrinting(false);
    }
  }

  function close() {
    if (!printing) onClose();
  }

  return <>
    {page && <style>{printPageCss(page)}</style>}
    <div ref={printContent} className="print-document sticker-print-document">
      <StickerLabel item={item} size={size} logo={logo}/>
    </div>
    <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && close()}
      onKeyDown={event => { if (event.key === 'Escape') close(); }}>
      <section className="item-modal sticker-tag-dialog" role="dialog" aria-modal="true" aria-labelledby="sticker-tag-title">
        <div className="modal-head">
          <h2 id="sticker-tag-title">Sticker tag</h2>
          <button className="drawer-close" type="button" aria-label="Close sticker tag" onClick={close} disabled={printing}>
            <X size={18}/>
          </button>
        </div>
        <div className="form-scroll">
          <div className="form-grid sticker-tag-options">
            <StickerSizeField size={size} onSize={setSize} autoFocus disabled={printing}/>
            <label className="field"><span>Paper size</span>
              <select value={paper} onChange={event => setPaper(event.target.value as PaperSize)} disabled={printing}>
                {Object.entries(PAPER_SIZES).map(([key, dimensions]) => <option key={key} value={key}>{dimensions.label}</option>)}
              </select>
            </label>
          </div>
          <div className="sticker-tag-preview" ref={preview}>
            <StickerLabel item={item} size={size} logo={logo}/>
          </div>
          {shortened && <p className="sticker-tag-hint" role="status">Long values are shortened at this size.</p>}
          {error && <div className="form-error modal-error" role="alert">{error}</div>}
        </div>
        <div className="modal-footer">
          <span>Use Actual size (100%) in the printer dialog.</span>
          <button className="button button-primary" type="button" onClick={printTag} disabled={!page || printing}>
            {printing ? <LoaderCircle className="spin" size={15}/> : <Printer size={15}/>}
            {printing ? 'Opening printer…' : 'Print tag'}
          </button>
        </div>
      </section>
    </div>
  </>;
}
