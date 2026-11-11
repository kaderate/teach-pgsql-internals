import { h, btn } from './dom.js';
import { store, rank } from './store.js';
import { mountSideMap, setMap } from './map.js';
import { renderChapter } from './blocks.js';
import { CHAPTERS } from '../chapters/index.js';

const app = document.getElementById('app');
const nav = h('nav', { class: 'nav', 'aria-label': 'Chapitres' });
const main = h('main', { class: 'main', id: 'main' });
const side = h('aside', { class: 'side', 'aria-label': 'Carte du système' });
app.append(h('div', { class: 'layout' }, nav, main, side));
mountSideMap(side);

function applyTheme() {
  const saved = store.get().theme;
  const dark = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function current() {
  const m = /^#\/([\w-]+)/.exec(location.hash);
  const i = m ? CHAPTERS.findIndex((c) => c.id === m[1]) : 0;
  return i === -1 ? 0 : i;
}

function renderNav() {
  const st = store.get();
  const cur = current();
  nav.replaceChildren(
    h('p', { class: 'brand' }, '🐘 Slonik', h('br'), h('span', {}, 'Folies')),
    h('p', { class: 'rank' }, 'Rang : ', h('b', {}, rank(st.score)), h('br'), `${st.score} points`),
    h('ol', {}, CHAPTERS.map((c, i) => h('li', {},
      h('a', { href: `#/${c.id}`, 'aria-current': i === cur ? 'page' : null },
        h('span', { class: 'tick', 'aria-hidden': 'true' }, st.finished[c.id] ? '✅' : c.icon),
        h('span', {}, c.nav))))),
    h('div', { class: 'nav-actions' },
      btn('🌗 Thème', () => {
        const isDark = document.documentElement.dataset.theme === 'dark';
        store.update((s) => { s.theme = isDark ? 'light' : 'dark'; });
        applyTheme();
      }, { class: 'small' }),
      btn('Tout oublier', () => {
        if (confirm('Effacer ta progression (réponses, points) ? Le labo Docker n\'est pas touché.')) { store.reset(); applyTheme(); route(); }
      }, { class: 'small' })),
  );
}

function route() {
  const i = current();
  const ch = CHAPTERS[i];
  document.body.classList.toggle('night', !!ch.night);
  document.title = `${ch.nav} · Slonik Folies`;
  store.update((s) => { s.visited[ch.id] = true; });
  setMap(ch.map ?? [], ch.mapCaption ?? '');
  renderChapter(ch, main, {
    index: i,
    total: CHAPTERS.length,
    onNext: () => { location.hash = `#/${CHAPTERS[i + 1].id}`; },
  });
  scrollTo(0, 0);
  main.querySelector('h1')?.focus({ preventScroll: true });
}

applyTheme();
store.subscribe(renderNav);
addEventListener('hashchange', () => { renderNav(); route(); });
renderNav();
route();
