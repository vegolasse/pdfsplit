import { PDFDocument } from 'pdf-lib';
import type { Settings } from '../app/state';
import { loadPdf as loadPdfJs } from './loader';

export type SplitResult = {
  bytes: Uint8Array;
  outputPageCount: number;
  /** True if the input scan count is odd (non-standard booklet imposition). */
  oddInput: boolean;
};

export type SplitProgressCb = (done: number, total: number) => void;

// A4 portrait in PDF points (1 pt = 1/72 inch). 210 × 297 mm.
const A4_W = 595.2756;
const A4_H = 841.8898;

/** Fixed output resolution. Each cropped A5 half is rendered at this DPI. */
const RENDER_DPI = 600;

/** JPEG quality for the final embedded half-images. */
const JPEG_QUALITY = 0.85;

export async function splitMagazinePdf(
  bytes: Uint8Array,
  _settings: Settings,
  onProgress?: SplitProgressCb,
): Promise<SplitResult> {
  // `_settings` is reserved for future OCR / "Also generate text" pass.
  return splitViaCanvas(bytes, RENDER_DPI, onProgress);
}

// ---------------------------------------------------------------------------
// Imposition
// ---------------------------------------------------------------------------
//
// Saddle-stitched booklet of N pages, scanned duplex in standard order:
//   scan 0 (sheet 1 outer): [ N    |  1   ]   ← visual left | right
//   scan 1 (sheet 1 inner): [ 2    |  N-1 ]
//   scan 2 (sheet 2 outer): [ N-2  |  3   ]
//   scan 3 (sheet 2 inner): [ 4    |  N-3 ]
//   ...
function impositionFor(i: number, N: number): { left: number; right: number } {
  if (i % 2 === 0) return { left: N - i, right: i + 1 };
  return                  { left: i + 1, right: N - i };
}

// ---------------------------------------------------------------------------
// Split pipeline
// ---------------------------------------------------------------------------
//
// pdf.js renders each scan to a canvas in its correct visual orientation
// (handles /Rotate and content-stream rotation transparently). To avoid
// running into per-canvas pixel-count limits at 600 dpi (especially on
// mobile Safari), we render each VISUAL HALF independently using a viewport
// translation transform, then JPEG-encode and free the canvas immediately.

async function splitViaCanvas(
  bytes: Uint8Array,
  dpi: number,
  onProgress?: SplitProgressCb,
): Promise<SplitResult> {
  const doc = await loadPdfJs(bytes);
  const S = doc.numPages;
  const N = 2 * S;
  const oddInput = S % 2 !== 0;

  const scale = dpi / 72; // PDF user-space unit = 1/72 inch.

  type Slot = { jpeg: Uint8Array } | undefined;
  const slots: Slot[] = new Array(N);

  let done = 0;
  onProgress?.(done, N);

  for (let i = 1; i <= S; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale });
    const fullW = Math.floor(vp.width);
    const fullH = Math.floor(vp.height);
    const halfW = Math.floor(fullW / 2);

    // --- Left half: canvas is the left rectangle; the right side of the
    // page falls outside the canvas and is naturally clipped.
    const leftJpeg = await renderHalfToJpeg(page, vp, halfW, fullH, 0);
    done++;
    onProgress?.(done, N);

    // --- Right half: translate the page left by halfW so that what was the
    // right column lands in [0, fullW-halfW].
    const rightJpeg = await renderHalfToJpeg(page, vp, fullW - halfW, fullH, -halfW);
    done++;
    onProgress?.(done, N);

    const scanIdx = i - 1;
    const { left, right } = impositionFor(scanIdx, N);
    if (left  >= 1 && left  <= N) slots[left  - 1] = { jpeg: leftJpeg  };
    if (right >= 1 && right <= N) slots[right - 1] = { jpeg: rightJpeg };
  }

  // --- Assemble output PDF ----------------------------------------------
  const out = await PDFDocument.create();
  for (const slot of slots) {
    if (!slot) continue;
    const img = await out.embedJpg(slot.jpeg);
    const p = out.addPage([A4_W, A4_H]);
    const s = Math.min(A4_W / img.width, A4_H / img.height);
    const drawW = img.width * s;
    const drawH = img.height * s;
    p.drawImage(img, {
      x: (A4_W - drawW) / 2,
      y: (A4_H - drawH) / 2,
      width: drawW,
      height: drawH,
    });
  }

  const outBytes = await out.save();
  return { bytes: outBytes, outputPageCount: out.getPageCount(), oddInput };
}

/**
 * Render one visual half of a pdf.js page directly into a canvas sized to
 * just that half. `xOffsetPx` is the pixel translation applied to the page
 * before rasterization (0 for the left half, -halfWidthPx for the right).
 * Returns the JPEG bytes and frees the canvas immediately afterwards.
 */
async function renderHalfToJpeg(
  page: import('pdfjs-dist').PDFPageProxy,
  viewport: import('pdfjs-dist').PageViewport,
  widthPx: number,
  heightPx: number,
  xOffsetPx: number,
): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, widthPx, heightPx);

  // pdf.js render accepts a `transform` (CSS-style 6-element matrix) applied
  // to the canvas context before the page is drawn.
  const transform: [number, number, number, number, number, number] | undefined =
    xOffsetPx !== 0 ? [1, 0, 0, 1, xOffsetPx, 0] : undefined;

  await page.render({
    canvasContext: ctx,
    viewport,
    canvas,
    ...(transform ? { transform } : {}),
  } as Parameters<typeof page.render>[0]).promise;

  const jpeg = await canvasToJpeg(canvas, JPEG_QUALITY);
  // Best-effort free of the (large) canvas backing store on iOS Safari.
  canvas.width = 0;
  canvas.height = 0;
  return jpeg;
}

async function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  const blob: Blob = await new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/jpeg', quality)!,
  );
  return new Uint8Array(await blob.arrayBuffer());
}



