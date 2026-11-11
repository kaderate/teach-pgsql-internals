import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MiniPg, COMMITTED, ABORTED } from '../web/sim/engine.js';

const seeded = (s) => () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);

function withRow(opts) {
  const db = new MiniPg(opts);
  db.autocommit('setup', (d) => d.insert('setup', 42, 'Gérard'));
  return db;
}

test('un UPDATE non validé est invisible pour les autres, visible pour soi', () => {
  const db = withRow();
  db.begin('A');
  db.update('A', 42, 'Gégé');
  db.begin('B');
  assert.equal(db.read('B', 42).tuple.value, 'Gérard');
  assert.equal(db.read('A', 42).tuple.value, 'Gégé');
  db.commit('A');
  assert.equal(db.read('B', 42).tuple.value, 'Gégé', 'read committed : nouveau snapshot à chaque ordre');
});

test('repeatable read garde son snapshot', () => {
  const db = withRow();
  db.begin('B', { isolation: 'repeatable read' });
  assert.equal(db.read('B', 42).tuple.value, 'Gérard');
  db.begin('A');
  db.update('A', 42, 'Gégé');
  db.commit('A');
  assert.equal(db.read('B', 42).tuple.value, 'Gérard');
  assert.equal(db.update('B', 42, 'Conflit').conflict, true, 'could not serialize access');
});

test('un SELECT ne consomme pas de xid et n’écrit aucun WAL', () => {
  const db = withRow();
  const walBefore = db.wal.length;
  const xidBefore = db.nextXid;
  db.begin('R');
  db.read('R', 42);
  assert.deepEqual(db.commit('R'), { readOnly: true });
  assert.equal(db.wal.length, walBefore);
  assert.equal(db.nextXid, xidBefore);
});

test('l’UPDATE crée une version et ne touche pas à la valeur de l’ancienne', () => {
  const db = withRow();
  db.begin('A');
  const r = db.update('A', 42, 'Gégé');
  const page = db.pageView(r.oldPage);
  assert.equal(page.slots[r.oldLp].tuple.value, 'Gérard');
  assert.equal(page.slots[r.oldLp].tuple.xmax, db.txs.A.xid);
  assert.equal(page.slots[r.lp].tuple.xmin, db.txs.A.xid);
});

test('une deuxième écriture sur la même ligne attend le premier', () => {
  const db = withRow();
  db.begin('A');
  db.update('A', 42, 'A');
  db.begin('B');
  const xidA = db.txs.A.xid;
  assert.deepEqual(db.update('B', 42, 'B'), { blockedBy: xidA });
  db.commit('A');
  assert.equal(db.update('B', 42, 'B').lp !== undefined, true);
  db.commit('B');
  assert.equal(db.visibleRows()[42], 'B');
});

test('COMMIT force le WAL sur disque, pas les pages de données', () => {
  const db = new MiniPg();
  db.begin('A');
  db.insert('A', 1, 'x');
  assert.equal(db.flushedLsn, 0);
  db.commit('A');
  assert.equal(db.flushedLsn, db.nextLsn - 1);
  assert.equal(db.disk[0], undefined, 'la page reste en mémoire, sale');
  assert.equal(db.frames.find((f) => f?.page.no === 0).dirty, true);
});

test('ROLLBACK ne défait rien physiquement', () => {
  const db = withRow();
  db.begin('A');
  const r = db.update('A', 42, 'Gégé');
  const xid = db.txs.A.xid;
  db.rollback('A');
  assert.equal(db.clog[xid], ABORTED);
  assert.equal(db.pageView(r.page).slots[r.lp].tuple.value, 'Gégé', 'le tuple est toujours là');
  assert.equal(db.visibleRows()[42], 'Gérard');
});

test('crash : le validé survit, le non validé disparaît', () => {
  const db = withRow();
  db.begin('A');
  db.update('A', 42, 'non validé');
  db.flushWal(); // même présent dans le WAL, sans COMMIT ça ne compte pas
  db.crash();
  const log = db.recover();
  assert.equal(db.visibleRows()[42], 'Gérard');
  assert.ok(log.some((l) => l.action === 'abort'));
});

test('crash avec synchronous_commit=off : on perd le commit, jamais la cohérence', () => {
  const db = withRow();
  db.cfg.syncCommit = false;
  db.autocommit('A', (d) => d.update('A', 42, 'perdu'));
  assert.equal(db.visibleRows()[42], 'perdu');
  db.crash();
  db.recover();
  assert.equal(db.visibleRows()[42], 'Gérard');
});

test('recovery idempotente : le LSN de page évite de rejouer deux fois', () => {
  // Sans full page write : avec, la page serait restaurée depuis son image puis rejouée.
  const db = withRow({ fullPageWrites: false });
  db.checkpoint();
  db.autocommit('A', (d) => d.update('A', 42, 'v2'));
  db.frames.forEach((f, i) => { if (f?.dirty) db.writePage(i); }); // la page est déjà à jour sur disque
  db.crash();
  const log = db.recover();
  assert.ok(log.some((l) => l.action === 'skip'));
  assert.equal(db.visibleRows()[42], 'v2');
});

test('le WAL part avant la page, même en éviction', () => {
  const db = new MiniPg({ bufferFrames: 1, pageCapacity: 1 });
  db.begin('A');
  db.insert('A', 1, 'a');
  db.insert('A', 2, 'b'); // force l'éviction de la page 0, sale, non validée
  assert.ok(db.disk[0], 'STEAL : une page non validée peut atteindre le disque');
  assert.ok(db.flushedLsn >= db.disk[0].lsn, 'mais jamais avant son WAL');
});

test('règle WAL-before-data cassée : un non-validé sur disque sans trace dans le WAL', () => {
  const db = new MiniPg({ walBeforeData: false, bufferFrames: 1, pageCapacity: 1 });
  db.begin('A');
  db.insert('A', 1, 'a');
  db.insert('A', 2, 'b');
  assert.ok(db.disk[0].lsn > db.flushedLsn, 'la page est en avance sur le WAL durable : invariant violé');
});

test('page déchirée : les full page writes réparent, sans eux c’est la corruption', () => {
  for (const [fpw, expectCorrupt] of [[true, false], [false, true]]) {
    const db = new MiniPg({ fullPageWrites: fpw });
    db.autocommit('s', (d) => d.insert('s', 1, 'v1'));
    db.checkpoint();
    db.autocommit('s', (d) => d.update('s', 1, 'v2'));
    db.crash({ tornPage: 0 });
    db.recover();
    assert.equal(db.corrupted.length > 0, expectCorrupt, `fpw=${fpw}`);
    if (!expectCorrupt) assert.equal(db.visibleRows()[1], 'v2');
  }
});

test('le checkpoint raccourcit le rejeu', () => {
  const noCp = withRow();
  for (let i = 0; i < 3; i++) noCp.autocommit('A', (d) => d.update('A', 42, `v${i}`));
  const withCp = noCp.clone();
  withCp.checkpoint();
  noCp.crash();
  withCp.crash();
  assert.ok(noCp.recover().filter((l) => l.action === 'redo').length > 0);
  assert.equal(withCp.recover().filter((l) => l.action === 'redo').length, 0);
  assert.equal(withCp.visibleRows()[42], 'v2');
  assert.equal(noCp.visibleRows()[42], 'v2');
});

test('vacuum : une vieille transaction l’empêche de nettoyer', () => {
  const db = withRow();
  db.begin('vieux', { isolation: 'repeatable read' });
  db.read('vieux', 42);
  db.autocommit('A', (d) => d.update('A', 42, 'v2'));
  let r = db.vacuum();
  assert.equal(r.removed, 0);
  assert.equal(db.read('vieux', 42).tuple.value, 'Gérard');
  db.commit('vieux');
  r = db.vacuum();
  assert.equal(r.removed, 1);
  assert.equal(db.visibleRows()[42], 'v2');
});

test('HOT : l’index ne bouge pas, la racine devient une redirection', () => {
  const db = withRow();
  const before = [...db.index[42]];
  db.autocommit('A', (d) => d.update('A', 42, 'v2'));
  assert.deepEqual(db.index[42], before, 'pas de nouvelle entrée d’index');
  const r = db.vacuum();
  assert.equal(r.redirects, 1);
  assert.equal(db.pageView(0).slots[before[0][1]].state, 'redirect');
  assert.equal(db.visibleRows()[42], 'v2');
  db.begin('R');
  assert.equal(db.read('R', 42).tuple.value, 'v2');
  db.commit('R');
});

test('colonne indexée modifiée : pas de HOT, nouvelle entrée d’index', () => {
  const db = withRow();
  const before = [...db.index[42]];
  db.begin('A');
  const r = db.update('A', 42, 'v2', { indexedColumnChanged: true });
  assert.equal(r.hot, false);
  assert.notDeepEqual(db.index[42], before);
  db.commit('A');
  assert.equal(db.visibleRows()[42], 'v2');
});

test('propriété : après n’importe quel crash, tout commit durable survit et rien d’autre', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const rand = seeded(seed);
    const db = new MiniPg({ bufferFrames: 2, pageCapacity: 3 });
    const ids = [1, 2, 3, 4, 5, 6];
    const model = {}; // l'état attendu : seulement ce qui est validé et durable
    let open = null; // { name, writes }
    for (let step = 0; step < 40; step++) {
      const r = rand();
      if (r < 0.1) { db.checkpoint(); continue; }
      if (r < 0.2) { db.vacuum(); continue; }
      if (!open) {
        db.begin('T');
        open = { writes: {} };
      }
      const id = ids[Math.floor(rand() * ids.length)];
      const value = `s${seed}.${step}`;
      if (r < 0.75) {
        if (db.read('T', id)) db.update('T', id, value);
        else db.insert('T', id, value);
        open.writes[id] = value;
      } else if (r < 0.9) {
        db.commit('T');
        Object.assign(model, open.writes);
        open = null;
      } else {
        db.rollback('T');
        open = null;
      }
    }
    // Une transaction restée ouverte ne doit pas survivre, et une lecture neuve doit déjà être juste.
    db.crash();
    db.recover();
    assert.deepEqual(db.corrupted, []);
    assert.deepEqual(db.visibleRows(), Object.fromEntries(Object.entries(model).map(([k, v]) => [k, v])), `seed ${seed}`);
    for (const st of Object.values(db.clog)) assert.ok([COMMITTED, ABORTED].includes(st));
  }
});

test('clock sweep : une page très utilisée survit à l’éviction', () => {
  const db = new MiniPg({ bufferFrames: 2, pageCapacity: 1 });
  db.autocommit('s', (d) => { d.insert('s', 1, 'a'); d.insert('s', 2, 'b'); d.insert('s', 3, 'c'); });
  db.checkpoint();
  for (let i = 0; i < 4; i++) db.pin(2);
  db.pin(0);
  assert.notEqual(db.findFrame(2), -1, 'la page 2 reste en mémoire');
});

test('clone : indépendant de l’original', () => {
  const db = withRow();
  const c = db.clone();
  c.autocommit('A', (d) => d.update('A', 42, 'x'));
  assert.equal(db.visibleRows()[42], 'Gérard');
  assert.equal(c.visibleRows()[42], 'x');
});

test('WAL-before-data violée : un xid réattribué fait ressusciter une écriture jamais validée', () => {
  const db = new MiniPg({ walBeforeData: false, pageCapacity: 6, bufferFrames: 2 });
  db.autocommit('s', (d) => { d.insert('s', 1, 'un'); d.insert('s', 2, 'deux'); });
  db.checkpoint();
  db.begin('A');
  db.update('A', 1, 'perdu'); // xmax = xid de A, jamais durable
  db.writePage(db.findFrame(0)); // la page part sur disque AVANT son WAL
  db.crash();
  db.recover();
  assert.equal(db.visibleRows()[1], 'un', 'au redémarrage, tout semble normal');
  db.begin('B');
  db.update('B', 2, 'deux bis'); // B reçoit le même xid que A
  db.commit('B');
  assert.equal(db.visibleRows()[1], 'perdu', 'l’UPDATE annulé par le crash devient réel');
});

test('avec la règle respectée, le même scénario ne perd rien', () => {
  const db = new MiniPg({ pageCapacity: 6, bufferFrames: 2 });
  db.autocommit('s', (d) => { d.insert('s', 1, 'un'); d.insert('s', 2, 'deux'); });
  db.checkpoint();
  db.begin('A');
  db.update('A', 1, 'perdu');
  db.writePage(db.findFrame(0));
  db.crash();
  db.recover();
  db.begin('B');
  db.update('B', 2, 'deux bis');
  db.commit('B');
  assert.equal(db.visibleRows()[1], 'un');
  assert.equal(db.visibleRows()[2], 'deux bis');
});
