import './styles.css';
import { h } from './app/dom';
import { store } from './app/state';
import { loadPdf as loadStoredPdf, loadSettings } from './app/storage';
import { initI18n } from './i18n';
import { buildHeader } from './ui/header';
import { buildTabs } from './ui/tabs';
import { buildPreview } from './ui/preview';

async function boot() {
  initI18n();

  // Hydrate settings before building UI so settings dialog reflects them.
  const savedSettings = await loadSettings();
  if (savedSettings) store.set({ settings: savedSettings });

  const root = document.getElementById('app')!;
  root.append(
    buildHeader(),
    buildTabs(),
    buildPreview(),
    h('footer', { class: 'sr-only' }, 'PDFSplit'),
  );

  // Hydrate last PDF
  const last = await loadStoredPdf();
  if (last) {
    store.set({
      fileName: last.name,
      originalBytes: new Uint8Array(last.bytes),
      convertedBytes: null,
      view: 'original',
    });
  }
}

void boot();

