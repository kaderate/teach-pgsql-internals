// La file d'attente des verrous, et comment un SELECT innocent se retrouve bloqué.
import { h, btn, md } from '../dom.js';
import { LockManager, MODES, conflicts } from '../../sim/locks.js';
import { setMap } from '../map.js';

const WHO = ['T1', 'T2', 'T3', 'T4'];
const STATEMENTS = [
  ['SELECT', 'AccessShare'],
  ['UPDATE', 'RowExclusive'],
  ['VACUUM', 'ShareUpdateExclusive'],
  ['CREATE INDEX', 'Share'],
  ['ALTER TABLE', 'AccessExclusive'],
];

export function lockMatrix() {
  const short = (m) => m.replace('Exclusive', 'Ex').replace('Access', 'Acc').replace('Share', 'Sh').replace('Update', 'Upd').replace('Row', 'Row');
  return h('section', { class: 'card' }, h('h3', {}, 'La matrice des conflits (la vraie, tableau 13.2 de la doc)'),
    h('div', { class: 'scroll' }, h('table', { class: 'matrix' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), MODES.map((m) => h('th', { title: m }, short(m))))),
      h('tbody', {}, MODES.map((a) => h('tr', {}, h('th', { class: 'side' }, a), MODES.map((b) => h('td', { class: conflicts(a, b) ? 'x' : '', 'aria-label': conflicts(a, b) ? 'conflit' : 'compatible' }, conflicts(a, b) ? '✗' : '')))))))
  );
}

export function lockQueue() {
  let lm;
  let log;
  const reset = () => { lm = new LockManager(); log = ['Personne ne tient de verrou sur `users`.']; };
  reset();
  const root = h('div', { 'aria-live': 'polite' });
  const isWaiting = (w) => lm.queue.some((q) => q.who === w);
  const statement = (w, name, mode) => {
    const r = lm.acquire(w, 'users', mode);
    log.push(r === 'granted' ? `${w} : ${name} prend ${mode}. OK.` : `${w} : ${name} veut ${mode}. ⏳ Bloqué par ${lm.blockers(w).join(', ')}.`);
    setMap(['executor', 'locks'], 'La **table des verrous**.');
    paint();
  };
  const finish = (w) => {
    const wasWaiting = isWaiting(w);
    const woken = lm.releaseAll(w);
    log.push(`${w} : ${wasWaiting ? 'demande annulée, elle sort de la file' : 'COMMIT, verrous libérés'}.${woken.length ? ` Réveillés : ${woken.map((x) => x.who).join(', ')}.` : ''}`);
    paint();
  };
  const paint = () => {
    const holders = lm.held.map((l) => h('span', { class: 'chip ok' }, `${l.who} · ${l.mode}`));
    const queue = lm.queue.map((q, i) => h('span', { class: 'chip wait' }, `${i + 1}. ${q.who} · ${q.mode}`));
    const waitingCount = lm.queue.length;
    const logEl = h('div', { class: 'log' }, log.slice(-7).map((l) => h('div', {}, l)));
    root.replaceChildren(
      h('div', { class: 'two' }, h('div', { class: 'pane' }, h('h4', {}, '🔓 Ils tiennent le verrou'), holders.length ? holders : '(personne)'),
        h('div', { class: `pane${waitingCount ? ' wait' : ''}` }, h('h4', {}, `⏳ Dans la file (${waitingCount})`), queue.length ? queue : '(personne)')),
      h('div', { class: 'three', style: 'margin-top:10px' }, WHO.map((w) => {
        const waiting = isWaiting(w);
        const holds = lm.held.some((l) => l.who === w);
        return h('div', { class: `pane${waiting ? ' wait' : ''}` }, h('h4', {}, `${w}${waiting ? ' ⏳' : ''}`),
          h('div', { class: 'row tight' }, STATEMENTS.map(([n, m]) => btn(n, () => statement(w, n, m), { class: 'small', disabled: waiting })),
            btn(waiting ? 'Annuler (Ctrl+C)' : 'COMMIT', () => finish(w), { class: 'small primary', disabled: !holds && !waiting })));
      })),
      logEl);
    logEl.scrollTop = logEl.scrollHeight;
  };
  paint();
  return h('section', { class: 'card' }, h('div', { class: 'row spread' }, h('h3', { style: 'margin:0' }, 'Le guichet de la table users'), btn('Recommencer', () => { reset(); paint(); }, { class: 'small' })), root);
}

export function deadlockLab() {
  let lm;
  let log;
  let ended;
  const reset = () => { lm = new LockManager(); log = ['Virement A : compte 1 puis 2. Virement B : compte 2 puis 1. Clique dans l\'ordre que tu veux.']; ended = false; };
  reset();
  const root = h('div', { 'aria-live': 'polite' });
  const take = (w, row) => {
    const r = lm.acquire(w, `compte ${row}`, 'Exclusive');
    log.push(r === 'granted' ? `${w} verrouille le compte ${row}.` : `${w} attend le compte ${row}, tenu par ${lm.blockers(w).join(', ')}.`);
    const cycle = lm.findDeadlock();
    if (cycle) {
      log.push(`Au bout de deadlock_timeout (1 s), un backend qui attend vérifie le graphe : cycle ${cycle.join(' → ')} → ${cycle[0]}.`);
      const victim = w;
      lm.releaseAll(victim);
      log.push(`ERROR: deadlock detected. ${victim} est annulée (celle dont le contrôle a trouvé le cycle). L'autre continue.`);
      ended = true;
    }
    paint();
  };
  const paint = () => {
    const row = (w, order) => h('div', { class: 'pane' }, h('h4', {}, `Virement ${w}`), h('div', { class: 'row tight' }, order.map((n) => btn(`UPDATE compte ${n}`, () => take(w, n), { class: 'small', disabled: ended || lm.queue.some((q) => q.who === w) || lm.held.some((l) => l.who === w && l.resource === `compte ${n}`) }))));
    const logEl = h('div', { class: 'log' }, log.slice(-7).map((l) => h('div', {}, l)));
    root.replaceChildren(h('div', { class: 'two' }, row('A', [1, 2]), row('B', [2, 1])), logEl, ended ? h('div', { class: 'status warn' }, 'Remède : prendre les verrous toujours dans le même ordre, et rejouer la transaction en cas de deadlock.') : '');
  };
  paint();
  return h('section', { class: 'card' }, h('div', { class: 'row spread' }, h('h3', { style: 'margin:0' }, 'Deux virements, un drame'), btn('Recommencer', () => { reset(); paint(); }, { class: 'small' })), root);
}
