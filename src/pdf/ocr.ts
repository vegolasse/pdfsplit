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

type AnyWorker = {
  recognize(
    image: HTMLCanvasElement,
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
      const ts: typeof import('tesseract.js') = await import('tesseract.js');
      // tesseract.js v5+ / v6+: createWorker(lang) auto-loads core + langdata.
      const worker = await ts.createWorker(this.lang);
      return worker as unknown as AnyWorker;
    })();
    await this.workerP;
  }

  /**
   * Run OCR on an off-screen canvas. Returns one entry per recognized word.
   * Empty or zero-area boxes are filtered out.
   */
  async recognizeWords(canvas: HTMLCanvasElement): Promise<WordBox[]> {
    if (!this.workerP) await this.start();
    const worker = await this.workerP!;
    const res = await worker.recognize(canvas, undefined, { blocks: true });
    return flattenWords(res.data);
  }

  async stop(): Promise<void> {
    if (!this.workerP) return;
    try { (await this.workerP).terminate(); } catch { /* ignore */ }
    this.workerP = null;
  }
}

// --- Helpers ---------------------------------------------------------------

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

