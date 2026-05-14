import { h } from '../app/dom';
import { store, type View } from '../app/state';
import { t } from '../i18n';
import { runSplitIfNeeded } from './toolbar';

export function buildTabs(): HTMLElement {
  const make = (view: View, key: string) =>
    h('button', {
      class: 'tab',
      role: 'tab',
      type: 'button',
      'aria-selected': String(store.get().view === view),
      'data-i18n': key,
      onclick: () => {
        if (store.get().view === view) return;
        store.set({ view });
        if (view === 'converted') void runSplitIfNeeded();
      },
    }, t(key));

  const orig = make('original', 'tabs.original') as HTMLButtonElement;
  const conv = make('converted', 'tabs.split') as HTMLButtonElement;

  const root = h('div', { class: 'tabs', role: 'tablist' }, orig, conv);

  const sync = () => {
    const s = store.get();
    orig.setAttribute('aria-selected', String(s.view === 'original'));
    conv.setAttribute('aria-selected', String(s.view === 'converted'));
    orig.disabled = !s.originalBytes;
    conv.disabled = !s.originalBytes;
  };
  store.subscribe(sync);
  sync();

  return root;
}

