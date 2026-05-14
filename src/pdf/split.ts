import {
  PDFDocument,
  StandardFonts,
  pushGraphicsState, popGraphicsState,
  beginText, endText,
  setTextRenderingMode, setTextMatrix, setFontAndSize,
  showText,
  TextRenderingMode,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';
import type { Settings } from '../app/state';
import { loadPdf as loadPdfJs } from './loader';
import { Ocr, type WordBox } from './ocr';

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

/** Lower-resolution copy used as OCR input (much faster than the full image). */
const OCR_DPI = 150;

/** JPEG quality for the final embedded half-images. */
const JPEG_QUALITY = 0.85;

export async function splitMagazinePdf(
  bytes: Uint8Array,
  settings: Settings,
  onProgress?: SplitProgressCb,
): Promise<SplitResult> {
  return splitViaCanvas(bytes, RENDER_DPI, !!settings.generateText, onProgress);
}

// ---------------------------------------------------------------------------
// Imposition (saddle-stitched, duplex scan order)
// ---------------------------------------------------------------------------
function impositionFor(i: number, N: number): { left: number; right: number } {
  if (i % 2 === 0) return { left: N - i, right: i + 1 };
  return                  { left: i + 1, right: N - i };
}

// ---------------------------------------------------------------------------
// Split pipeline
// ---------------------------------------------------------------------------
async function splitViaCanvas(
  bytes: Uint8Array,
  dpi: number,
  ocrEnabled: boolean,
  onProgress?: SplitProgressCb,
): Promise<SplitResult> {
  const doc = await loadPdfJs(bytes);
  const S = doc.numPages;
  const N = 2 * S;
  const oddInput = S % 2 !== 0;

  const scale = dpi / 72; // PDF user-space unit = 1/72 inch.

  // Spin up the OCR worker eagerly (in parallel with the first render) so
  // tesseract.js + lang data are loaded by the time we need it.
  const ocr = ocrEnabled ? new Ocr() : null;
  const ocrStart = ocr ? ocr.start() : Promise.resolve();

  type Slot = { jpeg: Uint8Array; words: WordBox[] } | undefined;
  const slots: Slot[] = new Array(N);

  let done = 0;
  onProgress?.(done, N);

  try {
    for (let i = 1; i <= S; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale });
      const fullW = Math.floor(vp.width);
      const fullH = Math.floor(vp.height);
      const halfW = Math.floor(fullW / 2);

      // Left half: canvas IS the left rectangle; the right side of the page
      // falls outside the canvas and is naturally clipped.
      const left = await renderHalfAndMaybeOcr(page, vp, halfW, fullH, 0, ocr, ocrStart);
      done++;
      onProgress?.(done, N);

      // Right half: translate the page left by halfW so the visual-right
      // column lands in [0, fullW-halfW].
      const right = await renderHalfAndMaybeOcr(page, vp, fullW - halfW, fullH, -halfW, ocr, ocrStart);
      done++;
      onProgress?.(done, N);

      const scanIdx = i - 1;
      const { left: leftPage, right: rightPage } = impositionFor(scanIdx, N);
      if (leftPage  >= 1 && leftPage  <= N) slots[leftPage  - 1] = left;
      if (rightPage >= 1 && rightPage <= N) slots[rightPage - 1] = right;
    }
  } finally {
    if (ocr) void ocr.stop();
  }

  // ----- Assemble output PDF ------------------------------------------------
  const out = await PDFDocument.create();
  // Embed Helvetica once for the invisible OCR text overlay (only needed if
  // we have any words; embedding is cheap so we always do it when ocrEnabled).
  const helv = ocrEnabled ? await out.embedFont(StandardFonts.Helvetica) : null;

  for (const slot of slots) {
    if (!slot) continue;
    const img = await out.embedJpg(slot.jpeg);
    const p = out.addPage([A4_W, A4_H]);
    const s = Math.min(A4_W / img.width, A4_H / img.height);
    const drawW = img.width * s;
    const drawH = img.height * s;
    const drawX = (A4_W - drawW) / 2;
    const drawY = (A4_H - drawH) / 2;
    p.drawImage(img, { x: drawX, y: drawY, width: drawW, height: drawH });

    if (helv && slot.words.length > 0) {
      drawInvisibleOcrText(p, helv, slot.words, s, drawX, drawY, img.height);
    }
  }

  const outBytes = await out.save();
  return { bytes: outBytes, outputPageCount: out.getPageCount(), oddInput };
}

// ---------------------------------------------------------------------------
// Half rendering (+ optional OCR before JPEG-encoding)
// ---------------------------------------------------------------------------
async function renderHalfAndMaybeOcr(
  page: import('pdfjs-dist').PDFPageProxy,
  viewport: import('pdfjs-dist').PageViewport,
  widthPx: number,
  heightPx: number,
  xOffsetPx: number,
  ocr: Ocr | null,
  ocrReady: Promise<void>,
): Promise<{ jpeg: Uint8Array; words: WordBox[] }> {
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, widthPx, heightPx);

  const transform: [number, number, number, number, number, number] | undefined =
    xOffsetPx !== 0 ? [1, 0, 0, 1, xOffsetPx, 0] : undefined;

  await page.render({
    canvasContext: ctx,
    viewport,
    canvas,
    ...(transform ? { transform } : {}),
  } as Parameters<typeof page.render>[0]).promise;

  let words: WordBox[] = [];
  if (ocr) {
    await ocrReady;
    try {
      // Run OCR on a downscaled copy of the full-resolution canvas. The
      // bounding boxes come back in the downscaled pixel space; we scale
      // them back up so they line up with the 600 dpi image used for the
      // output PDF.
      const ocrScale = OCR_DPI / RENDER_DPI; // e.g. 150/600 = 0.25
      const ocrW = Math.max(1, Math.round(widthPx * ocrScale));
      const ocrH = Math.max(1, Math.round(heightPx * ocrScale));
      const small = document.createElement('canvas');
      small.width = ocrW;
      small.height = ocrH;
      const sctx = small.getContext('2d', { alpha: false });
      if (sctx) {
        sctx.imageSmoothingEnabled = true;
        sctx.imageSmoothingQuality = 'high';
        sctx.fillStyle = '#fff';
        sctx.fillRect(0, 0, ocrW, ocrH);
        sctx.drawImage(canvas, 0, 0, widthPx, heightPx, 0, 0, ocrW, ocrH);
        try {
          const smallWords = await ocr.recognizeWords(small);
          const invScale = 1 / ocrScale; // map OCR pixels → full-res pixels
          words = smallWords.map((w) => ({
            text: w.text,
            x0: w.x0 * invScale,
            y0: w.y0 * invScale,
            x1: w.x1 * invScale,
            y1: w.y1 * invScale,
          }));
        } catch {
          // OCR failure shouldn't block the page producing its image.
          words = [];
        }
      }
      // Free the downscaled canvas.
      small.width = 0;
      small.height = 0;
    } catch {
      words = [];
    }
  }

  const jpeg = await canvasToJpeg(canvas, JPEG_QUALITY);
  canvas.width = 0;
  canvas.height = 0;
  return { jpeg, words };
}

async function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  const blob: Blob = await new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/jpeg', quality)!,
  );
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Invisible OCR text overlay
// ---------------------------------------------------------------------------
//
// For each recognised word we push raw PDF operators that draw the word in
// "rendering mode 3" (invisible) at exactly the bbox position and size, so
// search and selection in any PDF reader line up with the visual glyphs.
//
//   q                       % save graphics state
//   BT                      % begin text
//   3 Tr                    % invisible
//   a 0 0 d e f Tm          % text matrix: horizontal scale a, vertical d,
//                           %              position (e, f)
//   /F1 1 Tf                % font with nominal size 1 (matrix carries scale)
//   <encoded text> Tj
//   ET
//   Q
function drawInvisibleOcrText(
  page: PDFPage,
  font: PDFFont,
  words: WordBox[],
  pxToPt: number,
  drawX: number,
  drawY: number,
  imgHeightPx: number,
): void {
  // Make sure the font is registered in this page's /Resources/Font dict.
  // The easiest way is to ask pdf-lib to "use" the font on the page once.
  page.setFont(font);

  for (const w of words) {
    if (!w.text) continue;
    const bw = (w.x1 - w.x0) * pxToPt;
    const bh = (w.y1 - w.y0) * pxToPt;
    if (bw <= 0.1 || bh <= 0.1) continue;

    let encoded;
    try {
      encoded = font.encodeText(w.text);
    } catch {
      continue; // Char outside Helvetica/WinAnsi — skip.
    }
    const natural1 = font.widthOfTextAtSize(w.text, 1);
    if (!Number.isFinite(natural1) || natural1 <= 0.001) continue;

    const a = bw / natural1;            // horizontal scale (text width = bw)
    const d = bh;                       // vertical scale ≈ font size in pts
    const x = drawX + w.x0 * pxToPt;    // left of bbox in PDF coords
    const y = drawY + (imgHeightPx - w.y1) * pxToPt; // bottom of bbox (y-up)

    page.pushOperators(
      pushGraphicsState(),
      beginText(),
      setTextRenderingMode(TextRenderingMode.Invisible),
      setTextMatrix(a, 0, 0, d, x, y),
      setFontAndSize(font.name, 1),
      showText(encoded),
      endText(),
      popGraphicsState(),
    );
  }
}



