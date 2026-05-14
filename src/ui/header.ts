import { h } from '../app/dom';
import { store } from '../app/state';
import { clearPdf, savePdf, MAX_STORED_BYTES } from '../app/storage';
import { splitMagazinePdf } from '../pdf/split';
import { downloadBlob } from '../app/dom';
import { t, applyI18n, getLang, setLang, SUPPORTED, type LangCode } from '../i18n';
import { toast } from './toast';
import { openSettingsModal } from './settings';

export function buildHeader(): HTMLElement {
  // Hidden file input
  const fileInput = h('input', {
    type: 'file',
    accept: 'application/pdf,.pdf',
    class: 'sr-only',
    onchange: async (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) await ingestFile(f);
      (e.target as HTMLInputElement).value = '';
    },
  }) as HTMLInputElement;

  const uploadBtn = h('button', {
    class: 'btn btn-primary',
    type: 'button',
    'data-i18n': 'header.upload',
    onclick: () => fileInput.click(),
  }, t('header.upload'));

  const splitBtn = h('button', {
    class: 'btn',
    type: 'button',
    disabled: true,
    'data-i18n': 'header.split',
    onclick: () => void runSplit(),
  }, t('header.split')) as HTMLButtonElement;

  const downloadBtn = h('button', {
    class: 'btn',
    type: 'button',
    disabled: true,
    'data-i18n': 'header.download',
    onclick: () => {
      const s = store.get();
      if (!s.convertedBytes) return;
      const baseName = (s.fileName ?? 'document').replace(/\.pdf$/i, '');
      downloadBlob(s.convertedBytes, `${baseName}-split.pdf`);
    },
  }, t('header.download')) as HTMLButtonElement;

  const settingsBtn = h('button', {
    class: 'btn btn-icon',
    type: 'button',
    'aria-label': t('header.settings'),
    'data-i18n-attr': 'aria-label:header.settings,title:header.settings',
    title: t('header.settings'),
    onclick: () => openSettingsModal(),
  }, '⚙︎');

  const langSelect = h('select', {
    class: 'lang-select',
    'aria-label': t('header.language'),
    'data-i18n-attr': 'aria-label:header.language',
    onchange: (e: Event) => setLang((e.target as HTMLSelectElement).value as LangCode),
  },
    ...SUPPORTED.map((code) =>
      h('option', { value: code, selected: code === getLang(), 'data-i18n': `lang.${code}` }, t(`lang.${code}`)),
    ),
  ) as HTMLSelectElement;

  const fileChip = h('div', { class: 'file-chip hidden' });

  const actions = h('div', { class: 'header-actions' },
    fileInput, uploadBtn, splitBtn, downloadBtn, fileChip, settingsBtn, langSelect,
  );

  const header = h('header', { class: 'glass header' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-dot' }), h('span', { 'data-i18n': 'app.title' }, t('app.title'))),
    actions,
  );

  // Reactively reflect state
  store.subscribe((s, prev) => {
    splitBtn.disabled = !s.originalBytes;
    downloadBtn.disabled = !s.convertedBytes;
    if (s.fileName !== prev.fileName) renderChip(fileChip, s.fileName);
  });
  renderChip(fileChip, store.get().fileName);

  return header;
}

function renderChip(chip: HTMLElement, name: string | null) {
  chip.innerHTML = '';
  if (!name) { chip.classList.add('hidden'); return; }
  chip.classList.remove('hidden');
  chip.append(
    h('span', { class: 'name', title: name }, name),
    h('button', {
      type: 'button',
      'aria-label': t('chip.clear'),
      'data-i18n-attr': 'aria-label:chip.clear',
      onclick: async () => {
        await clearPdf();
        store.set({ fileName: null, originalBytes: null, convertedBytes: null, view: 'original' });
      },
    }, '×'),
  );
}

export async function ingestFile(file: File): Promise<void> {
  toast(t('toast.loading'), 'info', 1500);
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
    // Page count toast comes from preview after pdf.js loads; emit a generic one here.
  } catch (err) {
    toast(t('toast.invalid', { msg: (err as Error).message }), 'error', 5000);
  }
}

async function runSplit() {
  const s = store.get();
  if (!s.originalBytes) { toast(t('toast.noFile'), 'warn'); return; }
  toast(t('toast.splitting'), 'info', 1500);
  try {
    const res = await splitMagazinePdf(s.originalBytes, s.settings);
    if (res.oddInput) {
      // We don't have the input count handy here, but pdf-lib gave us output count = 2*S.
      toast(t('toast.oddPages', { n: res.outputPageCount / 2 }), 'warn', 6000);
    }
    store.set({ convertedBytes: res.bytes, view: 'converted' });
    toast(t('toast.splitDone', { n: res.outputPageCount }), 'info', 3000);
  } catch (err) {
    toast(t('toast.splitFail', { msg: (err as Error).message }), 'error', 6000);
  }
}

// Re-apply translations to the header when the language changes elsewhere.
export function refreshHeader(): void {
  applyI18n(document.body);
}

