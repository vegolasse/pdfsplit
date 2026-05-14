import {
  PDFDocument,
  pushGraphicsState, popGraphicsState,
  beginText, endText,
  setTextRenderingMode, setTextMatrix, setFontAndSize,
  showText,
  TextRenderingMode,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
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
const OCR_DPI = 200;

/** JPEG quality for the final embedded half-images. */
const JPEG_QUALITY = 0.85;

/**
 * TTF used for the invisible OCR text overlay.
 *
 * We must embed a real font (with `/ToUnicode` CMap) — not one of pdf-lib's
 * 14 Standard Fonts — otherwise Apple's PDFKit (macOS Preview, Quick Look,
 * Safari's built-in viewer, Spotlight) refuses to index the invisible text.
 * Chrome/PDFium is more permissive and indexes Standard-Font text anyway,
 * which is why this used to "work in Chrome but not in Safari".
 *
 * Noto Sans Regular covers all Latin, Latin-Extended-A/B and common
 * punctuation we ever get out of the supported Tesseract languages
 * (eng/swe/deu/spa/fra). The TTF is fetched once on demand from a public
 * CDN and cached by the browser; pdf-lib subsets it so only the glyphs we
 * actually use are embedded in the output.
 */
const OCR_FONT_URL =
  'https://cdn.jsdelivr.net/gh/googlefonts/noto-fonts@main/hinted/ttf/NotoSans/NotoSans-Regular.ttf';

let ocrFontBytesP: Promise<Uint8Array> | null = null;
function loadOcrFontBytes(): Promise<Uint8Array> {
  if (!ocrFontBytesP) {
    ocrFontBytesP = (async () => {
      console.log('[split] fetching OCR overlay font…', OCR_FONT_URL);
      const t = performance.now();
      const r = await fetch(OCR_FONT_URL);
      if (!r.ok) throw new Error(`Font fetch failed: ${r.status} ${r.statusText}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      console.log(`[split] font loaded: ${buf.byteLength} bytes in ${(performance.now() - t).toFixed(0)}ms`);
      return buf;
    })().catch((e) => {
      // Allow a retry on next attempt if this one failed.
      ocrFontBytesP = null;
      throw e;
    });
  }
  return ocrFontBytesP;
}

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
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '(no UA)';
  console.log('[split] start', { dpi, ocrEnabled, inputBytes: bytes.byteLength, ua });
  const doc = await loadPdfJs(bytes);
  const S = doc.numPages;
  const N = 2 * S;
  const oddInput = S % 2 !== 0;
  console.log('[split] pdf loaded', { scanPages: S, outputHalves: N, oddInput });

  const scale = dpi / 72; // PDF user-space unit = 1/72 inch.

  // Spin up the OCR worker eagerly (in parallel with the first render) so
  // tesseract.js + lang data are loaded by the time we need it. Likewise,
  // kick off the overlay-font download in parallel.
  const ocr = ocrEnabled ? new Ocr('swe') : null;
  const ocrStart = ocr ? ocr.start() : Promise.resolve();
  const fontBytesP = ocrEnabled ? loadOcrFontBytes() : null;

  type Slot = { jpeg: Uint8Array; words: WordBox[] } | undefined;
  const slots: Slot[] = new Array(N);

  let done = 0;
  onProgress?.(done, N);

  // ---- Pipeline ----------------------------------------------------------
  // Tesseract runs in its own worker thread, so we can render and JPEG-encode
  // the *next* half on the main thread while it's recognising the previous
  // one. We keep at most one OCR job in flight (depth-1 pipeline) so peak
  // memory stays bounded (canvases get freed as soon as their OCR finishes).
  type Inflight = {
    ocrP: Promise<WordBox[]>;
    jpeg: Uint8Array;
    slotIdx: number;
    small: HTMLCanvasElement | null;
  };
  let inflight: Inflight | null = null;

  const drainInflight = async () => {
    if (!inflight) return;
    const words = await inflight.ocrP;
    slots[inflight.slotIdx] = { jpeg: inflight.jpeg, words };
    console.log('[split] slot done', { slotIdx: inflight.slotIdx, words: words.length, jpegBytes: inflight.jpeg.byteLength });
    if (inflight.small) {
      inflight.small.width = 0;
      inflight.small.height = 0;
    }
    inflight = null;
    done++;
    onProgress?.(done, N);
  };

  try {
    for (let i = 1; i <= S; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale });
      const fullW = Math.floor(vp.width);
      const fullH = Math.floor(vp.height);
      const halfW = Math.floor(fullW / 2);

      for (const isLeft of [true, false]) {
        const widthPx = isLeft ? halfW : (fullW - halfW);
        const heightPx = fullH;
        const xOffsetPx = isLeft ? 0 : -halfW;

        // 1. Render the half into a full-resolution canvas.
        const fullCanvas = document.createElement('canvas');
        fullCanvas.width = widthPx;
        fullCanvas.height = heightPx;
        const ctx = fullCanvas.getContext('2d', { alpha: false });
        if (!ctx) throw new Error('2D canvas context unavailable');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, widthPx, heightPx);
        const transform: [number, number, number, number, number, number] | undefined =
          xOffsetPx !== 0 ? [1, 0, 0, 1, xOffsetPx, 0] : undefined;
        await page.render({
          canvasContext: ctx,
          viewport: vp,
          canvas: fullCanvas,
          ...(transform ? { transform } : {}),
        } as Parameters<typeof page.render>[0]).promise;

        // 2. Downscale a copy for OCR (if enabled). The downscaled copy is
        //    also converted to grayscale, which is what Tesseract works in
        //    internally — doing it on the smaller buffer is cheap and saves
        //    Tesseract a step.
        let small: HTMLCanvasElement | null = null;
        if (ocr) {
          const ocrScale = OCR_DPI / RENDER_DPI;
          const ocrW = Math.max(1, Math.round(widthPx * ocrScale));
          const ocrH = Math.max(1, Math.round(heightPx * ocrScale));
          small = document.createElement('canvas');
          small.width = ocrW;
          small.height = ocrH;
          const sctx = small.getContext('2d', { alpha: false });
          if (sctx) {
            sctx.imageSmoothingEnabled = true;
            sctx.imageSmoothingQuality = 'high';
            sctx.fillStyle = '#fff';
            sctx.fillRect(0, 0, ocrW, ocrH);
            sctx.drawImage(fullCanvas, 0, 0, widthPx, heightPx, 0, 0, ocrW, ocrH);
            toGrayscaleInPlace(sctx, ocrW, ocrH);
          }
        }

        // Determine which output magazine page this half belongs to.
        const scanIdx = i - 1;
        const { left: leftPage, right: rightPage } = impositionFor(scanIdx, N);
        const slotIdx = (isLeft ? leftPage : rightPage) - 1;

        // 3. Drain the previous inflight OCR (depth-1 pipeline) BEFORE we
        //    queue a new one. This frees memory promptly and reports
        //    progress as halves actually complete.
        await drainInflight();

        // 4. Queue the OCR for this half (kick it off, don't await — it will
        //    run on the Tesseract worker thread while we keep going).
        if (ocr && small) {
          await ocrStart;
          const invScale = RENDER_DPI / OCR_DPI;
          const smallRef = small;
          const ocrP = ocr.recognizeWords(smallRef).then(
            (raw) => raw.map((w) => ({
              text: w.text,
              x0: w.x0 * invScale,
              y0: w.y0 * invScale,
              x1: w.x1 * invScale,
              y1: w.y1 * invScale,
            })),
            (err) => {
              // Don't fail the whole split if OCR breaks on a single half —
              // but make sure the failure is visible in the console rather
              // than producing a silently text-less PDF.
              console.error('OCR failed for slot', slotIdx, err);
              return [] as WordBox[];
            },
          );

          // 5. Encode JPEG. Runs concurrently with OCR on the small canvas.
          const jpeg = await canvasToJpeg(fullCanvas, JPEG_QUALITY);
          fullCanvas.width = 0;
          fullCanvas.height = 0;

          inflight = { ocrP, jpeg, slotIdx, small };
        } else {
          // No OCR: encode and store immediately.
          const jpeg = await canvasToJpeg(fullCanvas, JPEG_QUALITY);
          fullCanvas.width = 0;
          fullCanvas.height = 0;
          slots[slotIdx] = { jpeg, words: [] };
          done++;
          onProgress?.(done, N);
        }
      }
    }

    // Drain whatever OCR is still in flight at the end.
    await drainInflight();
  } finally {
    if (ocr) void ocr.stop();
  }

  // ----- Assemble output PDF ------------------------------------------------
  const totalWords = slots.reduce((n, s) => n + (s ? s.words.length : 0), 0);
  const slotsWithText = slots.reduce((n, s) => n + (s && s.words.length > 0 ? 1 : 0), 0);
  console.log('[split] OCR totals', { slotsWithText, slotsTotal: slots.filter(Boolean).length, totalWords });
  const out = await PDFDocument.create();
  // Register fontkit so we can embed a real TTF (required for a working
  // /ToUnicode CMap → searchable text in Apple PDFKit / macOS Preview).
  if (ocrEnabled) out.registerFontkit(fontkit);
  // Embed Noto Sans (subsetted) once for the invisible OCR text overlay.
  let helv: PDFFont | null = null;
  if (ocrEnabled && fontBytesP) {
    try {
      const fontBytes = await fontBytesP;
      helv = await out.embedFont(fontBytes, { subset: true });
    } catch (e) {
      console.error('[split] OCR font embed failed; output will not be searchable', e);
      helv = null;
    }
  }

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
  console.log('[split] done', { outputPages: out.getPageCount(), outputBytes: outBytes.byteLength });
  return { bytes: outBytes, outputPageCount: out.getPageCount(), oddInput };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  const blob: Blob = await new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/jpeg', quality)!,
  );
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Convert a 2D canvas context's pixels to grayscale in place. Uses Rec. 709
 * luma weights (0.2126 R, 0.7152 G, 0.0722 B). Alpha is left untouched.
 */
function toGrayscaleInPlace(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const y = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) | 0;
    px[i] = y; px[i + 1] = y; px[i + 2] = y;
  }
  ctx.putImageData(img, 0, 0);
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
  // Register the font in this page's /Resources/Font dict and grab the
  // resource key (a `PDFName` like `/F1-0`) that pdf-lib assigns. We MUST
  // use this key in the `Tf` operator below — not `font.name` (the
  // PostScript name). Apple's PDFKit (macOS Preview, Quick Look, Safari)
  // silently drops text that references a font name not present in the
  // page's font resource dict; Chrome/PDFium is lenient and resolves it via
  // BaseFont, which is why the same file used to be searchable in Chrome
  // but not in Preview.
  page.setFont(font);
  const fontKey =
    (page as unknown as { fontKey?: unknown }).fontKey ?? font.name;

  for (const w of words) {
    if (!w.text) continue;
    const bw = (w.x1 - w.x0) * pxToPt;
    const bh = (w.y1 - w.y0) * pxToPt;
    if (bw <= 0.1 || bh <= 0.1) continue;

    let encoded;
    try {
      encoded = font.encodeText(w.text);
    } catch {
      continue; // Char the font can't encode — skip.
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
      setFontAndSize(fontKey as string, 1),
      showText(encoded),
      endText(),
      popGraphicsState(),
    );
  }
}



