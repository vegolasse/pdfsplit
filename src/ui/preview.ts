import { h } from '../app/dom';
import { store } from '../app/state';
import { loadPdf, type PDFDocumentProxy } from '../pdf/loader';
import { renderPageToCanvas } from '../pdf/renderer';
import { t } from '../i18n';
import { toast } from './toast';
import { buildHelp } from './help';

/**
 * Preview area. Renders the current PDF's pages **progressively**: each page
 * appears as soon as it has been rendered, rather than waiting for the user
 * to scroll it into view.
 *
 * While a split is in progress (Split tab + state.splitProgress != null) the
 * preview shows a progress bar instead of placeholders.
 *
 * State changes (view switch, new file, conversion done) abort the in-flight
 * render via a token, and a fresh pass begins.
 */
export function buildPreview(): HTMLElement {
  const root = h('section', { class: 'preview', 'aria-live': 'polite' });

  let docCache: {
    bytesRef: Uint8Array;
    which: 'original' | 'converted';
    doc: PDFDocumentProxy;
  } | null = null;

  let renderToken = 0;
  let progressEl: HTMLElement | null = null;

  /**
   * Tear down a cached pdf.js document on the worker thread. We MUST call
   * `.destroy()` — just dropping the JS reference leaves all of the worker's
   * parsed structures (operator lists, font caches, decoded images, and the
   * raw input bytes) alive for the rest of the tab's life, because the
   * worker doesn't see GC events from the main thread. Without this the
   * pdf.js worker keeps growing every time we re-load or switch files.
   */
  async function destroyDoc(d: PDFDocumentProxy | null | undefined): Promise<void> {
    if (!d) return;
    try {
      await (d as unknown as { destroy?: () => Promise<void> | void }).destroy?.();
    } catch (e) {
      console.warn('[preview] doc.destroy failed', e);
    }
  }

  async function evictCache(): Promise<void> {
    if (!docCache) return;
    const old = docCache.doc;
    docCache = null;
    await destroyDoc(old);
  }

  function showProgress(done: number, total: number) {
    if (!progressEl) {
      progressEl = h('div', {
        class: 'split-progress',
        role: 'status',
        'aria-live': 'polite',
      });
      root.innerHTML = '';
      root.appendChild(progressEl);
    }
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    progressEl.innerHTML = '';
    progressEl.append(
      h('div', { class: 'split-progress-label' },
        t('split.progress', { n: done, total }),
      ),
      h('div', { class: 'split-progress-bar' },
        h('div', { class: 'split-progress-fill', style: { width: `${pct}%` } }),
      ),
    );
  }

  function clearProgress() {
    progressEl = null;
  }

  async function rebuild() {
    const myToken = ++renderToken;

    const s = store.get();
    const which = s.view;

    // Help tab: static content, no PDF involved. Free the cached doc — we
    // won't be rendering pages while the help is on screen.
    if (which === 'help') {
      clearProgress();
      root.innerHTML = '';
      root.appendChild(buildHelp());
      await evictCache();
      return;
    }

    // If we're on the Split tab and a split is running, show the progress
    // bar and bail. The split pipeline has its own pdf.js doc on the worker
    // and the preview won't render anything until the split is done, so we
    // proactively destroy the preview's old doc here. That avoids having
    // TWO copies of the input PDF (preview's + split's) parsed in the
    // worker at the same time, which was the bulk of the worker's RSS.
    if (which === 'converted' && s.splitProgress) {
      showProgress(s.splitProgress.done, s.splitProgress.total);
      await evictCache();
      return;
    }
    clearProgress();
    root.innerHTML = '';

    const bytes = which === 'original' ? s.originalBytes : s.convertedBytes;

    if (!bytes) {
      const titleKey = which === 'original' ? 'empty.title' : 'empty.convertedTitle';
      const bodyKey  = which === 'original' ? 'empty.body'  : 'empty.convertedBody';
      root.appendChild(h('div', { class: 'empty-state' },
        h('h2', {}, t(titleKey)),
        h('p',  {}, t(bodyKey)),
      ));
      await evictCache();
      return;
    }

    if (!docCache || docCache.bytesRef !== bytes || docCache.which !== which) {
      // Destroy the previous doc on the worker BEFORE loading the new one,
      // so we don't briefly hold two parsed PDFs (the old + the new) in
      // worker memory at the same time.
      await evictCache();
      try {
        const doc = await loadPdf(bytes);
        if (myToken !== renderToken) {
          // Token was bumped while we were loading → throw the new doc away
          // properly instead of just leaving it on the worker.
          await destroyDoc(doc);
          return;
        }
        docCache = { bytesRef: bytes, which, doc };
        if (which === 'original') {
          toast(t('toast.loaded', { n: doc.numPages }), 'info', 2500);
        }
      } catch (err) {
        console.error('[preview] loadPdf failed', err);
        root.appendChild(h('div', { class: 'empty-state' },
          h('p', {}, t('toast.invalid', { msg: describeError(err) })),
        ));
        return;
      }
    }

    const doc = docCache.doc;
    const cssWidth = Math.min(root.clientWidth - 32, 720);

    const slots: HTMLDivElement[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const slot = h('div', { class: 'preview-page placeholder' }, `${i} / ${doc.numPages}`);
      slots.push(slot);
      root.appendChild(slot);
    }

    for (let i = 1; i <= doc.numPages; i++) {
      if (myToken !== renderToken) return;
      const slot = slots[i - 1];
      try {
        const canvas = await renderPageToCanvas(doc, i, cssWidth);
        if (myToken !== renderToken) return;
        slot.classList.remove('placeholder');
        slot.innerHTML = '';
        slot.appendChild(canvas);
      } catch (err) {
        console.error(`[preview] render page ${i} failed`, err);
        slot.classList.remove('placeholder');
        slot.textContent = `Error rendering page ${i}: ${describeError(err)}`;
      }
      // Free the page's worker-side caches as soon as it's been drawn to
      // the screen. Without this pdf.js retains every rendered page's
      // parsed operator list / image dict for the lifetime of the doc.
      try {
        const p = await doc.getPage(i);
        await (p as unknown as { cleanup?: () => unknown }).cleanup?.();
      } catch { /* ignore */ }
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
  }

  store.subscribe((s, prev) => {
    const bytesChanged =
      s.originalBytes !== prev.originalBytes ||
      s.convertedBytes !== prev.convertedBytes;
    const viewChanged = s.view !== prev.view;
    const progressChanged = s.splitProgress !== prev.splitProgress;

    // Live-update the progress bar without tearing down everything.
    if (
      s.view === 'converted' &&
      s.splitProgress &&
      progressChanged &&
      !viewChanged &&
      !bytesChanged
    ) {
      showProgress(s.splitProgress.done, s.splitProgress.total);
      return;
    }

    if (viewChanged || bytesChanged || progressChanged) {
      void rebuild();
    }
  });

  void rebuild();
  return root;
}

/**
 * Produce a useful one-line description of a thrown value. WebKit/Safari
 * collapses many internal failures into a bare `TypeError: Type error` with
 * no `.message` detail and no `.stack`, which is useless on its own — this
 * helper dumps every own property of the error so something at least
 * survives into the on-screen message.
 */
function describeError(err: unknown): string {
  if (err == null) return String(err);
  if (typeof err !== 'object') return String(err);
  const e = err as Record<string, unknown> & { name?: string; message?: string; stack?: string };

  const parts: string[] = [];
  if (e.name) parts.push(String(e.name));
  if (e.message) parts.push(String(e.message));
  // Pull in any extra own properties pdf.js attaches (code, details, status,
  // url, response, etc.).
  for (const key of Object.getOwnPropertyNames(e)) {
    if (key === 'name' || key === 'message' || key === 'stack') continue;
    const v = e[key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') {
      try { parts.push(`${key}=${JSON.stringify(v)}`); } catch { parts.push(`${key}=[object]`); }
    } else {
      parts.push(`${key}=${String(v)}`);
    }
  }
  if (e.stack) {
    const firstFrame = e.stack.split('\n').find((l) => l.trim().length > 0 && !/^\w*Error/.test(l));
    if (firstFrame) parts.push(`@ ${firstFrame.trim()}`);
  }
  return parts.join(' · ') || 'unknown error';
}

