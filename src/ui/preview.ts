import { h } from '../app/dom';
import { store } from '../app/state';
import { loadPdf, type PDFDocumentProxy } from '../pdf/loader';
import { renderPageToCanvas } from '../pdf/renderer';
import { t, onLangChange } from '../i18n';
import { toast } from './toast';

type DocCache = { bytesRef: Uint8Array; doc: PDFDocumentProxy } | null;

export function buildPreview(): HTMLElement {
  const root = h('section', { class: 'glass preview', 'aria-live': 'polite' });

  let originalDoc: DocCache = null;
  let convertedDoc: DocCache = null;
  let renderToken = 0;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target as HTMLElement;
      observer.unobserve(el);
      const pageNum = parseInt(el.dataset.page!, 10);
      const which = el.dataset.which as 'original' | 'converted';
      const token = renderToken;
      void (async () => {
        const cache = which === 'original' ? originalDoc : convertedDoc;
        if (!cache) return;
        const cssWidth = Math.min(root.clientWidth - 32, 820);
        try {
          const c = await renderPageToCanvas(cache.doc, pageNum, cssWidth);
          if (token !== renderToken) return;
          el.innerHTML = '';
          el.appendChild(c);
        } catch (err) {
          el.textContent = `Error: ${(err as Error).message}`;
        }
      })();
    }
  }, { root, rootMargin: '400px 0px' });

  async function rebuild() {
    renderToken++;
    observer.disconnect();
    root.innerHTML = '';

    const s = store.get();
    const which = s.view;
    const bytes = which === 'original' ? s.originalBytes : s.convertedBytes;

    if (!bytes) {
      const titleKey = which === 'original' ? 'empty.title' : 'empty.convertedTitle';
      const bodyKey = which === 'original' ? 'empty.body' : 'empty.convertedBody';
      root.appendChild(
        h('div', { class: 'empty-state' },
          h('h2', { 'data-i18n': titleKey }, t(titleKey)),
          h('p', { 'data-i18n': bodyKey }, t(bodyKey)),
        ),
      );
      return;
    }

    // Load (or reuse) the pdf.js document
    let cache = which === 'original' ? originalDoc : convertedDoc;
    if (!cache || cache.bytesRef !== bytes) {
      try {
        const doc = await loadPdf(bytes);
        cache = { bytesRef: bytes, doc };
        if (which === 'original') originalDoc = cache;
        else convertedDoc = cache;
        if (which === 'original') {
          toast(t('toast.loaded', { n: doc.numPages }), 'info', 2500);
        }
      } catch (err) {
        root.appendChild(h('div', { class: 'empty-state' },
          h('p', {}, t('toast.invalid', { msg: (err as Error).message })),
        ));
        return;
      }
    }

    // Build placeholders and observe
    for (let i = 1; i <= cache.doc.numPages; i++) {
      const slot = h('div', {
        class: 'preview-page placeholder',
        dataset: { page: String(i), which },
      }, `${i} / ${cache.doc.numPages}`);
      root.appendChild(slot);
      observer.observe(slot);
    }
  }

  // React to state changes that affect what we render
  store.subscribe((s, prev) => {
    if (s.originalBytes !== prev.originalBytes) originalDoc = null;
    if (s.convertedBytes !== prev.convertedBytes) convertedDoc = null;
    if (
      s.view !== prev.view ||
      s.originalBytes !== prev.originalBytes ||
      s.convertedBytes !== prev.convertedBytes
    ) {
      void rebuild();
    }
  });

  onLangChange(() => void rebuild());

  void rebuild();
  return root;
}


