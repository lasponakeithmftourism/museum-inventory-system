export type PrintFormat = 'summary' | 'full';

export const PAPER_SIZES = {
  Letter: { label: 'Letter · 8.5 × 11 in', width: 215.9, height: 279.4 },
  A4: { label: 'A4 · 210 × 297 mm', width: 210, height: 297 },
  'Long bond': { label: 'Long bond · 8.5 × 13 in', width: 215.9, height: 330.2 },
  Legal: { label: 'Legal · 8.5 × 14 in', width: 215.9, height: 355.6 },
  A3: { label: 'A3 · 297 × 420 mm', width: 297, height: 420 },
};

export const MARGIN_SIDES = ['top', 'right', 'bottom', 'left'] as const;
type MarginSide = typeof MARGIN_SIDES[number];

export type PrintLayout = {
  paper: keyof typeof PAPER_SIZES;
  orientation: 'portrait' | 'landscape';
  margins: Record<MarginSide, string>;
};

export type PrintGeometry = {
  width: number;
  height: number;
  landscape: boolean;
  margins: Record<MarginSide, number>;
};

export const DEFAULT_PRINT_LAYOUT: PrintLayout = {
  paper: 'Letter', orientation: 'landscape',
  margins: { top: '6.35', right: '12', bottom: '6.35', left: '12' },
};

export function printGeometry(layout: PrintLayout): PrintGeometry | null {
  const { width, height } = PAPER_SIZES[layout.paper];
  const landscape = layout.orientation === 'landscape';
  const margins = {
    top: Number(layout.margins.top), right: Number(layout.margins.right),
    bottom: Number(layout.margins.bottom), left: Number(layout.margins.left),
  };
  const paperWidth = landscape ? height : width;
  const paperHeight = landscape ? width : height;

  if (MARGIN_SIDES.some(side => !layout.margins[side].trim() || !Number.isFinite(margins[side]) || margins[side] < 0)
      || margins.left + margins.right >= paperWidth || margins.top + margins.bottom >= paperHeight) return null;

  return { width, height, landscape, margins };
}

export function printPageCss(page: PrintGeometry) {
  const width = page.landscape ? page.height : page.width;
  const height = page.landscape ? page.width : page.height;
  const margin = MARGIN_SIDES.map(side => `${page.margins[side]}mm`).join(' ');
  return `@page { size: ${width}mm ${height}mm; margin: ${margin}; }`;
}
