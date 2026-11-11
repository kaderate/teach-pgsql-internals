// Les briques d'un chapitre. La règle du jeu : tant qu'une question n'a pas de réponse, la suite
// du chapitre n'existe pas à l'écran. On devine d'abord.
import { h, md, btn, inline, table, pick } from './dom.js';
import { store } from './store.js';
import { labBlock } from './lab.js';

const BRAVO = ['Bingo.', 'Slonik barrit de joie.', 'Exactement.', 'Tu lis dans le code source, toi.', 'Dans le mille.'];
const OUPS = ['Raté, et c\'est justement pour ça qu\'on est là.', 'Non, mais c\'est le raté le plus courant.', 'Slonik te regarde avec tendresse.', 'Presque tout le monde dit ça. Non.'];

export function elephantRain(n = 14) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (let i = 0; i < n; i++) {
    const d = h('div', { class: 'drop', 'aria-hidden': 'true' }, pick(['🐘', '🐘', '🐘', '💾', '📜']));
    d.style.left = `${Math.random() * 100}vw`;
    d.style.animationDelay = `${Math.random() * 0.5}s`;
    document.body.append(d);
    setTimeout(() => d.remove(), 2200);
  }
}

/** Une question à choix. `onDone` débloque la suite. */
export function guessBlock(g, onDone) {
  const saved = store.get().answers[g.id];
  const verdict = h('div', { 'aria-live': 'polite' });
  const buttons = [];
  const paint = (idx, fresh) => {
    const chosen = g.options[idx];
    buttons.forEach((b, i) => {
      b.disabled = true;
      if (g.options[i].ok) b.classList.add('right');
      else if (i === idx) b.classList.add('wrong');
      else b.classList.add('dim');
    });
    const head = fresh ? `${chosen.ok ? pick(BRAVO) : pick(OUPS)} ` : '';
    verdict.replaceChildren(h('div', { class: `verdict${chosen.ok ? '' : ' bad'}`, html: inline(head + chosen.why) }));
    if (!chosen.ok) {
      const right = g.options.find((o) => o.ok);
      if (right?.why) verdict.append(h('div', { class: 'verdict', html: inline(`La bonne réponse : ${right.why}`) }));
    }
    if (g.explain) verdict.append(h('p', { html: inline(g.explain) }));
  };
  const opts = h('div', { class: 'opts' }, g.options.map((o, i) => {
    const b = btn(o.t, () => {
      store.update((s) => { s.answers[g.id] = i; s.score += o.ok ? 10 : 2; });
      paint(i, true);
      if (o.ok) elephantRain();
      onDone?.();
    });
    b.innerHTML = inline(o.t);
    buttons.push(b);
    return b;
  }));
  const el = h('section', { class: 'card guess', 'aria-label': 'Question' },
    h('div', { class: 'tag' }, '🎯 DEVINE D\'ABORD'), md('p', g.q, { class: 'q' }), opts, verdict);
  if (saved != null && g.options[saved]) { paint(saved, false); queueMicrotask(() => onDone?.()); }
  return el;
}

/** Une question ouverte : on écrit sa théorie, puis on compare. */
export function theoryBlock(t, onDone) {
  const saved = store.get().theory[t.id];
  const area = h('textarea', { 'aria-label': 'Ta théorie', placeholder: 'Écris ta théorie, même bancale. Personne ne regarde.' });
  area.value = saved ?? '';
  const reveal = h('div');
  const show = () => {
    reveal.replaceChildren(h('div', { class: 'reveal', html: inline(t.reveal) }));
    area.readOnly = true;
    go.hidden = true;
    onDone?.();
  };
  const go = btn('Voir la réponse', () => {
    store.update((s) => { s.theory[t.id] = area.value; s.score += area.value.trim() ? 5 : 1; });
    show();
  }, { class: 'primary' });
  const el = h('section', { class: 'card guess theory' }, h('div', { class: 'tag' }, '✍️ TA THÉORIE'), md('p', t.q, { class: 'q' }), area, h('div', { class: 'row', style: 'margin-top:8px' }, go), reveal);
  if (saved != null) queueMicrotask(show);
  return el;
}

const say = (text) => h('div', { class: 'say' }, h('div', { class: 'el', 'aria-hidden': 'true' }, '🐘'), h('div', { class: 'bubble', html: inline(text) }));

function renderBlock(b, ctx, next) {
  if (typeof b === 'string') return { el: md('p', b) };
  if (b.h) return { el: md('h2', b.h) };
  if (b.say) return { el: say(b.say) };
  if (b.keep) return { el: h('aside', { class: 'keep' }, h('h3', {}, '📌 À retenir'), h('ul', {}, b.keep.map((k) => md('li', k)))) };
  if (b.table) return { el: table(b.table[0], b.table.slice(1)) };
  if (b.code) return { el: h('div', {}, h('pre', { class: 'code' }, b.code), b.caption ? md('p', b.caption, { class: 'caption-small' }) : null) };
  if (b.widget) return { el: b.widget(ctx) };
  if (b.lab) return { el: labBlock(b.lab) };
  if (b.guess) return { el: guessBlock(b.guess, next), gate: true };
  if (b.theory) return { el: theoryBlock(b.theory, next), gate: true };
  throw new Error(`Bloc inconnu : ${JSON.stringify(b).slice(0, 80)}`);
}

export function renderChapter(ch, root, { index, total, onNext }) {
  root.replaceChildren(
    h('span', { class: 'ch-kicker' }, ch.kicker),
    md('h1', ch.title, { class: 'ch-title', tabindex: '-1' }),
  );
  const finish = () => {
    if (index + 1 < total) root.append(h('div', { class: 'next-ch' }, btn('Chapitre suivant →', onNext, { class: 'primary big' })));
    // Le ✅ se gagne en arrivant au bout de la page, pas en l'ouvrant.
    const end = h('div', { 'aria-hidden': 'true', style: 'height:1px' });
    root.append(end);
    const seen = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      seen.disconnect();
      store.update((s) => { s.finished[ch.id] = true; });
    });
    seen.observe(end);
  };
  let i = 0;
  let initial = true;
  const advance = () => {
    while (i < ch.blocks.length) {
      const b = ch.blocks[i++];
      let answered = false;
      let attached = false;
      const onAnswered = () => {
        if (answered) return;
        answered = true;
        if (attached) advance();
      };
      const { el, gate } = renderBlock(b, { chapter: ch }, onAnswered);
      el.classList?.add('block');
      if (!initial) el.classList?.add('fade');
      root.append(el);
      attached = true;
      if (gate) {
        // Réponse déjà donnée lors d'une visite précédente : queueMicrotask rappellera onAnswered.
        return;
      }
    }
    finish();
  };
  advance();
  initial = false;
}
