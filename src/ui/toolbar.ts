import { h, downloadBlob } from '../app/dom';
import { store } from '../app/state';
import { clearPdf, savePdf, saveSettings, MAX_STORED_BYTES } from '../app/storage';
import { splitMagazinePdf } from '../pdf/split';
import { t } from '../i18n';
import { toast } from './toast';

/**
 * The toolbar is the row of contextual actions below the tabs:
 *   - Original tab → [ Upload ] [ file-chip × ]
 *   - Split    tab → [ Download ] [ ⚙︎ ]
 */
export function buildToolbar(): HTMLElement {
  const root = h('div', { class: 'toolbar' });

  const render = () => {
    const s = store.get();
    root.innerHTML = '';
    if (s.view === 'original') {
      root.append(uploadButton(), fileChip());
    } else if (s.view === 'converted') {
      const share = shareButton();
      if (share) root.append(share);
      root.append(downloadButton(), ocrToggle());
    }
    // Help view: no toolbar items.
  };

  store.subscribe(render);
  render();
  return root;
}

// ---------- Original tab ---------------------------------------------------

function uploadButton(): HTMLElement {
  const input = h('input', {
    type: 'file',
    accept: 'application/pdf,.pdf',
    class: 'sr-only',
    onchange: async (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) await ingestFile(f);
      (e.target as HTMLInputElement).value = '';
    },
  }) as HTMLInputElement;

  const btn = h('button', {
    class: 'btn',
    type: 'button',
    'data-i18n': 'header.upload',
    onclick: () => input.click(),
  }, t('header.upload'));

  return h('span', {}, input, btn);
}

function fileChip(): HTMLElement {
  const name = store.get().fileName;
  if (!name) return h('span', { class: 'hidden' });
  return h('div', { class: 'file-chip' },
    h('span', { class: 'name', title: name }, name),
    h('button', {
      type: 'button',
      'aria-label': t('chip.clear'),
      onclick: async () => {
        await clearPdf();
        store.set({ fileName: null, originalBytes: null, convertedBytes: null, view: 'original' });
      },
    }, '×'),
  );
}

// ---------- Split tab ------------------------------------------------------

function downloadButton(): HTMLElement {
  const s = store.get();
  const disabled = !s.convertedBytes;
  return h('button', {
    class: 'btn',
    type: 'button',
    disabled,
    'data-i18n': 'header.download',
    onclick: () => {
      const cur = store.get();
      if (!cur.convertedBytes) return;
      const baseName = (cur.fileName ?? 'document').replace(/\.pdf$/i, '');
      downloadBlob(cur.convertedBytes, `${baseName}-split.pdf`);
    },
  }, t('header.download'));
}

/**
 * Native-share button. Only rendered when `navigator.share` is available
 * (essentially: mobile Safari / Chrome / Edge and a few desktop builds).
 *
 * Returns `null` when sharing isn't supported, so the caller can simply
 * skip it. The icon is platform-aware: iOS-style "tray + up arrow" on
 * iOS/iPadOS, Android-style "three connected dots" everywhere else
 * (Android, ChromeOS, desktop Edge, etc.) so the button visually matches
 * the rest of the OS the user sees on their device.
 */
function shareButton(): HTMLElement | null {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
    return null;
  }
  const s = store.get();
  const disabled = !s.convertedBytes;
  const label = t('header.share');
  return h('button', {
    class: 'btn btn-icon',
    type: 'button',
    disabled,
    'aria-label': label,
    title: label,
    'data-i18n-aria': 'header.share',
    onclick: async () => {
      const cur = store.get();
      if (!cur.convertedBytes) return;
      const baseName = (cur.fileName ?? 'document').replace(/\.pdf$/i, '');
      const fileName = `${baseName}-split.pdf`;
      // Make a fresh ArrayBuffer copy: some browsers reject a File built on
      // a SharedArrayBuffer-backed or transferred Uint8Array.
      const bytes = cur.convertedBytes.slice();
      const file = new File([bytes], fileName, { type: 'application/pdf' });
      const data: ShareData = { files: [file], title: fileName };
      try {
        // Prefer file-sharing if the platform supports it for this file.
        const canShareFiles =
          typeof navigator.canShare === 'function' ? navigator.canShare(data) : true;
        if (canShareFiles) {
          await navigator.share(data);
        } else {
          // Fallback: share just the file name as text (very rare path).
          await navigator.share({ title: fileName, text: fileName });
        }
      } catch (err) {
        // AbortError = user dismissed the share sheet; not an error.
        if ((err as DOMException)?.name !== 'AbortError') {
          toast(t('toast.splitFail', { msg: (err as Error).message }), 'error', 4000);
        }
      }
    },
  }, shareIcon());
}

/**
 * Inline SVG share icon matching the host platform. Detected via UA:
 *   - iOS / iPadOS  → iOS share glyph (square with up-arrow)
 *   - everything else → Material "share" glyph (three connected dots)
 *
 * Modern iPad Safari often reports `MacIntel` as platform; we treat any
 * touch-enabled "Mac" as iPadOS too.
 */
function shareIcon(): SVGSVGElement {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const platform = typeof navigator !== 'undefined' ? navigator.platform : '';
  const isIPadOSMasquerade =
    platform === 'MacIntel' &&
    typeof navigator !== 'undefined' &&
    (navigator.maxTouchPoints ?? 0) > 1;
  const isIos = /iPad|iPhone|iPod/.test(ua) || isIPadOSMasquerade;

  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '28');
  svg.setAttribute('height', '28');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.style.display = 'block';

  if (isIos) {
    // iOS share: rectangular tray with an arrow pointing up out the top.
    // Stroked, rounded; matches SF Symbol "square.and.arrow.up".
    svg.innerHTML = `
      <g fill="none" stroke="currentColor" stroke-width="1.9"
         stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3v12" />
        <path d="M8 7l4-4 4 4" />
        <path d="M6 11H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1" />
      </g>`;
  } else {
    // Material share: three filled dots connected by two lines.
    svg.innerHTML = `
      <g fill="currentColor">
        <circle cx="18" cy="5"  r="2.6" />
        <circle cx="6"  cy="12" r="2.6" />
        <circle cx="18" cy="19" r="2.6" />
        <path d="M8.3 11l7.6 -4.4 0.8 1.4 -7.6 4.4z" />
        <path d="M8.3 13l7.6  4.4 0.8 -1.4 -7.6 -4.4z" />
      </g>`;
  }
  return svg;
}

/**
 * macOS-style toggle for the "Also generate text (OCR)" setting.
 * - Persists to IndexedDB on change.
 * - If a converted PDF already exists, clears it and re-runs the split so
 *   the new setting takes effect immediately.
 */
function ocrToggle(): HTMLElement {
  const s = store.get();
  const splitting = !!s.splitProgress;
  const input = h('input', {
    type: 'checkbox',
    checked: s.settings.generateText,
    disabled: splitting,
    'aria-label': t('settings.generateText'),
    onchange: async (e: Event) => {
      const next = (e.target as HTMLInputElement).checked;
      const settings = { ...store.get().settings, generateText: next };
      // Throw away the cached split so the new setting takes effect.
      store.set({ settings, convertedBytes: null, splitProgress: null });
      void saveSettings(settings);
      void runSplitIfNeeded();
    },
  }) as HTMLInputElement;

  return h('label', { class: splitting ? 'toggle toggle--disabled' : 'toggle' },
    input,
    h('span', { class: 'toggle-track' }, h('span', { class: 'toggle-knob' })),
    h('span', { class: 'toggle-label', 'data-i18n': 'settings.generateText' }, t('settings.generateText')),
  );
}

// ---------- File ingestion --------------------------------------------------

async function ingestFile(file: File): Promise<void> {
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    store.set({
      fileName: file.name,
      originalBytes: buf,
      convertedBytes: null,
      view: 'original',
    });
    const saved = await savePdf(file.name, buf);
    if (!saved && buf.byteLength > MAX_STORED_BYTES) {
      toast(t('toast.tooBig', { max: Math.round(MAX_STORED_BYTES / 1024 / 1024) }), 'warn', 5000);
    }
  } catch (err) {
    toast(t('toast.invalid', { msg: (err as Error).message }), 'error', 5000);
  }
}

/**
 * Run the split conversion. Called automatically when the user switches to
 * the Split tab without an existing converted document.
 */
export async function runSplitIfNeeded(): Promise<void> {
  const s = store.get();
  if (!s.originalBytes || s.convertedBytes || s.splitProgress) return;
  store.set({ splitProgress: { done: 0, total: 0 } });
  try {
    const res = await splitMagazinePdf(
      s.originalBytes,
      s.settings,
      (done, total) => store.set({ splitProgress: { done, total } }),
    );
    if (res.oddInput) {
      toast(t('toast.oddPages', { n: Math.floor(res.outputPageCount / 2) }), 'warn', 6000);
    }
    store.set({ convertedBytes: res.bytes, splitProgress: null });
    toast(t('toast.splitDone', { n: res.outputPageCount }), 'info', 3000);
  } catch (err) {
    store.set({ splitProgress: null });
    toast(t('toast.splitFail', { msg: (err as Error).message }), 'error', 6000);
  }
}

