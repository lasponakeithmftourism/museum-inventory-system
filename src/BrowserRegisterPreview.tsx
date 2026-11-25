import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { LoaderCircle } from 'lucide-react';
import { PrintPreview } from './PrintPreview';
import type { PrintPreviewProps } from './PrintPreview';
import { SheetPreview } from './SheetPreview';
import { paperDimensions, PIXELS_PER_MM } from './printLayout';
import type { PrintGeometry } from './printLayout';
import { paginateRegister } from './registerPagination';

type RegisterPages = { content: ReactElement; page: PrintGeometry; sheets: HTMLDivElement[] | null };

function RegisterSheet({ sheet }: { sheet: HTMLDivElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.replaceChildren(...Array.from(sheet.childNodes, child => child.cloneNode(true)));
  }, [sheet]);
  return <div ref={ref} className="register-sheet" style={{ width: sheet.style.width, height: sheet.style.height }}/>;
}

export function BrowserRegisterPreview(props: PrintPreviewProps) {
  const { content, job: { count }, page } = props;
  const source = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<RegisterPages>();

  useEffect(() => {
    if (!count || !page || !source.current || !measure.current) return;
    const template = source.current;
    const workArea = measure.current;
    let canceled = false;

    async function prepare(geometry: PrintGeometry) {
      await Promise.allSettled(Array.from(template.querySelectorAll('img'), image => image.decode()));
      if (canceled) return;
      const { width, height } = paperDimensions(geometry);
      const { left, right, top, bottom } = geometry.margins;
      // Leave a pixel for rounding when the browser lays out the printed page.
      const printableWidth = Math.floor((width - left - right) * PIXELS_PER_MM) - 1;
      const printableHeight = Math.floor((height - top - bottom) * PIXELS_PER_MM) - 1;
      const sheets = paginateRegister(template, workArea, printableWidth, printableHeight);
      setPages({ content, page: geometry, sheets });
    }

    void prepare(page).catch(() => {
      if (!canceled) setPages({ content, page, sheets: null });
    });
    return () => { canceled = true; };
  }, [content, count, page]);

  const current = pages?.content === content && pages.page === page ? pages : undefined;
  const sheets = current?.sheets?.map((sheet, index) => <RegisterSheet sheet={sheet} key={index}/>);
  const browserPreview = sheets && page
    ? <SheetPreview page={page} sheets={sheets} label="Register print preview"/>
    : current
      ? <div className="preview-message">This layout needs more room. Adjust the paper settings or use the browser’s print preview.</div>
      : <div className="preview-message" role="status"><LoaderCircle className="spin" size={18}/> Preparing preview…</div>;

  return <>
    <div ref={source} hidden>{content}</div>
    <div ref={measure} className="register-preview-measure" aria-hidden="true"/>
    <PrintPreview {...props} content={sheets ? <div className="print-document">{sheets}</div> : content}
      browserPreview={browserPreview} previewReady={current !== undefined}/>
  </>;
}
