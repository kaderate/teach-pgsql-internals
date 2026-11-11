// MiniPg : un Postgres de poche, pur (pas de DOM), déterministe et clonable.
//
// Fidèle sur le fond : MVCC à la Postgres (xmin/xmax, snapshot, clog), pages slottées, buffer
// pool clock-sweep, WAL logique-physique avec LSN, règle WAL-before-data, checkpoint, recovery
// par rejeu, pruning / vacuum, chaînes HOT.
// Simplifié et assumé : pages de 4 slots par défaut, une seule table, pas de sous-transactions,
// visibilité sans hint bits, index résumé à id → liste de line pointers.

export const COMMITTED = 'committed';
export const ABORTED = 'aborted';
export const IN_PROGRESS = 'in progress';

const clone = (x) => structuredClone(x);

function newPage(no, capacity) {
  return { no, lsn: 0, capacity, slots: [], torn: false };
}

export class MiniPg {
  constructor({ pageCapacity = 4, bufferFrames = 3, syncCommit = true, walBeforeData = true, fullPageWrites = true } = {}) {
    this.cfg = { pageCapacity, bufferFrames, syncCommit, walBeforeData, fullPageWrites };
    this.nextXid = 100;
    this.clog = {}; // xid → statut ; survit au crash uniquement via le WAL rejoué
    this.disk = {}; // no → page durable
    this.frames = Array.from({ length: bufferFrames }, () => null); // { page, dirty, usage }
    this.hand = 0;
    this.wal = []; // { lsn, xid, type, page?, ... }
    this.nextLsn = 1;
    this.flushedLsn = 0;
    this.redoLsn = 1;
    this.index = {}; // id → liste de [page, lp] : une entrée par version non-HOT, comme un vrai B-tree
    this.pinned = []; // pages intouchables pendant l'opération en cours (les pins de Postgres)
    this.txs = {}; // xid/nom de session → transaction ouverte
    this.pageCount = 0;
    this.stats = { hits: 0, misses: 0, diskWrites: 0, walFlushes: 0, evictions: 0 };
    this.lastEvent = null;
    this.crashed = false;
    this.corrupted = [];
    this.fpiSinceCheckpoint = new Set();
  }

  clone() {
    const c = Object.create(MiniPg.prototype);
    const raw = { ...this, fpiSinceCheckpoint: [...this.fpiSinceCheckpoint] };
    Object.assign(c, clone(raw));
    c.fpiSinceCheckpoint = new Set(raw.fpiSinceCheckpoint);
    return c;
  }

  // ---------- Transactions et snapshots ----------
  begin(session, { isolation = 'read committed' } = {}) {
    if (this.txs[session]) throw new Error(`${session} a déjà une transaction ouverte`);
    this.txs[session] = { session, xid: null, isolation, snapshot: isolation === 'repeatable read' ? null : null, frozenSnapshot: null };
    return this.txs[session];
  }

  /** Un xid n'est attribué qu'à la première écriture, comme dans le vrai Postgres. */
  assignXid(session) {
    const tx = this.txs[session];
    if (!tx.xid) {
      tx.xid = this.nextXid++;
      this.clog[tx.xid] = IN_PROGRESS;
    }
    return tx.xid;
  }

  inProgressXids() {
    return Object.values(this.txs).map((t) => t.xid).filter(Boolean);
  }

  takeSnapshot() {
    const xip = this.inProgressXids().sort((a, b) => a - b);
    return { xmin: xip.length ? xip[0] : this.nextXid, xmax: this.nextXid, xip };
  }

  /** Le snapshot d'une instruction : neuf en read committed, figé en repeatable read. */
  statementSnapshot(session) {
    const tx = this.txs[session];
    if (!tx) return this.takeSnapshot();
    if (tx.isolation === 'repeatable read') {
      tx.frozenSnapshot ??= this.takeSnapshot();
      return tx.frozenSnapshot;
    }
    return this.takeSnapshot();
  }

  /** Vu par ce snapshot, ce xid est-il validé ? */
  xidVisible(xid, snap, ownXid) {
    if (xid === ownXid) return true;
    if (xid >= snap.xmax || snap.xip.includes(xid)) return false;
    return this.clog[xid] === COMMITTED;
  }

  /** Le cœur du MVCC : HeapTupleSatisfiesMVCC, sans les hint bits. */
  isVisible(tuple, snap, ownXid = null) {
    if (!this.xidVisible(tuple.xmin, snap, ownXid)) return false;
    if (tuple.xmax == null) return true;
    return !this.xidVisible(tuple.xmax, snap, ownXid);
  }

  /** Explique le verdict, pour l'interface. */
  explainVisibility(tuple, snap, ownXid = null) {
    const name = (x) => {
      if (x === ownXid) return `${x} (c'est moi)`;
      if (x >= snap.xmax) return `${x} (après mon snapshot)`;
      if (snap.xip.includes(x)) return `${x} (en cours à mon snapshot)`;
      return `${x} (${this.clog[x] ?? '?'})`;
    };
    if (!this.xidVisible(tuple.xmin, snap, ownXid)) return { visible: false, why: `xmin = ${name(tuple.xmin)} : ce créateur n'existe pas pour moi.` };
    if (tuple.xmax == null) return { visible: true, why: `xmin = ${name(tuple.xmin)} et pas de xmax : vivant.` };
    if (this.xidVisible(tuple.xmax, snap, ownXid)) return { visible: false, why: `xmax = ${name(tuple.xmax)} : je vois sa suppression.` };
    return { visible: true, why: `xmin OK, xmax = ${name(tuple.xmax)} : cette suppression n'existe pas pour moi.` };
  }

  // ---------- Buffer pool ----------
  findFrame(no) {
    return this.frames.findIndex((f) => f && f.page.no === no);
  }

  /** Clock sweep : l'aiguille décrémente usage et prend le premier cadre à 0. */
  evictOne() {
    for (let i = 0; i < this.frames.length; i++) if (!this.frames[i]) return i;
    for (let guard = 0; guard < 100; guard++) {
      const i = this.hand;
      this.hand = (this.hand + 1) % this.frames.length;
      const f = this.frames[i];
      if (this.pinned.includes(f.page.no)) continue;
      if (f.usage > 0) { f.usage--; continue; }
      if (f.dirty) this.writePage(i);
      this.stats.evictions++;
      this.lastEvent = { kind: 'evict', page: f.page.no };
      this.frames[i] = null;
      return i;
    }
    throw new Error('buffer pool bloqué');
  }

  /** Amène une page en mémoire. Renvoie le cadre. */
  pin(no) {
    let i = this.findFrame(no);
    if (i !== -1) {
      this.stats.hits++;
      this.frames[i].usage = Math.min(5, this.frames[i].usage + 1);
      return this.frames[i];
    }
    this.stats.misses++;
    i = this.evictOne();
    const page = this.disk[no] ? clone(this.disk[no]) : newPage(no, this.cfg.pageCapacity);
    this.frames[i] = { page, dirty: false, usage: 1 };
    return this.frames[i];
  }

  /** Écrit une page sur disque, en respectant la règle d'or : le WAL d'abord. */
  writePage(i, { torn = false } = {}) {
    const f = this.frames[i];
    if (this.cfg.walBeforeData && f.page.lsn > this.flushedLsn) this.flushWal(f.page.lsn);
    const stored = clone(f.page);
    stored.torn = torn;
    this.disk[f.page.no] = stored;
    f.dirty = false;
    this.stats.diskWrites++;
  }

  // ---------- WAL ----------
  appendWal(rec) {
    const r = { lsn: this.nextLsn++, ...rec };
    this.wal.push(r);
    return r;
  }

  flushWal(upTo = this.nextLsn - 1) {
    if (upTo > this.flushedLsn) {
      this.flushedLsn = Math.min(upTo, this.nextLsn - 1);
      this.stats.walFlushes++;
    }
  }

  /** Full page write : la première écriture après checkpoint emporte une image de la page. */
  maybeFpi(frame) {
    if (!this.cfg.fullPageWrites || this.fpiSinceCheckpoint.has(frame.page.no)) return null;
    this.fpiSinceCheckpoint.add(frame.page.no);
    return clone(frame.page);
  }

  // ---------- Écritures ----------
  pageWithRoom() {
    for (let no = 0; no < this.pageCount; no++) {
      const f = this.pin(no);
      if (this.firstFreeSlot(f.page) !== -1) return no;
    }
    return this.pageCount++;
  }

  firstFreeSlot(page) {
    const empty = page.slots.findIndex((s) => s.state === 'unused');
    if (empty !== -1) return empty;
    return page.slots.length < page.capacity ? page.slots.length : -1;
  }

  placeTuple(frame, tuple) {
    const lp = this.firstFreeSlot(frame.page);
    frame.page.slots[lp] = { state: 'normal', tuple };
    return lp;
  }

  stamp(frame, rec) {
    frame.page.lsn = rec.lsn;
    frame.dirty = true;
  }

  insert(session, id, value) {
    const xid = this.assignXid(session);
    const no = this.pageWithRoom();
    const frame = this.pin(no);
    const fpi = this.maybeFpi(frame);
    const tuple = { xmin: xid, xmax: null, id, value, hot: false, heapOnly: false, next: null };
    const lp = this.placeTuple(frame, tuple);
    this.addIndexEntry(id, [no, lp]);
    const rec = this.appendWal({ xid, type: 'HEAP_INSERT', page: no, lp, tuple: clone(tuple), fpi, index: { id, at: [no, lp] } });
    this.stamp(frame, rec);
    return { page: no, lp };
  }

  addIndexEntry(id, at) {
    (this.index[id] ??= []).push(at);
  }

  /**
   * Suit chaque entrée d'index puis sa chaîne HOT jusqu'à la version visible par ce snapshot.
   * `getPage` permet de lire sans toucher au buffer pool (affichage, tests).
   */
  walk(id, snap, ownXid, getPage) {
    for (const entry of this.index[id] ?? []) {
      let at = entry;
      for (let guard = 0; at && guard < 64; guard++) {
        const slot = getPage(at[0])?.slots[at[1]];
        if (slot?.state === 'redirect') { at = [at[0], slot.to]; continue; }
        if (slot?.state !== 'normal' || slot.tuple.id !== id) break;
        if (this.isVisible(slot.tuple, snap, ownXid)) return { page: at[0], lp: at[1], tuple: slot.tuple };
        at = slot.tuple.hot ? slot.tuple.next : null;
      }
    }
    return null;
  }

  findVisible(id, snap, ownXid) {
    return this.walk(id, snap, ownXid, (no) => this.pin(no).page);
  }

  read(session, id) {
    const tx = this.txs[session];
    const snap = this.statementSnapshot(session);
    return this.findVisible(id, snap, tx?.xid ?? null);
  }

  /**
   * UPDATE : pose xmax sur l'ancienne version et crée la nouvelle.
   * Si une autre transaction en cours tient la ligne, renvoie { blockedBy: xid }.
   */
  update(session, id, value, { indexedColumnChanged = false } = {}) {
    const found = this.prepareWrite(session, id);
    if (found.blockedBy || found.conflict || found.missing) return found;
    const { page, lp, xid } = found;
    const frame = this.pin(page);
    this.pinned = [page]; // comme un vrai pin : cette page ne doit pas partir pendant qu'on l'édite
    const old = frame.page.slots[lp].tuple;
    const newTuple = { xmin: xid, xmax: null, id, value, hot: false, heapOnly: false, next: null };
    const fpi = this.maybeFpi(frame);
    const samePageSlot = this.firstFreeSlot(frame.page);
    const canHot = samePageSlot !== -1 && !indexedColumnChanged;
    let target;
    if (samePageSlot !== -1) {
      target = { frame, lp: this.placeTuple(frame, newTuple), page };
    } else {
      const no = this.pageWithRoom();
      const f2 = this.pin(no);
      target = { frame: f2, lp: this.placeTuple(f2, newTuple), page: no };
    }
    this.pinned = [];
    old.hot = canHot; // une ancienne tentative annulée peut avoir laissé un autre chaînage
    newTuple.heapOnly = canHot;
    old.xmax = xid;
    old.next = [target.page, target.lp];
    if (!canHot) this.addIndexEntry(id, [target.page, target.lp]);
    const rec = this.appendWal({
      xid, type: canHot ? 'HEAP_HOT_UPDATE' : 'HEAP_UPDATE', page, lp, newPage: target.page, newLp: target.lp,
      tuple: clone(newTuple), hot: canHot, fpi, index: canHot ? null : { id, at: [target.page, target.lp] },
    });
    this.stamp(frame, rec);
    if (target.frame !== frame) this.stamp(target.frame, rec);
    return { page: target.page, lp: target.lp, oldPage: page, oldLp: lp, hot: canHot };
  }

  delete(session, id) {
    const found = this.prepareWrite(session, id);
    if (found.blockedBy || found.conflict || found.missing) return found;
    const frame = this.pin(found.page);
    const fpi = this.maybeFpi(frame);
    frame.page.slots[found.lp].tuple.xmax = found.xid;
    const rec = this.appendWal({ xid: found.xid, type: 'HEAP_DELETE', page: found.page, lp: found.lp, fpi });
    this.stamp(frame, rec);
    return { page: found.page, lp: found.lp };
  }

  /** Commun à UPDATE/DELETE : trouve la version et vérifie que personne ne la tient. */
  prepareWrite(session, id) {
    const tx = this.txs[session];
    if (!tx) throw new Error(`${session} n'a pas de transaction`);
    const snap = this.statementSnapshot(session);
    const own = tx.xid;
    const found = this.findVisible(id, snap, own);
    if (!found) return { missing: true };
    const { xmax } = found.tuple;
    if (xmax != null && xmax !== own && this.clog[xmax] === IN_PROGRESS) return { blockedBy: xmax };
    // repeatable read : la ligne visible a été modifiée par un autre, validé après notre snapshot.
    if (xmax != null && this.clog[xmax] === COMMITTED) return { conflict: true };
    return { page: found.page, lp: found.lp, xid: this.assignXid(session) };
  }

  commit(session) {
    const tx = this.txs[session];
    if (!tx) throw new Error(`${session} n'a pas de transaction`);
    delete this.txs[session];
    if (!tx.xid) return { readOnly: true }; // pas de xid, pas de WAL : un SELECT ne coûte aucun fsync
    const rec = this.appendWal({ xid: tx.xid, type: 'COMMIT' });
    if (this.cfg.syncCommit) this.flushWal(rec.lsn);
    this.clog[tx.xid] = COMMITTED;
    return { lsn: rec.lsn, durable: this.flushedLsn >= rec.lsn };
  }

  rollback(session) {
    const tx = this.txs[session];
    if (!tx) throw new Error(`${session} n'a pas de transaction`);
    delete this.txs[session];
    if (!tx.xid) return {};
    this.appendWal({ xid: tx.xid, type: 'ABORT' });
    this.clog[tx.xid] = ABORTED; // aucun undo : les tuples restent, ils sont juste invisibles
    return {};
  }

  /** Auto-commit : ce que fait un ordre SQL hors transaction. */
  autocommit(session, fn) {
    this.begin(session);
    const r = fn(this);
    this.commit(session);
    return r;
  }

  // ---------- Checkpoint ----------
  checkpoint() {
    // Le point de reprise est fixé AVANT d'écrire : tout ce qui suit sera rejoué si besoin.
    this.redoLsn = this.nextLsn;
    this.frames.forEach((f, i) => { if (f?.dirty) this.writePage(i); });
    const rec = this.appendWal({ xid: null, type: 'CHECKPOINT', redo: this.redoLsn });
    this.flushWal(rec.lsn);
    this.fpiSinceCheckpoint = new Set();
    return { redo: this.redoLsn, lsn: rec.lsn };
  }

  // ---------- Crash et recovery ----------
  /** kill -9 : la mémoire disparaît ; seul ce qui a été fsync survit. */
  crash({ tornPage = null } = {}) {
    if (tornPage != null) {
      const i = this.findFrame(tornPage);
      if (i !== -1 && this.frames[i].dirty) {
        const half = clone(this.disk[tornPage] ?? newPage(tornPage, this.cfg.pageCapacity));
        half.torn = true;
        this.disk[tornPage] = half;
      }
    }
    this.frames = this.frames.map(() => null);
    this.hand = 0;
    this.wal = this.wal.filter((r) => r.lsn <= this.flushedLsn);
    this.nextLsn = this.flushedLsn + 1;
    this.txs = {};
    this.clog = {};
    this.index = {};
    this.crashed = true;
  }

  /** Rejoue le WAL depuis le dernier checkpoint. Renvoie le journal de ce qui a été fait. */
  recover() {
    const log = [];
    this.corrupted = [];
    // Le clog et l'index sont reconstruits ici par simplification ; le vrai clog a ses fichiers.
    for (const r of this.wal) {
      if (r.type === 'COMMIT') this.clog[r.xid] = COMMITTED;
      if (r.type === 'ABORT') this.clog[r.xid] = ABORTED;
      if (r.xid && !this.clog[r.xid]) this.clog[r.xid] = IN_PROGRESS;
      if (r.index) this.addIndexEntry(r.index.id, r.index.at);
    }
    const redoFrom = this.redoLsn;
    const apply = (no, r, fn) => {
      let page = this.disk[no] ?? newPage(no, this.cfg.pageCapacity);
      if (r.fpi && r.page === no && r.lsn >= redoFrom) {
        page = clone(r.fpi);
        log.push({ lsn: r.lsn, action: 'fpi', page: no, text: `Image complète de la page ${no} restaurée` });
      }
      if (page.torn) {
        if (!this.corrupted.includes(no)) this.corrupted.push(no);
        this.disk[no] = page;
        log.push({ lsn: r.lsn, action: 'corrupt', page: no, text: `Page ${no} déchirée et aucune image pour la réparer` });
        return;
      }
      if (page.lsn >= r.lsn) {
        log.push({ lsn: r.lsn, action: 'skip', page: no, text: `Page ${no} déjà à jour (LSN ${page.lsn} ≥ ${r.lsn}) : ignoré` });
        return;
      }
      fn(page);
      page.lsn = r.lsn;
      this.disk[no] = page;
      this.pageCount = Math.max(this.pageCount, no + 1);
      log.push({ lsn: r.lsn, action: 'redo', page: no, text: `${r.type} rejoué sur la page ${no}` });
    };
    for (const r of this.wal) {
      if (r.lsn < redoFrom) continue;
      if (r.type === 'HEAP_INSERT') apply(r.page, r, (p) => { p.slots[r.lp] = { state: 'normal', tuple: clone(r.tuple) }; });
      else if (r.type === 'HEAP_DELETE') apply(r.page, r, (p) => { p.slots[r.lp].tuple.xmax = r.xid; });
      else if (r.type === 'HEAP_UPDATE' || r.type === 'HEAP_HOT_UPDATE') {
        const sameTarget = r.newPage === r.page;
        apply(r.page, r, (p) => {
          const old = p.slots[r.lp].tuple;
          old.xmax = r.xid;
          old.next = [r.newPage, r.newLp];
          old.hot = !!r.hot;
          if (sameTarget) p.slots[r.newLp] = { state: 'normal', tuple: clone(r.tuple) };
        });
        if (!sameTarget) apply(r.newPage, { ...r, fpi: null }, (p) => { p.slots[r.newLp] = { state: 'normal', tuple: clone(r.tuple) }; });
      } else if (r.type === 'PRUNE') apply(r.page, r, (p) => { p.slots = clone(r.slots); });
      else if (r.type === 'COMMIT' || r.type === 'ABORT') log.push({ lsn: r.lsn, action: 'clog', text: `Transaction ${r.xid} : ${r.type === 'COMMIT' ? 'validée' : 'annulée'}` });
    }
    // Une transaction sans record COMMIT n'a jamais eu lieu.
    for (const [xid, st] of Object.entries(this.clog)) {
      if (st === IN_PROGRESS) {
        this.clog[xid] = ABORTED;
        log.push({ action: 'abort', text: `Transaction ${xid} sans COMMIT dans le WAL : considérée annulée, sans rien défaire` });
      }
    }
    for (const n of Object.keys(this.disk)) this.pageCount = Math.max(this.pageCount, Number(n) + 1);
    // Le compteur repart du WAL : tout xid perdu avec la fin du journal sera réattribué.
    this.nextXid = Math.max(100, ...this.wal.map((r) => (r.xid ?? 99) + 1));
    // Le vrai index est rejoué comme une page ; ici on oublie les entrées vers des slots vidés.
    for (const [id, entries] of Object.entries(this.index)) {
      this.index[id] = entries.filter(([p, l]) => {
        const slot = this.disk[p]?.slots[l];
        return slot?.state === 'redirect' || (slot?.state === 'normal' && slot.tuple.id === Number(id));
      });
    }
    this.crashed = false;
    return log;
  }

  // ---------- VACUUM ----------
  /** Le plus vieux xmin que quelqu'un peut encore voir : l'horizon du vacuum. */
  xminHorizon() {
    const open = Object.values(this.txs);
    let h = this.nextXid;
    for (const t of open) {
      if (t.xid) h = Math.min(h, t.xid);
      if (t.frozenSnapshot) h = Math.min(h, t.frozenSnapshot.xmin);
    }
    return h;
  }

  isDead(tuple, horizon) {
    if (this.clog[tuple.xmin] === ABORTED) return true;
    if (tuple.xmax == null) return false;
    return this.clog[tuple.xmax] === COMMITTED && tuple.xmax < horizon;
  }

  /**
   * Vacuum d'une page : libère les versions mortes pour tout le monde.
   * Une racine de chaîne HOT morte devient une redirection : l'index n'a pas à changer.
   */
  vacuum() {
    const horizon = this.xminHorizon();
    const result = { removed: 0, kept: 0, redirects: 0, horizon };
    for (let no = 0; no < this.pageCount; no++) {
      const frame = this.pin(no);
      const before = JSON.stringify(frame.page.slots);
      const slots = frame.page.slots;
      const isIndexed = (lp) => Object.values(this.index).some((list) => list.some(([p, l]) => p === no && l === lp));
      // Depuis un slot, le premier tuple vivant de la chaîne HOT, sur cette page.
      const firstAlive = (lp) => {
        for (let guard = 0; guard < 64; guard++) {
          const s2 = slots[lp];
          if (s2?.state === 'redirect') { lp = s2.to; continue; }
          if (s2?.state !== 'normal') return null;
          if (!this.isDead(s2.tuple, horizon)) return lp;
          if (!s2.tuple.hot || s2.tuple.next?.[0] !== no) return null;
          lp = s2.tuple.next[1];
        }
        return null;
      };
      const unindex = (lp) => {
        for (const [id, list] of Object.entries(this.index)) {
          this.index[id] = list.filter(([p, l]) => !(p === no && l === lp));
        }
      };
      // D'abord calculer sur l'état d'origine, puis appliquer : la chaîne doit rester lisible.
      const plan = slots.map((slot, lp) => {
        if (slot.state === 'redirect') {
          const to = firstAlive(lp);
          return to == null ? { free: true } : { redirect: to };
        }
        if (slot.state !== 'normal') return null;
        if (!this.isDead(slot.tuple, horizon)) {
          if (slot.tuple.xmax != null) result.kept++;
          return null;
        }
        result.removed++;
        if (isIndexed(lp)) {
          const to = firstAlive(lp);
          if (to != null) { result.redirects++; return { redirect: to }; }
        }
        return { free: true };
      });
      plan.forEach((p, lp) => {
        if (!p) return;
        if (p.free) { unindex(lp); slots[lp] = { state: 'unused' }; }
        else slots[lp] = { state: 'redirect', to: p.redirect };
      });
      if (JSON.stringify(frame.page.slots) !== before) {
        const fpi = this.maybeFpi(frame);
        const rec = this.appendWal({ xid: null, type: 'PRUNE', page: no, slots: clone(frame.page.slots), fpi });
        this.stamp(frame, rec);
      }
    }
    return result;
  }

  // ---------- Lecture pour l'interface et les tests ----------
  /** Toutes les lignes visibles par un observateur neuf. */
  visibleRows() {
    const snap = this.takeSnapshot();
    const rows = {};
    for (const id of Object.keys(this.index)) {
      const r = this.findVisibleNoTouch(Number(id), snap);
      if (r) rows[id] = r.value;
    }
    return rows;
  }

  pageView(no) {
    const i = this.findFrame(no);
    return i !== -1 ? this.frames[i].page : this.disk[no] ?? null;
  }

  findVisibleNoTouch(id, snap) {
    return this.walk(id, snap, null, (no) => this.pageView(no))?.tuple ?? null;
  }

  counts() {
    let live = 0;
    let dead = 0;
    const horizon = this.xminHorizon();
    for (let no = 0; no < this.pageCount; no++) {
      for (const slot of this.pageView(no)?.slots ?? []) {
        if (slot.state !== 'normal') continue;
        if (this.isDead(slot.tuple, horizon)) dead++;
        else if (slot.tuple.xmax == null || this.clog[slot.tuple.xmax] !== COMMITTED) live++;
        else dead++; // mort mais encore visible d'un vieux snapshot : du bloat qu'on ne peut pas retirer
      }
    }
    return { live, dead, pages: this.pageCount };
  }
}
