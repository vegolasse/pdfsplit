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

