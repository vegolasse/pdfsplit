import { get, set, del } from 'idb-keyval';
import type { Settings } from './state';

const PDF_KEY = 'lastPdf';
const SETTINGS_KEY = 'settings';

export const MAX_STORED_BYTES = 100 * 1024 * 1024; // 100 MB

export type StoredPdf = {
  name: string;
  bytes: ArrayBuffer;
  savedAt: number;
};

export async function savePdf(name: string, bytes: Uint8Array): Promise<boolean> {
  if (bytes.byteLength > MAX_STORED_BYTES) return false;
  // Copy into a fresh ArrayBuffer that owns its memory (avoid SharedArrayBuffer issues).
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const record: StoredPdf = { name, bytes: ab, savedAt: Date.now() };
  try {
    await set(PDF_KEY, record);
    return true;
  } catch (err) {
    console.warn('savePdf failed', err);
    return false;
  }
}

export async function loadPdf(): Promise<StoredPdf | null> {
  try {
    const v = await get<StoredPdf>(PDF_KEY);
    return v ?? null;
  } catch {
    return null;
  }
}

export async function clearPdf(): Promise<void> {
  try { await del(PDF_KEY); } catch { /* ignore */ }
}

export async function saveSettings(s: Settings): Promise<void> {
  try { await set(SETTINGS_KEY, s); } catch { /* ignore */ }
}

export async function loadSettings(): Promise<Settings | null> {
  try {
    const v = await get<Settings>(SETTINGS_KEY);
    return v ?? null;
  } catch { return null; }
}


