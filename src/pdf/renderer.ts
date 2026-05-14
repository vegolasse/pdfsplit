import type { PDFDocumentProxy } from 'pdfjs-dist';

/**
 * Render one page of a pdf.js document into a canvas at a target CSS width.
 * Returns the canvas element (created if not provided).
 */
export async function renderPageToCanvas(
  doc: PDFDocumentProxy,
  pageNumber: number,
  cssWidth: number,
  canvas?: HTMLCanvasElement,
): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNumber);
  const viewport1 = page.getViewport({ scale: 1 });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = (cssWidth / viewport1.width) * dpr;
  const viewport = page.getViewport({ scale });

  const c = canvas ?? document.createElement('canvas');
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  c.width = Math.floor(viewport.width);
  c.height = Math.floor(viewport.height);
  c.style.width = `${cssWidth}px`;
  c.style.height = `${(cssWidth * viewport.height) / viewport.width}px`;

  await page.render({ canvasContext: ctx, viewport, canvas: c }).promise;
  return c;
}

