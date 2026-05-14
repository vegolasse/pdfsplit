/**
 * Tesseract.js wrapper.
 *
 * - Loads tesseract.js lazily on first use (via dynamic `import`) so the main
 *   app bundle stays small.
 * - Reuses a single worker for the whole split run.
 * - Returns one flat array of words with bounding boxes per image.
 *
 * Bounding-box coordinates use the SAME pixel coordinate system as the input
 * canvas/image: origin at top-left, x grows right, y grows down.
 */

import { getLang } from '../i18n';

export type WordBox = {
  text: string;
  /** Pixel coords in the source image (origin top-left). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

/** Map our app language code to a Tesseract language pack. */
const LANG_MAP: Record<string, string> = {
  en: 'eng',
  sv: 'swe',
  de: 'deu',
  es: 'spa',
  fr: 'fra',
};

type RecognizeImage = HTMLCanvasElement | Blob | ImageData | string;
type AnyWorker = {
  recognize(
    image: RecognizeImage,
    options?: Record<string, unknown>,
    output?: Record<string, unknown>,
  ): Promise<{ data: unknown }>;
  terminate(): Promise<void>;
};

export class Ocr {
  private workerP: Promise<AnyWorker> | null = null;
  readonly lang: string;

  constructor(lang?: string) {
    this.lang = lang ?? LANG_MAP[getLang()] ?? 'eng';
  }

  /** Eagerly start the worker (downloads the language data the first time). */
  async start(): Promise<void> {
    if (this.workerP) return;
    this.workerP = (async () => {
      log('importing tesseract.js…');
      const t0 = performance.now();
      const ts: typeof import('tesseract.js') = await import('tesseract.js');
      log(`tesseract.js imported in ${(performance.now() - t0).toFixed(0)}ms`);
      // tesseract.js v6+ / v7+: createWorker(lang, oem, options).
      //   - oem = 1 → LSTM-only, smaller model + faster recognition than the
      //              default LSTM+legacy combo.
      //   - langPath → "fast" trained-data, optimised for speed over accuracy.
      //                Matches the LSTM-only OEM.
      // Both choices follow the official Tesseract.js performance guide.
      log(`creating worker (lang=${this.lang}, oem=1, fast langPath)…`);
      const t1 = performance.now();
      const worker = await ts.createWorker(this.lang, 1, {
        langPath: 'https://tessdata.projectnaptha.com/4.0.0_fast',
        logger: (m: unknown) => log('tess', m),
        errorHandler: (e: unknown) => log('tess ERROR', e),
      } as Record<string, unknown>);
      log(`worker ready in ${(performance.now() - t1).toFixed(0)}ms`);
      return worker as unknown as AnyWorker;
    })();
    try {
      await this.workerP;
    } catch (e) {
      log('worker start FAILED', e);
      this.workerP = null;
      throw e;
    }
  }

  /**
   * Run OCR on an off-screen canvas. Returns one entry per recognized word.
   * Empty or zero-area boxes are filtered out.
   *
   * Safari note: passing an `HTMLCanvasElement` directly into tesseract.js
   * v6/v7 goes through an `OffscreenCanvas` / `transferToImageBitmap` path
   * that misbehaves in Safari (produces a blank/empty result silently). We
   * convert the canvas to a PNG `Blob` first, which works reliably in all
   * browsers.
   */
  async recognizeWords(canvas: HTMLCanvasElement): Promise<WordBox[]> {
    if (!this.workerP) await this.start();
    const worker = await this.workerP!;
    log(`encoding ${canvas.width}×${canvas.height} canvas to PNG…`);
    const tBlob = performance.now();
    const blob: Blob = await new Promise((res, rej) =>
      canvas.toBlob(
        (b) => (b ? res(b) : rej(new Error('canvas.toBlob returned null'))),
        'image/png',
      ),
    );
    log(`PNG blob: ${blob.size} bytes, type=${blob.type}, encoded in ${(performance.now() - tBlob).toFixed(0)}ms`);
    const tRec = performance.now();
    let res: { data: unknown };
    try {
      res = await worker.recognize(blob, undefined, { blocks: true });
    } catch (e) {
      log('worker.recognize THREW', e);
      throw e;
    }
    log(`recognize() resolved in ${(performance.now() - tRec).toFixed(0)}ms`);
    summarizeRecognizeData(res.data);
    const words = flattenWords(res.data);
    log(`flattened to ${words.length} word boxes`);
    return words;
  }

  async stop(): Promise<void> {
    if (!this.workerP) return;
    try { (await this.workerP).terminate(); } catch { /* ignore */ }
    this.workerP = null;
  }
}

// --- Helpers ---------------------------------------------------------------

/**
 * Debug logger. Enabled by default; turn off with
 * `localStorage.pdfsplitOcrDebug = '0'`. Each line is prefixed so it's easy
 * to grep for in the browser console.
 */
function log(...args: unknown[]): void {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('pdfsplitOcrDebug') === '0') return;
  } catch { /* ignore */ }
  // eslint-disable-next-line no-console
  console.log('[ocr]', ...args);
}

/**
 * Print a structural summary of the data object returned by
 * `worker.recognize`. Helps detect Safari-specific empty/odd shapes.
 */
function summarizeRecognizeData(data: unknown): void {
  if (!data || typeof data !== 'object') {
    log('recognize data: <none>', data);
    return;
  }
  const d = data as AnyObj;
  const textPreview = typeof d.text === 'string' ? (d.text as string).slice(0, 120) : undefined;
  const summary = {
    keys: Object.keys(d),
    textLen: typeof d.text === 'string' ? (d.text as string).length : null,
    textPreview,
    confidence: d.confidence,
    blocks: Array.isArray(d.blocks) ? (d.blocks as unknown[]).length : (d.blocks ? 'present' : 'absent'),
    words: Array.isArray(d.words) ? (d.words as unknown[]).length : (d.words ? 'present' : 'absent'),
  };
  log('recognize data summary:', summary);
}

type AnyObj = { [k: string]: unknown };

function asArr(v: unknown): AnyObj[] {
  return Array.isArray(v) ? (v as AnyObj[]) : [];
}

/**
 * Walk tesseract.js's nested blocks → paragraphs → lines → words structure
 * and return a flat list of word boxes. Tolerates missing levels by also
 * accepting a top-level `words` array.
 */
function flattenWords(data: unknown): WordBox[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as AnyObj;
  const out: WordBox[] = [];

  const pushWord = (w: AnyObj) => {
    const text = String(w.text ?? '').trim();
    if (!text) return;
    const bb = (w.bbox ?? {}) as AnyObj;
    const x0 = Number(bb.x0), y0 = Number(bb.y0);
    const x1 = Number(bb.x1), y1 = Number(bb.y1);
    if (!Number.isFinite(x0 + y0 + x1 + y1)) return;
    if (x1 <= x0 || y1 <= y0) return;
    out.push({ text, x0, y0, x1, y1 });
  };

  // Newer/flat shape.
  for (const w of asArr(d.words)) pushWord(w);
  // Hierarchical shape.
  for (const blk of asArr(d.blocks)) {
    for (const para of asArr(blk.paragraphs)) {
      for (const line of asArr(para.lines)) {
        for (const w of asArr(line.words)) pushWord(w);
      }
    }
  }
  return out;
}

