import { h } from '../app/dom';
import { t } from '../i18n';

/**
 * Help / about content. Two parts: a brief usage guide with a layout
 * diagram, followed by a short technical "how it works" section.
 */
export function buildHelp(): HTMLElement {
  return h('article', { class: 'help' },
    h('h2', { 'data-i18n': 'help.usage.title' }, t('help.usage.title')),
    h('p',  { 'data-i18n': 'help.intro' }, t('help.intro')),

    h('h3', { 'data-i18n': 'help.layout.title' }, t('help.layout.title')),
    h('p',  { 'data-i18n': 'help.layout.body' }, t('help.layout.body')),
    h('p',  { class: 'note', 'data-i18n': 'help.layout.n' }, t('help.layout.n')),
    bookletDiagram(),
    h('p',  { class: 'caption', 'data-i18n': 'help.layout.caption' }, t('help.layout.caption')),

    h('h3', { 'data-i18n': 'help.steps.title' }, t('help.steps.title')),
    h('ol', { class: 'help-steps' },
      h('li', { 'data-i18n': 'help.steps.1' }, t('help.steps.1')),
      h('li', { 'data-i18n': 'help.steps.2' }, t('help.steps.2')),
      h('li', { 'data-i18n': 'help.steps.3' }, t('help.steps.3')),
      h('li', { 'data-i18n': 'help.steps.4' }, t('help.steps.4')),
    ),

    h('h3', { 'data-i18n': 'help.technical.title' }, t('help.technical.title')),
    h('p',  { 'data-i18n': 'help.technical.body' }, t('help.technical.body')),
    h('p',  { class: 'note', 'data-i18n': 'help.technical.privacy' }, t('help.technical.privacy')),
  );
}

/**
 * Simple SVG illustration: three stacked **landscape A4** sheets, each split
 * in half by a centre fold, with page numbers showing the booklet imposition
 * the app expects:  N | 1 ,  2 | N−1 ,  N−2 | 3 .
 *
 * Each sheet uses the real A4 aspect ratio (√2 ≈ 1.414), so it visually
 * reads as a piece of paper rather than a bar.
 */
function bookletDiagram(): SVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'help-diagram');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t('help.layout.caption'));

  // Soft drop shadow definition (used by every sheet).
  const defs = document.createElementNS(NS, 'defs');
  defs.innerHTML = `
    <filter id="help-sheet-shadow" x="-10%" y="-10%" width="120%" height="140%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="2"/>
      <feOffset dy="2"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.18"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>`;
  svg.appendChild(defs);

  const sheets: Array<[string, string]> = [
    ['N',     '1'],
    ['2',     'N − 1'],
    ['N − 2', '3'],
  ];

  // viewBox fits three sheets side by side with a tag area above each one.
  const sheetW = 150;
  const sheetH = Math.round(sheetW / Math.SQRT2); // ≈ 106
  const gap        = 22;
  const leftMargin = 10;
  const tagAreaH   = 20;   // space above each sheet for the "#N" label
  const bottomMargin = 8;

  const vbW = leftMargin + 3 * sheetW + 2 * gap + leftMargin; // 364
  const vbH = tagAreaH + sheetH + bottomMargin;                // 99

  svg.setAttribute('viewBox', `0 0 ${vbW} ${vbH}`);
  svg.setAttribute('width',  String(Math.round(vbW / 2)));  // 182
  svg.setAttribute('height', String(Math.round(vbH / 2)));  // 50

  sheets.forEach(([leftLbl, rightLbl], i) => {
    const x = leftMargin + i * (sheetW + gap);
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('transform', `translate(${x} ${tagAreaH})`);

    // Paper sheet (rounded rect with soft shadow).
    const sheet = document.createElementNS(NS, 'rect');
    sheet.setAttribute('x', '0');
    sheet.setAttribute('y', '0');
    sheet.setAttribute('width', String(sheetW));
    sheet.setAttribute('height', String(sheetH));
    sheet.setAttribute('rx', '4');
    sheet.setAttribute('class', 'help-diagram-sheet');
    sheet.setAttribute('filter', 'url(#help-sheet-shadow)');
    g.appendChild(sheet);

    // Centre fold (dashed vertical line).
    const fold = document.createElementNS(NS, 'line');
    fold.setAttribute('x1', String(sheetW / 2));
    fold.setAttribute('y1', '10');
    fold.setAttribute('x2', String(sheetW / 2));
    fold.setAttribute('y2', String(sheetH - 10));
    fold.setAttribute('class', 'help-diagram-fold');
    g.appendChild(fold);

    // Page-number labels (centred in each half).
    const midY = sheetH / 2 + 7; // +7 to optically centre the text
    const leftX = sheetW * 0.25;
    const rightX = sheetW * 0.75;

    const lt = document.createElementNS(NS, 'text');
    lt.setAttribute('x', String(leftX));
    lt.setAttribute('y', String(midY));
    lt.setAttribute('text-anchor', 'middle');
    lt.setAttribute('class', 'help-diagram-label');
    lt.textContent = leftLbl;
    g.appendChild(lt);

    const rt = document.createElementNS(NS, 'text');
    rt.setAttribute('x', String(rightX));
    rt.setAttribute('y', String(midY));
    rt.setAttribute('text-anchor', 'middle');
    rt.setAttribute('class', 'help-diagram-label');
    rt.textContent = rightLbl;
    g.appendChild(rt);

    // "#1 / #2 / #3" sheet tag, centred above the sheet.
    const tag = document.createElementNS(NS, 'text');
    tag.setAttribute('x', String(sheetW / 2));
    tag.setAttribute('y', '-6');
    tag.setAttribute('text-anchor', 'middle');
    tag.setAttribute('class', 'help-diagram-label');
    tag.textContent = `#${i + 1}`;
    g.appendChild(tag);

    svg.appendChild(g);
  });

  return svg;
}

