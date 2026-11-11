// Le planner en direct : les curseurs, les coûts, le verdict.
import { h, md, slider, btn } from '../dom.js';
import { comparePlans, seqTakeover, DEFAULTS } from '../../sim/planner.js';
import { setMap } from '../map.js';

export function plannerLab() {
  const t = { pages: 3334, rows: 400000, indexPages: 1099, selectivity: 0.001, correlation: 0, quals: 1, allVisible: 1, indexOnlyPossible: false };
  const c = { ...DEFAULTS };
  const out = h('div', { 'aria-live': 'polite' });
  const paint = () => {
    const { plans, best } = comparePlans(t, c);
    const max = Math.max(...plans.map((p) => p.total));
    const takeIndex = seqTakeover(t, c, 'index');
    const takeBitmap = seqTakeover(t, c, 'bitmap');
    const pct = (x) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)} %`;
    out.replaceChildren(
      h('div', {}, plans.map((p) => h('div', { class: 'bar-row' },
        h('span', {}, `${p.name === best ? '🏆 ' : ''}${p.name}`),
        h('div', { class: 'bar-track' }, h('div', { class: `bar-fill${p.name === best ? ' best' : ''}`, style: `width:${Math.max(0.5, (100 * Math.log1p(p.total)) / Math.log1p(max))}%` })),
        h('span', { class: 'v' }, p.total.toFixed(0))))),
      md('p', `≈ **${Math.round(t.rows * t.selectivity).toLocaleString('fr-FR')}** lignes ramenées. Le Seq Scan bat l'Index Scan dès **${pct(takeIndex)}** de la table, et le Bitmap Scan à partir de **${pct(takeBitmap)}**.`),
      md('p', 'Barres en échelle logarithmique. Le seq scan suit la formule exacte de `costsize.c`. Les deux autres en sont une version simplifiée, à moins de 11 % du vrai planner sur cette table (voir `test/others.test.js`). Le parallélisme n\'est pas modélisé.', { class: 'caption-small' }));
    setMap(['planner'], `Le **planner** choisit : ${best}`);
  };
  const logSel = (v) => 10 ** v;
  const fmtSel = (v) => `${(logSel(v) * 100).toFixed(logSel(v) < 0.001 ? 4 : 2)} %`;
  paint();
  return h('section', { class: 'card' }, h('h3', {}, 'Le cerveau du planner : orders, 400 000 lignes'),
    h('div', { class: 'two' },
      slider({ label: 'Sélectivité du WHERE', min: -5.6, max: 0, step: 0.05, value: -3, format: fmtSel, oninput: (v) => { t.selectivity = logSel(v); paint(); } }),
      slider({ label: 'Corrélation ordre physique / index', min: 0, max: 1, step: 0.05, value: 0, format: (v) => v.toFixed(2), oninput: (v) => { t.correlation = v; paint(); } }),
      slider({ label: 'random_page_cost', min: 1, max: 8, step: 0.1, value: 4, format: (v) => v.toFixed(1), oninput: (v) => { c.random_page_cost = v; paint(); } }),
      slider({ label: 'Taille de la table (pages)', min: 100, max: 50000, step: 100, value: 3334, oninput: (v) => { t.rows = Math.round((400000 / 3334) * v); t.pages = v; t.indexPages = Math.round(v * 0.33); paint(); } })),
    h('label', { class: 'row tight', style: 'margin:8px 0' }, h('input', { type: 'checkbox', onchange: (e) => { t.indexOnlyPossible = e.target.checked; paint(); } }), 'L\'index couvre toutes les colonnes demandées (index only scan possible)'),
    out);
}

/** Un EXPLAIN qui se lit au clic. */
export function explainDecoder({ title, lines }) {
  return () => {
    const info = h('div', { class: 'observe', 'aria-live': 'polite' }, 'Clique une ligne du plan.');
    const pre = h('div', { class: 'code' }, lines.map(([text, explain]) => h('div', {
      class: 'plan-line',
      style: explain ? 'cursor:pointer' : '',
      tabindex: explain ? 0 : null,
      role: explain ? 'button' : null,
      onclick: explain ? (e) => { pre.querySelectorAll('.hl').forEach((x) => x.classList.remove('hl')); e.currentTarget.classList.add('hl'); info.innerHTML = ''; info.append(md('span', explain)); } : null,
      onkeydown: explain ? (e) => { if (e.key === 'Enter') e.currentTarget.click(); } : null,
    }, text)));
    return h('section', { class: 'card' }, h('h3', {}, title), pre, info);
  };
}
