// Deux sessions, une ligne, plusieurs versions. Qui voit quoi ?
import { h, btn, md } from '../dom.js';
import { MiniPg } from '../../sim/engine.js';
import { setMap } from '../map.js';

const NAMES = ['Gégé', 'Gérardo', 'Géraldine', 'Gégé II', 'Le Gérard', 'Gérard le Retour'];

export function mvccLab() {
  let db;
  let blocked;
  let log;
  let nameIdx;
  let why = null;
  const reset = () => {
    why = null;
    db = new MiniPg({ pageCapacity: 8 });
    db.autocommit('setup', (d) => d.insert('setup', 42, 'Gérard'));
    blocked = {};
    log = ['La ligne 42 existe, créée par la transaction 100, validée.'];
    nameIdx = 0;
  };
  reset();
  const root = h('div', { 'aria-live': 'polite' });
  const say = (m) => { log.push(m); };
  const snapOf = (s) => {
    const tx = db.txs[s];
    return tx?.frozenSnapshot ?? db.takeSnapshot();
  };
  const fmtSnap = (sn) => `xmin:${sn.xmin} xmax:${sn.xmax} en cours:[${sn.xip.join(',')}]`;
  const retry = () => {
    for (const [s, b] of Object.entries(blocked)) {
      const r = db.update(s, 42, b.value);
      if (r.blockedBy) continue;
      delete blocked[s];
      if (r.conflict) {
        db.rollback(s);
        say(`${s} : ERROR could not serialize access due to concurrent update. En repeatable read, on ne relit pas. Transaction annulée.`);
      } else {
        say(`${s} : réveillée. Elle relit la dernière version validée et écrit « ${b.value} ».`);
      }
    }
  };
  const action = (s, kind, opt) => {
    if (kind === 'begin') {
      db.begin(s, { isolation: opt });
      say(`${s} : BEGIN (${opt}). Pas encore de xid : rien n'a été écrit.`);
    } else if (kind === 'select') {
      if (db.txs[s]) db.statementSnapshot(s);
      const r = db.txs[s] ? db.read(s, 42) : db.findVisible(42, db.takeSnapshot(), null);
      say(`${s} : SELECT → ${r ? `« ${r.tuple.value} », version (0,${r.lp + 1})` : 'aucune ligne'}`);
    } else if (kind === 'update') {
      const value = NAMES[nameIdx++ % NAMES.length];
      const r = db.update(s, 42, value);
      if (r.blockedBy) {
        blocked[s] = { value };
        say(`${s} : UPDATE bloqué ! La ligne porte xmax=${r.blockedBy}, encore en cours. ${s} dort sur le xid ${r.blockedBy}.`);
      } else if (r.conflict) {
        db.rollback(s);
        say(`${s} : ERROR could not serialize access due to concurrent update.`);
      } else if (r.missing) {
        say(`${s} : UPDATE 0, aucune ligne visible.`);
      } else {
        say(`${s} : UPDATE. xmax posé sur l'ancienne version, nouvelle version en (0,${r.lp + 1}) avec xmin=${db.txs[s].xid}.`);
      }
    } else if (kind === 'commit') {
      const r = db.commit(s);
      say(r.readOnly ? `${s} : COMMIT. Aucun xid, donc aucun WAL ni fsync.` : `${s} : COMMIT. Le statut du xid passe à « committed » dans le clog. Les tuples ne bougent pas d'un octet.`);
      retry();
    } else if (kind === 'rollback') {
      db.rollback(s);
      say(`${s} : ROLLBACK. Rien n'est défait : le clog dit « aborted », et ce tuple devient invisible.`);
      retry();
    }
    setMap(kind === 'commit' ? ['executor', 'walbuf', 'wal', 'clogbuf'] : ['executor', 'buffers', 'clogbuf'], `Session **${s}**`);
    paint();
  };
  const sessionPane = (s) => {
    const tx = db.txs[s];
    const isBlocked = !!blocked[s];
    const row = [];
    if (!tx) {
      row.push(btn('BEGIN', () => action(s, 'begin', 'read committed'), { class: 'small' }));
      row.push(btn('BEGIN REPEATABLE READ', () => action(s, 'begin', 'repeatable read'), { class: 'small' }));
    }
    row.push(btn('SELECT', () => action(s, 'select'), { class: 'small', disabled: isBlocked }));
    row.push(btn('UPDATE', () => action(s, 'update'), { class: 'small', disabled: isBlocked || !tx }));
    if (tx) {
      row.push(btn('COMMIT', () => action(s, 'commit'), { class: 'small primary', disabled: isBlocked }));
      row.push(btn('ROLLBACK', () => action(s, 'rollback'), { class: 'small', disabled: isBlocked }));
    }
    return h('div', { class: `pane${isBlocked ? ' wait' : ''}` },
      h('h4', {}, `Session ${s}${isBlocked ? ' ⏳ bloquée' : ''}`),
      h('div', { class: 'caption-small' }, tx ? `${tx.isolation} · xid : ${tx.xid ?? 'aucun pour l\'instant'}` : 'hors transaction'),
      h('div', { class: 'caption-small' }, tx?.frozenSnapshot ? `Snapshot figé : ${fmtSnap(tx.frozenSnapshot)}` : `Prochain snapshot : ${fmtSnap(db.takeSnapshot())}`),
      h('div', { class: 'row tight', style: 'margin-top:6px' }, row));
  };
  const paint = () => {
    const page = db.pageView(0);
    const rows = page.slots.map((s, i) => {
      if (s.state !== 'normal') return null;
      const t = s.tuple;
      const verdict = (sess) => {
        const v = db.explainVisibility(t, snapOf(sess), db.txs[sess]?.xid ?? null);
        return h('td', {}, h('button', { type: 'button', class: `chip ${v.visible ? 'ok' : 'no'}`, onclick: () => { why = `${sess} et la version (0,${i + 1}) : ${v.why}`; paint(); } }, v.visible ? 'visible' : 'non'));
      };
      return h('tr', {}, h('td', {}, `(0,${i + 1})`), h('td', {}, String(t.xmin)), h('td', {}, String(t.xmax ?? 0)), h('td', {}, t.value), verdict('A'), verdict('B'));
    });
    const clog = Object.entries(db.clog).map(([x, st]) => h('span', { class: `chip ${st === 'committed' ? 'ok' : st === 'aborted' ? 'no' : 'wait'}` }, `${x} : ${st}`));
    const logEl = h('div', { class: 'log' }, log.slice(-8).map((l) => h('div', {}, l)));
    root.replaceChildren(
      h('div', { class: 'two' }, sessionPane('A'), sessionPane('B')),
      h('div', { class: 'scroll', style: 'margin-top:10px' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['ctid', 'xmin', 'xmax', 'name', 'A voit ?', 'B voit ?'].map((c) => h('th', {}, c)))),
        h('tbody', {}, rows))),
      why ? h('div', { class: 'status' }, why) : md('p', 'Clique sur un verdict pour lire la règle appliquée.', { class: 'caption-small' }),
      h('div', { style: 'margin-top:8px' }, h('b', {}, 'Clog : '), clog),
      logEl);
    logEl.scrollTop = logEl.scrollHeight;
  };
  paint();
  return h('section', { class: 'card' }, h('div', { class: 'row spread' }, h('h3', { style: 'margin:0' }, 'Le théâtre de Gérard'), btn('Recommencer', () => { reset(); paint(); }, { class: 'small' })),
    md('p', 'Les transactions commencent à 100 dans cette simulation. Toutes les écritures se font dans une transaction : ouvre-la avec BEGIN.', { class: 'caption-small' }),
    root);
}
