import { h } from '../app/dom';
import { store, DEFAULT_SETTINGS, type Settings } from '../app/state';
import { saveSettings } from '../app/storage';
import { t, applyI18n } from '../i18n';

export function openSettingsModal(): void {
  const cur: Settings = { ...store.get().settings };

  const fidelitySelect = h('select', {
    class: 'lang-select',
    onchange: (e: Event) => {
      cur.fidelity = (e.target as HTMLSelectElement).value as Settings['fidelity'];
    },
  },
    h('option', { value: 'lossless', selected: cur.fidelity === 'lossless', 'data-i18n': 'settings.fidelity.lossless' }, t('settings.fidelity.lossless')),
    h('option', { value: 'raster', selected: cur.fidelity === 'raster', 'data-i18n': 'settings.fidelity.raster' }, t('settings.fidelity.raster')),
  );

  const dpiInput = h('input', {
    type: 'number', min: '72', max: '600', step: '1', value: String(cur.dpi),
    class: 'lang-select', style: { paddingRight: '16px' },
    onchange: (e: Event) => {
      const v = parseInt((e.target as HTMLInputElement).value, 10);
      cur.dpi = Number.isFinite(v) ? Math.min(600, Math.max(72, v)) : DEFAULT_SETTINGS.dpi;
    },
  });

  const dpiRow = h('div', { class: 'row' },
    h('label', { 'data-i18n': 'settings.dpi' }, t('settings.dpi')),
    dpiInput,
    h('div', { class: 'hint', 'data-i18n': 'settings.dpiHint' }, t('settings.dpiHint')),
  );

  const closeBtn = h('button', {
    class: 'btn btn-primary',
    'data-i18n': 'settings.close',
    onclick: () => {
      store.set({ settings: { ...cur } });
      void saveSettings(cur);
      backdrop.remove();
    },
  }, t('settings.close'));

  const modal = h('div', { class: 'glass modal', role: 'dialog', 'aria-modal': 'true' },
    h('h2', { 'data-i18n': 'settings.title' }, t('settings.title')),
    h('div', { class: 'row' },
      h('label', { 'data-i18n': 'settings.fidelity' }, t('settings.fidelity')),
      fidelitySelect,
    ),
    dpiRow,
    h('div', { class: 'modal-actions' }, closeBtn),
  );

  const backdrop = h('div', {
    class: 'modal-backdrop',
    onclick: (e: MouseEvent) => { if (e.target === backdrop) closeBtn.click(); },
  }, modal);

  document.body.appendChild(backdrop);
  applyI18n(backdrop);
  closeBtn.focus();
}

