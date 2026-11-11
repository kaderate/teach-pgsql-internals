// Des UPDATE, du gras, et le vacuum qui passe. Ou pas.
import { h, btn, md } from '../dom.js';
import { MiniPg, COMMITTED } from '../../sim/engine.js';
import { setMap } from '../map.js';

export function vacuumLab() {
  let db;
  let last;
  let n;
  let peakPages;
  const reset = () => {
    db = new MiniPg({ pageCapacity: 5, bufferFrames: 16 });
    db.autocommit('s', (d) => { for (let i = 1; i <= 3; i++) d.insert('s', i, 'v0'); });
    last = 'Trois lignes, une page.';
    n = 0;
    peakPages = 1;
  };
  reset();
  const root = h('div', { 'aria-live': 'polite' });
  const up = (id, indexed) => {
    db.begin('w');
    const r = db.update('w', id, `v${++n}`, { indexedColumnChanged: indexed });
    db.commit('w');
    return r;
  };
  const burst = (indexed) => {
    let hot = 0;
    const count = 4;
    for (let k = 0; k < count; k++) if (up(1 + (k % 3), indexed).hot) hot++;
    last = `${count} UPDATE : ${hot} en HOT (index intact), ${count - hot} ont dû ajouter une entrée d'index.`;
    setMap(['executor', 'buffers', 'walbuf'], 'Chaque UPDATE laisse un **cadavre**.');
    paint();
  };
  const tile = (s, i) => {
    if (s.state === 'unused') return h('div', { class: 'slot unused' }, `${i + 1}: libre`);
    if (s.state === 'redirect') return h('div', { class: 'slot redirect' }, `${i + 1}: → redirection vers ${s.to + 1}`);
    const t = s.tuple;
    const horizon = db.xminHorizon();
    const dead = db.isDead(t, horizon);
    const obsolete = t.xmax != null && db.clog[t.xmax] === COMMITTED;
    return h('div', { class: `slot${dead || obsolete ? ' dead' : ''}${t.heapOnly ? ' hot' : ''}`, title: t.heapOnly ? 'Heap-only : aucune entrée d\'index ne pointe ici' : '' },
      `${i + 1}: ligne ${t.id}=${t.value} ${dead ? '☠️' : obsolete ? '👻 retenu' : ''}`);
  };
  const paint = () => {
    peakPages = Math.max(peakPages, db.pageCount);
    const { live, dead, pages } = db.counts();
    const entries = Object.values(db.index).reduce((a, l) => a + l.length, 0);
    const held = db.txs.vieux;
    const total = live + dead || 1;
    const pct = Math.round((100 * dead) / total);
    root.replaceChildren(
      h('div', { class: 'row', style: 'margin-bottom:10px' },
        btn('4 UPDATE (colonne non indexée)', () => burst(false)),
        btn('4 UPDATE (colonne indexée)', () => burst(true)),
        held
          ? btn('Fermer la vieille transaction', () => { db.commit('vieux'); last = 'La vieille transaction est fermée. L\'horizon peut avancer.'; paint(); })
          : btn('Ouvrir une vieille transaction (pause café)', () => { db.begin('vieux', { isolation: 'repeatable read' }); db.statementSnapshot('vieux'); last = `Un snapshot figé en xmin=${db.txs.vieux.frozenSnapshot.xmin}. Plus rien de plus récent ne peut être nettoyé.`; paint(); }),
        btn('VACUUM', () => {
          const r = db.vacuum();
          last = `VACUUM : ${r.removed} versions retirées, ${r.redirects} redirection(s), ${r.kept} encore retenues. Horizon : xid ${r.horizon}. Pages : toujours ${db.pageCount}, l'espace est réutilisable mais pas rendu à l'OS.`;
          setMap(['autovacuum', 'buffers', 'walbuf'], '**VACUUM** passe.');
          paint();
        }, { class: 'primary' })),
      h('div', { class: 'pages' }, Array.from({ length: db.pageCount }, (_, no) => {
        const p = db.pageView(no);
        return h('div', { class: 'mini-page' }, h('h5', {}, `Page ${no}`), p.slots.map(tile));
      })),
      h('div', { class: 'three', style: 'margin-top:10px' },
        h('div', {}, h('b', {}, `Bloat : ${pct} %`), h('div', { class: `gauge ${pct > 60 ? 'bad' : pct > 30 ? 'warn' : ''}` }, h('i', { style: `width:${pct}%` }))),
        h('div', {}, h('b', {}, `${pages} page(s)`), md('p', `pour **${live}** lignes vivantes, **${dead}** versions mortes`, { class: 'caption-small' })),
        h('div', {}, h('b', {}, `${entries} entrées d'index`), md('p', `pour 3 lignes logiques${held ? ' · ⚠️ vieille transaction ouverte' : ''}`, { class: 'caption-small' }))),
      h('div', { class: 'status' }, last));
  };
  paint();
  return h('section', { class: 'card' }, h('div', { class: 'row spread' }, h('h3', { style: 'margin:0' }, 'La décharge municipale'), btn('Recommencer', () => { reset(); paint(); }, { class: 'small' })),
    md('p', 'Cinq slots par page. ☠️ mort pour tout le monde, 👻 mort mais encore visible d\'un vieux snapshot, bord violet : tuple HOT.', { class: 'caption-small' }), root);
}
