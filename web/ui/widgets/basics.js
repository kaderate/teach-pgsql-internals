// Carte interactive, voyage pas à pas, schéma de page et buffer pool.
import { h, md, btn, inline, clear } from '../dom.js';
import { createMap, DESCRIPTIONS, setMap } from '../map.js';
import { guessBlock } from '../blocks.js';
import { MiniPg } from '../../sim/engine.js';

export function systemMap() {
  const info = h('div', { class: 'map-info', 'aria-live': 'polite' }, md('p', 'Clique sur une boîte. Toutes se visitent, et aucune ne mord (sauf `autovacuum`, parfois).'));
  const map = createMap({
    interactive: true,
    onSelect: (id) => {
      const [t, d] = DESCRIPTIONS[id];
      info.replaceChildren(h('h3', { style: 'margin:0 0 6px' }, t), md('p', d));
      setMap([id], '');
    },
  });
  return h('div', { class: 'card two' }, map.el, info);
}

/** Un voyage découpé en étapes, avec retour arrière. La carte s'allume à chaque étape. */
export function journey({ id, steps }) {
  return () => {
    let i = 0;
    const answered = new Set();
    const bar = h('div', { class: 'progress', 'aria-hidden': 'true' }, steps.map(() => h('i')));
    const body = h('div', { class: 'body', 'aria-live': 'polite' });
    const prev = btn('← Reculer', () => go(i - 1));
    const next = btn('Avancer →', () => go(i + 1), { class: 'primary' });
    const counter = h('span', { class: 'caption-small' });
    const content = (s) => {
      const box = h('div');
      const t = Array.isArray(s.text) ? s.text : [s.text];
      t.forEach((p) => box.append(md('p', p)));
      if (typeof s.show === 'string') box.append(h('pre', { class: 'code' }, s.show));
      else if (s.show) box.append(s.show());
      return box;
    };
    const go = (n) => {
      i = Math.max(0, Math.min(steps.length - 1, n));
      const s = steps[i];
      bar.querySelectorAll('i').forEach((el, k) => el.classList.toggle('on', k <= i));
      counter.textContent = `Étape ${i + 1} sur ${steps.length}`;
      prev.disabled = i === 0;
      setMap(s.map ?? [], s.caption ?? `**${s.title}**`);
      clear(body).append(h('h4', {}, s.title));
      const reveal = () => {
        answered.add(i);
        next.disabled = i === steps.length - 1;
        body.append(content(s));
      };
      if (s.ask) {
        next.disabled = true;
        body.append(guessBlock({ id: `${id}/${i}`, ...s.ask }, reveal));
      } else {
        reveal();
      }
    };
    const el = h('section', { class: 'card journey', tabindex: '0', 'aria-label': 'Voyage pas à pas. Flèches gauche et droite pour naviguer.',
      onkeydown: (e) => {
        if (e.target.tagName === 'BUTTON' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        if (e.key === 'ArrowRight' && !next.disabled) go(i + 1);
        if (e.key === 'ArrowLeft') go(i - 1);
      } },
    bar, body, h('div', { class: 'row spread', style: 'margin-top:12px' }, prev, counter, next));
    go(0);
    return el;
  };
}

export const treeView = (text) => () => h('pre', { class: 'code tree' }, text);

// Une ligne de l'en-tête vu en vrai : 23 octets d'en-tête + données, 4 octets de line pointer.
const tupleBytes = (t) => 24 + 4 + (t.value?.length ?? 0) + 1;

export function slottedPage() {
  const db = new MiniPg({ pageCapacity: 7 });
  db.autocommit('s', (d) => { d.insert('s', 1, 'Gérard'); d.insert('s', 2, 'Slonik'); });
  let nextId = 3;
  const names = ['Odile', 'Mouloud', 'Yvette', 'Kader', 'Bernadette', 'Priya'];
  const root = h('div');
  const status = h('div', { 'aria-live': 'polite' });
  const ids = () => Object.entries(db.visibleRows()).map(([k]) => Number(k));
  const act = (fn) => { fn(); paint(); };
  const paint = () => {
    const page = db.pageView(0);
    const lps = page.slots.map((s, i) => h('span', { class: `lp ${s.state}` }, `${i + 1}:${s.state === 'normal' ? 'NORMAL' : s.state === 'redirect' ? `REDIRECT→${s.to + 1}` : 'UNUSED'}`));
    let upper = 8192;
    const tups = page.slots.map((s, i) => {
      if (s.state !== 'normal') return null;
      upper -= tupleBytes(s.tuple) - 4;
      const dead = s.tuple.xmax != null;
      return h('div', { class: `tup${dead ? ' dead' : ''}` }, h('b', {}, `(0,${i + 1})`), [`xmin=${s.tuple.xmin}`, `xmax=${s.tuple.xmax ?? 0}`, `id=${s.tuple.id}`, `name='${s.tuple.value}'`].map((t) => h('span', {}, t)));
    }).filter(Boolean);
    const lower = 24 + 4 * page.slots.length;
    root.replaceChildren(h('div', { class: 'page-box' },
      h('div', { class: 'ph' }, `PageHeader : pd_lsn=${page.lsn}  pd_lower=${lower}  pd_upper=${upper}`),
      h('div', { class: 'lps' }, lps),
      h('div', { class: 'free' }, `↓ line pointers  ···  ${upper - lower} octets libres  ···  tuples ↑`),
      h('div', { class: 'tups' }, tups)));
    const full = db.firstFreeSlot(page) === -1;
    status.replaceChildren(full ? h('div', { class: 'status warn' }, 'Plus de line pointer disponible dans ce schéma réduit. Essaie VACUUM.') : '');
    ins.disabled = full || !names.length;
    up.disabled = full || !ids().length;
    del.disabled = !ids().length;
  };
  const ins = btn('INSERT', () => act(() => {
    db.autocommit('s', (d) => { if (names.length) d.insert('s', nextId++, names.shift()); });
  }));
  const up = btn('UPDATE (ligne la plus ancienne)', () => act(() => {
    const id = ids()[0];
    db.autocommit('s', (d) => d.update('s', id, `${db.visibleRows()[id]}!`));
  }));
  const del = btn('DELETE (ligne la plus récente)', () => act(() => {
    const id = ids().at(-1);
    db.autocommit('s', (d) => d.delete('s', id));
  }));
  const vac = btn('VACUUM', () => act(() => db.vacuum()), { class: 'primary' });
  paint();
  return h('section', { class: 'card' }, h('h3', {}, 'Une page de 8 Ko, disséquée'), h('div', { class: 'row', style: 'margin-bottom:10px' }, ins, up, del, vac), root, status,
    md('p', 'Schéma réduit à 7 slots. Une vraie page de `users` contient 130 lignes.', { class: 'caption-small' }));
}

export function bufferPool() {
  const fresh = () => {
    const d = new MiniPg({ pageCapacity: 1, bufferFrames: 3 });
    d.autocommit('s', (x) => { for (let i = 0; i < 6; i++) x.insert('s', i, `ligne ${i}`); });
    d.checkpoint();
    d.frames = d.frames.map(() => null);
    d.hand = 0;
    d.stats = { hits: 0, misses: 0, diskWrites: 0, walFlushes: 0, evictions: 0 };
    return d;
  };
  let db = fresh();
  const out = h('div', { 'aria-live': 'polite' });
  let last = 'Clique sur une page pour la lire.';
  const paint = () => {
    const { hits, misses } = db.stats;
    const ratio = hits + misses ? Math.round((100 * hits) / (hits + misses)) : 0;
    out.replaceChildren(
      h('div', { class: 'three' }, db.frames.map((f, i) => h('div', { class: 'pane ram' },
        h('h4', {}, `Cadre ${i}${db.hand === i ? ' ⬅ aiguille' : ''}`),
        f ? h('div', {}, h('div', {}, `Page ${f.page.no}`), h('div', {}, `usage_count : ${'🔥'.repeat(f.usage) || '0'}`)) : h('div', {}, '(vide)')))),
      h('div', { class: 'status' }, last),
      md('p', `Hits : **${hits}** · Lectures disque : **${misses}** · Taux de cache : **${ratio} %**`));
  };
  const read = (no) => {
    const beforeMiss = db.stats.misses;
    const evicted = db.frames.every(Boolean) && db.findFrame(no) === -1;
    db.lastEvent = null;
    db.pin(no);
    const ev = db.lastEvent;
    last = db.stats.misses > beforeMiss
      ? `Page ${no} : MISS, lecture disque.${evicted && ev ? ` Il a fallu sacrifier la page ${ev.page} : l'aiguille a tourné en baissant les usage_count jusqu'à trouver un 0.` : ''}`
      : `Page ${no} : HIT, déjà en mémoire. usage_count monte (plafond : 5).`;
    setMap(db.stats.misses > beforeMiss ? ['executor', 'buffers', 'heap'] : ['executor', 'buffers'], db.stats.misses > beforeMiss ? 'Il faut aller au **disque**.' : 'Trouvée dans **shared_buffers**.');
    paint();
  };
  paint();
  return h('section', { class: 'card' }, h('h3', {}, 'Le buffer pool : 3 cadres pour 6 pages'),
    h('div', { class: 'row', style: 'margin-bottom:10px' }, [0, 1, 2, 3, 4, 5].map((n) => btn(`Lire page ${n}`, () => read(n))),
      btn('Vider', () => { db = fresh(); last = 'Cache vide.'; paint(); }, { class: 'small' })),
    out);
}
