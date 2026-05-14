import { h } from '../app/dom';
import { store, type Settings } from '../app/state';
import { saveSettings } from '../app/storage';
import { t, applyI18n } from '../i18n';

export function openSettingsModal(): void {
  const cur: Settings = { ...store.get().settings };

  const generateTextToggle = h('input', {
    type: 'checkbox',
    checked: cur.generateText,
    style: { width: '22px', height: '22px', cursor: 'pointer' },
    onchange: (e: Event) => {
      cur.generateText = (e.target as HTMLInputElement).checked;
    },
  }) as HTMLInputElement;

  const closeBtn = h('button', {
    class: 'btn btn-primary',
    'data-i18n': 'settings.close',
    onclick: () => {
      store.set({ settings: { ...cur } });
      void saveSettings(cur);
      backdrop.remove();
    },
  }, t('settings.close'));

  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
    h('h2', { 'data-i18n': 'settings.title' }, t('settings.title')),
    h('div', { class: 'row' },
      h('label', { style: { display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' } },
        generateTextToggle,
        h('span', { 'data-i18n': 'settings.generateText' }, t('settings.generateText')),
      ),
      h('div', { class: 'hint', 'data-i18n': 'settings.generateText.hint' }, t('settings.generateText.hint')),
    ),
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

