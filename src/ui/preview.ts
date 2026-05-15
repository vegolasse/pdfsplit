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

    // Help tab: static content, no PDF involved.
    if (which === 'help') {
      clearProgress();
      root.innerHTML = '';
      root.appendChild(buildHelp());
      return;
    }

    // If we're on the Split tab and a split is running, show the progress
    // bar and bail — we'll be re-invoked when splitProgress changes.
    if (which === 'converted' && s.splitProgress) {
      showProgress(s.splitProgress.done, s.splitProgress.total);
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
      return;
    }

    if (!docCache || docCache.bytesRef !== bytes || docCache.which !== which) {
      try {
        const doc = await loadPdf(bytes);
        if (myToken !== renderToken) return;
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
      if (docCache && docCache.bytesRef !== (s.view === 'original' ? s.originalBytes : s.convertedBytes)) {
        docCache = null;
      }
      void rebuild();
    }
  });

  void rebuild();
  return root;
}

/**
 * Produce a useful one-line description of a thrown value. WebKit/Safari
 * collapses many internal failures into a bare `TypeError: Type error` with
 * no `.message` detail, which is useless on its own — this helper digs out
 * the error name, code, cause, and any nested `.details` pdf.js attaches.
 */
function describeError(err: unknown): string {
  if (err == null) return String(err);
  if (typeof err !== 'object') return String(err);
  const e = err as {
    name?: string;
    message?: string;
    code?: unknown;
    details?: unknown;
    cause?: unknown;
    stack?: string;
  };
  const parts: string[] = [];
  if (e.name) parts.push(e.name);
  if (e.message) parts.push(e.message);
  if (e.code !== undefined) parts.push(`code=${String(e.code)}`);
  if (e.details !== undefined) parts.push(`details=${String(e.details)}`);
  if (e.cause !== undefined && e.cause !== null) parts.push(`cause=${describeError(e.cause)}`);
  let out = parts.join(' · ') || 'unknown error';
  if (out === 'TypeError · Type error' && e.stack) {
    // Add the first stack frame so we can at least see where it came from.
    const firstFrame = e.stack.split('\n').find((l) => l.trim().length > 0);
    if (firstFrame) out += ` @ ${firstFrame.trim()}`;
  }
  return out;
}

