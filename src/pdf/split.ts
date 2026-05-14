import { PDFDocument } from 'pdf-lib';
import type { Settings } from '../app/state';
import { loadPdf as loadPdfJs } from './loader';

export type SplitResult = {
  bytes: Uint8Array;
  outputPageCount: number;
  /** True if the input scan count is odd (non-standard booklet imposition). */
  oddInput: boolean;
};

// A4 portrait in PDF points (1 pt = 1/72 inch). 210 × 297 mm.
const A4_W = 595.2756;
const A4_H = 841.8898;

export async function splitMagazinePdf(
  bytes: Uint8Array,
  settings: Settings,
): Promise<SplitResult> {
  // Both modes share the same pipeline (render → crop → embed). They differ
  // only in the image codec used when the cropped half is embedded into the
  // output PDF:
  //   - "lossless"  → PNG  (zero-loss raster)
  //   - "raster"    → JPEG (smaller files, configurable quality via DPI)
  const format: 'png' | 'jpeg' = settings.fidelity === 'lossless' ? 'png' : 'jpeg';
  return splitViaCanvas(bytes, settings.dpi, format);
}

// ---------------------------------------------------------------------------
// Imposition
// ---------------------------------------------------------------------------
//
// A saddle-stitched booklet of N pages has N/4 physical sheets. After
// destapling each sheet is a flat A4 page with two A5 pages side-by-side.
// When scanned duplex in order:
//
//   scan 0 (sheet 1 outer): [ N    |  1   ]   ← visual left | right
//   scan 1 (sheet 1 inner): [ 2    |  N-1 ]
//   scan 2 (sheet 2 outer): [ N-2  |  3   ]
//   scan 3 (sheet 2 inner): [ 4    |  N-3 ]
//   ...
//
// Generalised, for 0-indexed scan i with S scans (N = 2·S magazine pages):
//   visual-left  page = (i even) ? (N - i)  : (i + 1)
//   visual-right page = (i even) ? (i + 1)  : (N - i)
//
function impositionFor(i: number, N: number): { left: number; right: number } {
  if (i % 2 === 0) return { left: N - i, right: i + 1 };
  return                  { left: i + 1, right: N - i };
}

// ---------------------------------------------------------------------------
// Split pipeline
// ---------------------------------------------------------------------------
//
// pdf.js renders each scanned page to a canvas in its correct VISUAL
// orientation — it transparently handles /Rotate, content-stream rotation
// matrices, scanner quirks, etc. We then:
//
//   1. Cut the canvas vertically down the middle (visual left | right).
//   2. Encode each half as PNG (lossless) or JPEG (raster mode).
//   3. Place each half into the right slot of the output PDF based on
//      booklet imposition.
//   4. Each output page is a fresh A4 portrait page; the embedded image is
//      scaled (preserving aspect ratio) to fill the A4 page.
//
// No code rotates anything — orientation is whatever pdf.js produces from
// the source page.

async function splitViaCanvas(
  bytes: Uint8Array,
  dpi: number,
  format: 'png' | 'jpeg',
): Promise<SplitResult> {
  const doc = await loadPdfJs(bytes);
  const S = doc.numPages;
  const N = 2 * S;
  const oddInput = S % 2 !== 0;

  const scale = dpi / 72; // PDF user-space unit = 1/72 inch.

  type Slot = { data: Uint8Array } | undefined;
  const slots: Slot[] = new Array(N);

  for (let i = 1; i <= S; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context unavailable');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;

    const halfPx = Math.floor(canvas.width / 2);
    const heightPx = canvas.height;

    const leftData  = await cropEncode(canvas, 0,      0, halfPx,                    heightPx, format);
    const rightData = await cropEncode(canvas, halfPx, 0, canvas.width - halfPx,     heightPx, format);

    const scanIdx = i - 1;
    const { left, right } = impositionFor(scanIdx, N);
    if (left  >= 1 && left  <= N) slots[left  - 1] = { data: leftData  };
    if (right >= 1 && right <= N) slots[right - 1] = { data: rightData };
  }

  const out = await PDFDocument.create();
  for (const slot of slots) {
    if (!slot) continue;
    const img = format === 'png'
      ? await out.embedPng(slot.data)
      : await out.embedJpg(slot.data);
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

async function cropEncode(
  src: HTMLCanvasElement,
  sx: number, sy: number, sw: number, sh: number,
  format: 'png' | 'jpeg',
): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  c.width = sw; c.height = sh;
  const ctx = c.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, sw, sh);
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  const quality = format === 'jpeg' ? 0.92 : undefined;
  const blob: Blob = await new Promise((res, rej) =>
    c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), mime, quality)!,
  );
  return new Uint8Array(await blob.arrayBuffer());
}



