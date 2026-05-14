import { h } from '../app/dom';

let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (container) return container;
  container = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  document.body.appendChild(container);
  return container;
}

export type ToastKind = 'info' | 'warn' | 'error';

export function toast(msg: string, kind: ToastKind = 'info', ms = 3500): void {
  const c = ensureContainer();
  const el = h('div', { class: `toast ${kind}` }, msg);
  c.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 200ms';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

