import './styles.css';
import { h } from './app/dom';
import { store } from './app/state';
import { loadPdf as loadStoredPdf, loadSettings } from './app/storage';
import { initI18n, t } from './i18n';
import { buildTabs } from './ui/tabs';
import { buildToolbar } from './ui/toolbar';
import { buildPreview } from './ui/preview';

async function boot() {
  initI18n();

  const savedSettings = await loadSettings();
  if (savedSettings) store.set({ settings: savedSettings });

  const root = document.getElementById('app')!;
  root.append(
    h('h1', { class: 'brand', 'data-i18n': 'app.title' }, t('app.title')),
    h('main', { class: 'panel' },
      buildTabs(),
      buildToolbar(),
      buildPreview(),
    ),
  );

  // Hydrate last PDF
  const last = await loadStoredPdf();
  if (last) {
    store.set({
      fileName: last.name,
      originalBytes: new Uint8Array(last.bytes),
      convertedBytes: null,
    });
  }
}

void boot();

