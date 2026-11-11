import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LockManager, MODES, conflicts } from '../web/sim/locks.js';
import { seqScanCost, indexScanCost, bitmapScanCost, comparePlans, seqTakeover, DEFAULTS } from '../web/sim/planner.js';
import { Replication } from '../web/sim/replication.js';
import { terminate } from '../server.js';

test('matrice des conflits : symétrique, AccessShare ne gêne que AccessExclusive', () => {
  for (const a of MODES) for (const b of MODES) assert.equal(conflicts(a, b), conflicts(b, a), `${a}/${b}`);
  assert.deepEqual(MODES.filter((m) => conflicts('AccessShare', m)), ['AccessExclusive']);
  assert.equal(conflicts('RowExclusive', 'RowExclusive'), false, 'deux UPDATE ne se gênent pas au niveau table');
  assert.equal(conflicts('Share', 'RowExclusive'), true, 'CREATE INDEX bloque les écritures');
  assert.equal(conflicts('ShareUpdateExclusive', 'RowExclusive'), false, 'VACUUM ne bloque pas les écritures');
  assert.equal(conflicts('Share', 'Share'), false);
});

test('la catastrophe de l’ALTER : tout le monde se range derrière lui', () => {
  const lm = new LockManager();
  assert.equal(lm.acquire('vieille_tx', 'users', 'AccessShare'), 'granted');
  assert.equal(lm.acquire('migration', 'users', 'AccessExclusive'), 'waiting');
  assert.equal(lm.acquire('select_innocent', 'users', 'AccessShare'), 'waiting', 'file équitable');
  assert.deepEqual(lm.blockers('select_innocent'), ['migration']);
  assert.deepEqual(lm.blockers('migration'), ['vieille_tx']);
  const woken = lm.releaseAll('vieille_tx');
  assert.deepEqual(woken.map((w) => w.who), ['migration']);
  assert.equal(lm.queue.length, 1);
  assert.deepEqual(lm.releaseAll('migration').map((w) => w.who), ['select_innocent']);
});

test('deadlock détecté', () => {
  const lm = new LockManager();
  lm.acquire('A', 'ligne1', 'Exclusive');
  lm.acquire('B', 'ligne2', 'Exclusive');
  assert.equal(lm.findDeadlock(), null);
  lm.acquire('A', 'ligne2', 'Exclusive');
  assert.equal(lm.findDeadlock(), null);
  lm.acquire('B', 'ligne1', 'Exclusive');
  assert.deepEqual(new Set(lm.findDeadlock()), new Set(['A', 'B']));
  lm.releaseAll('B');
  assert.equal(lm.findDeadlock(), null);
  assert.ok(lm.holds('A', 'ligne2', 'Exclusive'));
});

test('planner : la formule du seq scan est exacte', () => {
  const c = seqScanCost({ pages: 100, rows: 1000, quals: 1 });
  assert.equal(c.total, 100 + 1000 * 0.01 + 1000 * 0.0025);
  // Valeur relevée sur le vrai Postgres du labo : voir test/labs.run.js.
});

test('planner : forte sélectivité → index ; faible → seq scan', () => {
  const t = { pages: 1000, rows: 100000, indexPages: 280, quals: 1 };
  assert.equal(comparePlans({ ...t, selectivity: 0.00001 }).best, 'Index Scan');
  assert.equal(comparePlans({ ...t, selectivity: 0.9 }).best, 'Seq Scan');
});

test('planner : la corrélation rend l’index moins cher', () => {
  const t = { pages: 1000, rows: 100000, indexPages: 280, selectivity: 0.05 };
  assert.ok(indexScanCost({ ...t, correlation: 1 }).total < indexScanCost({ ...t, correlation: 0 }).total);
});

test('planner : à moins de 11 % du vrai planner, avec la même bascule', () => {
  // Relevé sur le labo (PostgreSQL 17.11), orders.user_id, sans parallélisme :
  // EXPLAIN SELECT * FROM orders WHERE user_id <= k
  const t = { pages: 3334, rows: 400000, indexPages: 1099, quals: 1, correlation: 0 };
  const REAL = [
    { selectivity: 0.0001, index: 173.16, bitmap: 159.13 },
    { selectivity: 0.001, index: 1587.73, bitmap: 1182.55 },
    { selectivity: 0.01, bitmap: 3623.56 },
    { selectivity: 0.02, bitmap: 3552.43 },
    { selectivity: 0.05, bitmap: 3871.77 },
    { selectivity: 0.1, bitmap: 4404.03 },
    { selectivity: 0.2, bitmap: 5466.69 },
    { selectivity: 0.3, bitmap: 6500.40 },
    { selectivity: 0.4, bitmap: 7554.32 },
  ];
  const close = (sim, real) => assert.ok(Math.abs(sim - real) / real < 0.11, `${sim.toFixed(0)} contre ${real}`);
  for (const r of REAL) {
    const row = { ...t, selectivity: r.selectivity };
    if (r.index) close(indexScanCost(row).total, r.index);
    close(bitmapScanCost(row).total, r.bitmap);
  }
  // Vrai planner : Index Scan à 0,1 %, Seq Scan à 1 % (bitmap interdit) ; Bitmap à 40 %, Seq Scan à 60 %.
  const idx = seqTakeover(t, DEFAULTS, 'index');
  assert.ok(idx > 0.001 && idx < 0.01, `bascule index : ${idx}`);
  const bmp = seqTakeover(t, DEFAULTS, 'bitmap');
  assert.ok(bmp > 0.3 && bmp < 0.6, `bascule bitmap : ${bmp}`);
});

test('planner : baisser random_page_cost déplace la bascule', () => {
  const t = { pages: 1000, rows: 100000, indexPages: 280, quals: 1, correlation: 0 };
  const ssd = seqTakeover(t, { ...DEFAULTS, random_page_cost: 1.1 });
  const hdd = seqTakeover(t, DEFAULTS);
  assert.ok(ssd > hdd, `${ssd} > ${hdd}`);
});

test('réplication : les LSN sont ordonnés', () => {
  const r = new Replication({ writeRate: 20, network: 15, replayRate: 10 });
  for (let i = 0; i < 50; i++) {
    r.tick();
    assert.ok(r.current >= r.sent && r.sent >= r.write && r.write >= r.flush && r.flush >= r.replay);
  }
  assert.ok(r.lag().replay > 0);
});

test('réplication : réseau lent et rejeu lent ne donnent pas le même symptôme', () => {
  const net = new Replication({ writeRate: 20, network: 5, replayRate: 100 }).run(30);
  assert.ok(net.lag().sent > 0);
  assert.equal(net.flush, net.replay);
  const replay = new Replication({ writeRate: 20, network: 100, replayRate: 5 }).run(30);
  assert.equal(replay.lag().flush, 0);
  assert.ok(replay.lag().replay > 0);
});

test('réplication : synchrone et réplica morte, les écritures s’arrêtent', () => {
  const r = new Replication({ mode: 'on', connected: false, writeRate: 10 }).run(30);
  assert.equal(r.committed, 0);
  assert.ok(r.commitsWaiting > 0);
  const stuckAt = r.current;
  r.run(10);
  assert.equal(r.current, stuckAt, 'plus de clients disponibles');
  r.connected = true;
  r.run(5);
  assert.ok(r.committed > 0);
});

test('réplication : asynchrone, réplica morte, le slot retient le WAL jusqu’au disque plein', () => {
  const r = new Replication({ connected: false, writeRate: 10 });
  r.diskLimit = 200;
  r.run(25);
  assert.equal(r.diskFull, true);
  const noSlot = new Replication({ connected: false, writeRate: 10, slot: false });
  noSlot.diskLimit = 200;
  noSlot.run(50);
  assert.equal(noSlot.diskFull, false);
});

test('réplication : max_slot_wal_keep_size sacrifie la réplica pour sauver le primaire', () => {
  const r = new Replication({ connected: false, writeRate: 10, maxSlotWal: 100 });
  r.diskLimit = 200;
  r.run(50);
  assert.equal(r.lostSlot, true);
  assert.equal(r.diskFull, false);
});

test('réplication : une requête longue bloque le rejeu puis se fait annuler, sauf feedback', () => {
  const r = new Replication({ writeRate: 10 });
  r.run(5);
  r.startLongQuery(12);
  r.run(3);
  assert.ok(r.lag().replay > 0);
  r.run(3);
  assert.equal(r.cancelled, 1);
  const f = new Replication({ writeRate: 10 });
  f.feedback = true;
  f.startLongQuery(6);
  f.run(10);
  assert.equal(f.cancelled, 0);
});

test('serveur : complète le ; sans abîmer les méta-commandes', () => {
  assert.equal(terminate('select 1'), 'select 1;');
  assert.equal(terminate('select 1;'), 'select 1;');
  assert.equal(terminate('\\d users'), '\\d users');
  assert.equal(terminate("select pg_current_wal_lsn() as avant \\gset"), 'select pg_current_wal_lsn() as avant \\gset');
  assert.equal(terminate('   '), '');
});
