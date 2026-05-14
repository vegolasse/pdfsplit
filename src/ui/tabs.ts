import { h } from '../app/dom';
import { store, type View } from '../app/state';

export function buildTabs(): HTMLElement {
  const make = (view: View, key: string) =>
    h('button', {
      class: 'tab',
      role: 'tab',
      type: 'button',
      'aria-selected': String(store.get().view === view),
      'data-i18n': key,
      onclick: () => store.set({ view }),
    });

  const orig = make('original', 'tabs.original') as HTMLButtonElement;
  const conv = make('converted', 'tabs.converted') as HTMLButtonElement;

  const root = h('div', { class: 'glass tabs', role: 'tablist' }, orig, conv);

  const sync = () => {
    const s = store.get();
    orig.setAttribute('aria-selected', String(s.view === 'original'));
    conv.setAttribute('aria-selected', String(s.view === 'converted'));
    conv.disabled = !s.convertedBytes;
    orig.disabled = !s.originalBytes;
  };
  store.subscribe(sync);
  sync();

  return root;
}

