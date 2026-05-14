import { en, sv, de, es, fr, type Dict } from './dicts';

export type LangCode = 'en' | 'sv' | 'de' | 'es' | 'fr';

const DICTS: Record<LangCode, Dict> = { en, sv, de, es, fr };
export const SUPPORTED: LangCode[] = ['en', 'sv', 'de', 'es', 'fr'];

const STORAGE_KEY = 'pdfsplit.lang';

let current: LangCode = 'en';
const listeners = new Set<(lang: LangCode) => void>();

export function detectLanguage(): LangCode {
  const stored = localStorage.getItem(STORAGE_KEY) as LangCode | null;
  if (stored && SUPPORTED.includes(stored)) return stored;
  const navLangs = navigator.languages ?? [navigator.language];
  for (const raw of navLangs) {
    const code = raw.toLowerCase().split('-')[0] as LangCode;
    if (SUPPORTED.includes(code)) return code;
  }
  return 'en';
}

export function getLang(): LangCode { return current; }

export function setLang(lang: LangCode): void {
  if (!SUPPORTED.includes(lang)) return;
  current = lang;
  localStorage.setItem(STORAGE_KEY, lang);
  document.documentElement.lang = lang;
  applyI18n(document.body);
  listeners.forEach((l) => l(lang));
}

export function onLangChange(cb: (lang: LangCode) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function t(key: string, params?: Record<string, string | number>): string {
  const dict = DICTS[current] ?? en;
  let str = dict[key] ?? en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return str;
}

/**
 * Walks the DOM and applies translations to nodes marked with
 * `data-i18n="key"` (text content) and `data-i18n-attr="attr:key[,attr:key]"`.
 */
export function applyI18n(root: ParentNode = document.body): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n!;
    el.textContent = t(key);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-attr]').forEach((el) => {
    const spec = el.dataset.i18nAttr!;
    for (const pair of spec.split(',')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  });
  // Also re-translate <title> if present
  const titleEl = document.querySelector<HTMLTitleElement>('title[data-i18n]');
  if (titleEl) titleEl.textContent = t(titleEl.dataset.i18n!);
}

export function initI18n(): void {
  current = detectLanguage();
  document.documentElement.lang = current;
  applyI18n(document.body);
}

