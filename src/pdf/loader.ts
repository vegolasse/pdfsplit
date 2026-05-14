import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';

// The worker is copied into /public by vite.config.ts.
// import.meta.env.BASE_URL is a path like '/pdfsplit/' (prod) or '/' (dev),
// so we resolve it against the current origin to get an absolute URL.
const workerUrl = new URL(
  `${import.meta.env.BASE_URL}pdf.worker.min.mjs`,
  window.location.origin,
).toString();
(pdfjsLib as unknown as { GlobalWorkerOptions: { workerSrc: string } })
  .GlobalWorkerOptions.workerSrc = workerUrl;

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  // pdf.js mutates the buffer; pass a copy.
  const data = new Uint8Array(bytes);
  const task = pdfjsLib.getDocument({ data });
  return task.promise;
}

export type { PDFDocumentProxy };


