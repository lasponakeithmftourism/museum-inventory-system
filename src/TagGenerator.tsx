import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { PrintPreview, PrintRecordFilterFields } from './PrintPreview';
import { paperDimensions, printGeometry, printPageCss } from './printLayout';
import { SheetPreview } from './SheetPreview';
import type { PrintGeometry, PrintLayout } from './printLayout';
import { compareInventoryIds, inventoryYears, matchesInventoryFilters } from './records';
import type { PrintRecordFilters, SavedItem } from './records';
import { DEFAULT_STICKER_LAYOUT, StickerLabel, StickerSizeField } from './StickerTag';
import type { StickerSize } from './StickerTag';

const TAG_GAP_MM = 2;

function sheetGrid(page: PrintGeometry | null, size: StickerSize) {
  if (!page) return { columns: 0, capacity: 0 };
  const { width, height } = paperDimensions(page);
  const pitch = size * 25.4 + TAG_GAP_MM;
  const slots = (span: number) => Math.floor((span + TAG_GAP_MM + 1e-6) / pitch);
  const columns = slots(width - page.margins.left - page.margins.right);
  const rows = slots(height - page.margins.top - page.margins.bottom);
  return { columns, capacity: columns * rows };
}

export function TagGenerator({ items, logo, onClose }: { items: SavedItem[]; logo: ReactElement; onClose: () => void }) {
  const [filters, setFilters] = useState<PrintRecordFilters>({ year: '', types: [] });
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [size, setSize] = useState<StickerSize>(1);
  const [layout, setLayout] = useState<PrintLayout>(DEFAULT_STICKER_LAYOUT);

  const years = useMemo(() => inventoryYears(items), [items]);
  const types = useMemo(() => [...new Set(items.map(item => item.itemType))].sort(), [items]);
  const matching = useMemo(() => items.filter(item => matchesInventoryFilters(item, filters)).sort(compareInventoryIds), [items, filters]);
  const selected = useMemo(() => matching.filter(item => selectedIds.has(item.id)), [matching, selectedIds]);
  const term = search.trim().toLowerCase();
  const shown = term ? matching.filter(item => item.inventoryId.toLowerCase().includes(term) || item.itemTitle.toLowerCase().includes(term)) : matching;

  const page = useMemo(() => printGeometry(layout), [layout]);
  const { columns, capacity } = sheetGrid(page, size);
  const sheets = capacity ? Math.ceil(selected.length / capacity) : 0;
  const sheetGrids = useMemo(() => Array.from({ length: sheets }, (_, index) => {
    const start = index * capacity;
    return <div className="sticker-sheet" key={index} style={{ gridTemplateColumns: `repeat(${columns}, ${size}in)`, gap: `${TAG_GAP_MM}mm` }}>
      {selected.slice(start, start + capacity).map(item => <StickerLabel key={item.id} item={item} size={size} logo={logo}/>)}
    </div>;
  }), [capacity, columns, logo, selected, sheets, size]);
  const content = useMemo(() => <div className="print-document sticker-print-document">{sheetGrids}</div>, [sheetGrids]);

  function toggleRecord(id: string) {
    setSelectedIds(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectShown() {
    setSelectedIds(previous => new Set([...previous, ...shown.map(item => item.id)]));
  }

  return <>
    {page && <style>{printPageCss(page)}</style>}
    <PrintPreview job={{ kind: 'tags', count: selected.length, sheets }} content={content}
      layout={layout} page={page} onLayout={setLayout} onClose={onClose}
      browserPreview={page && <SheetPreview page={page} sheets={sheetGrids} label="Tag sheet preview"/>}>
      <div className="tag-filter-fields">
        <PrintRecordFilterFields filters={filters} years={years} types={types} onFilters={setFilters}/>
      </div>
      <fieldset className="tag-record-picker">
        <legend>Inventory records</legend>
        <label className="field"><span>Find by inventory no. or name</span>
          <input type="search" value={search} onChange={event => setSearch(event.target.value)}/>
        </label>
        <div className="tag-record-actions">
          <button type="button" className="button button-light" onClick={selectShown}
            disabled={shown.every(item => selectedIds.has(item.id))}>Select shown</button>
          <button type="button" className="button button-light" onClick={() => setSelectedIds(new Set())}
            disabled={!selectedIds.size}>Clear selection</button>
        </div>
        <div className="tag-record-list">
          {shown.map(item => <label key={item.id} className="tag-record-option">
            <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleRecord(item.id)}/>
            <span>
              <b>{item.inventoryId}</b><small>{item.itemType}</small>
              <span>{item.itemTitle || 'Untitled record'}</span>
            </span>
          </label>)}
          {shown.length === 0 && <p className="tag-record-empty">No matching records.</p>}
        </div>
      </fieldset>
      <StickerSizeField size={size} onSize={setSize}/>
    </PrintPreview>
  </>;
}
