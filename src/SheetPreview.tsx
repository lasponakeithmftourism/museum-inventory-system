import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { MARGIN_SIDES, paperDimensions, PIXELS_PER_MM } from './printLayout';
import type { PrintGeometry } from './printLayout';

export function SheetPreview({ page, sheets, label }: {
  page: PrintGeometry; sheets: ReactElement[]; label: string;
}) {
  const { width, height } = paperDimensions(page);
  const stack = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);

  useLayoutEffect(() => {
    const element = stack.current;
    if (!element) return;
    setAvailableWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => setAvailableWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const paperWidth = width * PIXELS_PER_MM;
  const paperHeight = height * PIXELS_PER_MM;
  const scale = Math.min(1, availableWidth / paperWidth);
  const frame = { width: paperWidth * scale, height: paperHeight * scale };
  const paper = {
    width: paperWidth, height: paperHeight,
    padding: MARGIN_SIDES.map(side => `${page.margins[side]}mm`).join(' '),
    transform: `scale(${scale})`,
  };

  return <div className="sheet-preview" role="region" aria-label={label} tabIndex={0}>
    <div className="sheet-preview-stack" ref={stack}>
      {sheets.map((sheet, index) => <div className="sheet-preview-frame" key={index} style={frame}>
        <div className="sheet-preview-paper" role="group" aria-label={`Sheet ${index + 1} of ${sheets.length}`} style={paper}>
          {sheet}
        </div>
      </div>)}
    </div>
  </div>;
}
