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

/**
 * Output resolution. Each cropped A5 half is rendered at this DPI on every
 * platform. 300 dpi is the industry-standard "print quality" target, keeps
 * peak per-canvas memory at ~35 MB for an A4 half (fits comfortably inside
 * iOS Safari's per-tab memory budget), and is also high enough for the OCR
 * pass to run directly on the same image — so we don't have to allocate a
 * separate downscaled OCR canvas at all.
 */
const RENDER_DPI = 300;

/** JPEG quality for the final embedded half-images. */
const JPEG_QUALITY = 0.75;

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
  // memory stays bounded — only one full-resolution canvas is alive at a
  // time, plus a couple of JPEG byte buffers.
  //
  // The OCR pass runs directly on the same 300 dpi image that gets embedded
  // in the output PDF (as a JPEG Blob). That's plenty of resolution for
  // Tesseract and it removes the need for a second downscaled canvas.
  type Inflight = {
    ocrP: Promise<WordBox[]>;
    jpeg: Uint8Array;
    slotIdx: number;
  };
  let inflight: Inflight | null = null;

  const drainInflight = async () => {
    if (!inflight) return;
    const words = await inflight.ocrP;
    slots[inflight.slotIdx] = { jpeg: inflight.jpeg, words };
    console.log('[split] slot done', {
      slotIdx: inflight.slotIdx,
      words: words.length,
      jpegBytes: inflight.jpeg.byteLength,
    });
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

        // 2. Pull the raw pixels out (for OCR) and encode a small JPEG
        //    (for PDF embedding) from the same canvas. The order matters:
        //
        //      a) getImageData copies pixels into a separate Uint8ClampedArray
        //         so OCR has a stable buffer that survives the canvas being
        //         freed; tesseract.js receives those pixels directly — no
        //         JPEG/PNG round-trip and no in-worker image decode (much
        //         less wasted RAM and CPU than passing the compressed JPEG).
        //      b) toBlob produces the JPEG that goes into the final PDF.
        //      c) The canvas backing store is released immediately.
        //
        //    Peak main-thread memory at this point is one raw RGBA buffer
        //    (~35 MB for an A5 half at 300 dpi) plus a ~300 KB JPEG —
        //    nothing else.
        const imageData = ctx.getImageData(0, 0, widthPx, heightPx);
        const jpegBlob = await canvasToBlob(fullCanvas, 'image/jpeg', JPEG_QUALITY);
        fullCanvas.width = 0;
        fullCanvas.height = 0;
        const jpeg = new Uint8Array(await jpegBlob.arrayBuffer());

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
        if (ocr) {
          await ocrStart;
          const ocrP = ocr.recognizeWords(imageData).then(
            (raw) => raw,
            (err) => {
              // Don't fail the whole split if OCR breaks on a single half —
              // but make sure the failure is visible in the console rather
              // than producing a silently text-less PDF.
              console.error('OCR failed for slot', slotIdx, err);
              return [] as WordBox[];
            },
          );
          inflight = { ocrP, jpeg, slotIdx };
        } else {
          // No OCR: store immediately.
          slots[slotIdx] = { jpeg, words: [] };
          done++;
          onProgress?.(done, N);
        }

        // Yield to the runtime between halves so iOS Safari can run GC and
        // release the freed canvas/ImageData memory before we allocate the
        // next batch. Without this, peak RSS grows page-over-page and the
        // tab eventually gets killed by the WKWebView memory watchdog.
        await new Promise<void>((r) => setTimeout(r, 0));
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

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((res, rej) =>
    canvas.toBlob(
      (b) => (b ? res(b) : rej(new Error(`canvas.toBlob(${type}) failed`))),
      type,
      quality,
    ),
  );
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



