import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
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

/**
 * iOS Safari (≤ iOS 18) ships incomplete / buggy implementations of
 * `OffscreenCanvas` 2D contexts and `createImageBitmap` for some image
 * payloads. pdf.js detects these APIs as "present" and uses them to speed
 * up rendering, but several internal paths then throw a bare
 * `TypeError: Type error` with no stack. We force pdf.js onto its plain
 * `HTMLCanvasElement` rendering path on those devices.
 *
 * We keep the fast path on every other platform (desktop, Android Chrome,
 * etc.) where these APIs are reliable.
 */
function isAppleMobileWebKit(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS often reports as "MacIntel" but with touch support.
  if (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1) return true;
  return false;
}

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  // pdf.js mutates the buffer; pass a copy.
  const data = new Uint8Array(bytes);
  const iosWorkarounds = isAppleMobileWebKit();
  const task = pdfjsLib.getDocument({
    data,
    // Avoid the buggy iOS Safari 2D-OffscreenCanvas path.
    isOffscreenCanvasSupported: iosWorkarounds ? false : undefined,
    // Don't try to load system fonts from `/Library/Fonts/...` etc. on iOS.
    useSystemFonts: iosWorkarounds ? false : undefined,
    // Disable hardware-accelerated canvas (`willReadFrequently=false`); the
    // GPU path on iOS sometimes refuses certain blends pdf.js emits.
    enableHWA: iosWorkarounds ? false : undefined,
  } as Parameters<typeof pdfjsLib.getDocument>[0]);
  return task.promise;
}

export type { PDFDocumentProxy };


