// Le gestionnaire de verrous lourds : matrice de conflits réelle, file d'attente équitable,
// détection de deadlock. Pur, sans DOM.

export const MODES = [
  'AccessShare', 'RowShare', 'RowExclusive', 'ShareUpdateExclusive',
  'Share', 'ShareRowExclusive', 'Exclusive', 'AccessExclusive',
];

// Tableau 13.2 de la doc PostgreSQL : pour chaque mode, ceux avec lesquels il entre en conflit.
const CONFLICTS = {
  AccessShare: ['AccessExclusive'],
  RowShare: ['Exclusive', 'AccessExclusive'],
  RowExclusive: ['Share', 'ShareRowExclusive', 'Exclusive', 'AccessExclusive'],
  ShareUpdateExclusive: ['ShareUpdateExclusive', 'Share', 'ShareRowExclusive', 'Exclusive', 'AccessExclusive'],
  Share: ['RowExclusive', 'ShareUpdateExclusive', 'ShareRowExclusive', 'Exclusive', 'AccessExclusive'],
  ShareRowExclusive: ['RowExclusive', 'ShareUpdateExclusive', 'Share', 'ShareRowExclusive', 'Exclusive', 'AccessExclusive'],
  Exclusive: ['RowShare', 'RowExclusive', 'ShareUpdateExclusive', 'Share', 'ShareRowExclusive', 'Exclusive', 'AccessExclusive'],
  AccessExclusive: MODES,
};

export const conflicts = (a, b) => CONFLICTS[a].includes(b);

/** Qui prend quoi, en vrai. */
export const STATEMENT_LOCKS = {
  SELECT: 'AccessShare',
  'SELECT FOR UPDATE': 'RowShare',
  'INSERT / UPDATE / DELETE': 'RowExclusive',
  VACUUM: 'ShareUpdateExclusive',
  'CREATE INDEX CONCURRENTLY': 'ShareUpdateExclusive',
  'CREATE INDEX': 'Share',
  'ALTER TABLE (la plupart)': 'AccessExclusive',
  'DROP TABLE': 'AccessExclusive',
  TRUNCATE: 'AccessExclusive',
};

export class LockManager {
  constructor() {
    this.held = []; // { who, resource, mode }
    this.queue = []; // { who, resource, mode } dans l'ordre d'arrivée
  }

  clone() {
    const c = new LockManager();
    c.held = structuredClone(this.held);
    c.queue = structuredClone(this.queue);
    return c;
  }

  holds(who, resource, mode) {
    return this.held.some((l) => l.who === who && l.resource === resource && l.mode === mode);
  }

  /** Une demande passe si elle ne gêne ni les détenteurs, ni personne de déjà en file. */
  canGrant(req, waitersAhead) {
    const blockedByHolder = this.held.some((l) => l.resource === req.resource && l.who !== req.who && conflicts(req.mode, l.mode));
    if (blockedByHolder) return false;
    return !waitersAhead.some((w) => w.resource === req.resource && w.who !== req.who && conflicts(req.mode, w.mode));
  }

  /** Renvoie 'granted' ou 'waiting'. */
  acquire(who, resource, mode) {
    if (this.holds(who, resource, mode)) return 'granted';
    const req = { who, resource, mode };
    const ahead = this.queue.filter((w) => w.resource === resource);
    if (this.canGrant(req, ahead)) {
      this.held.push(req);
      return 'granted';
    }
    this.queue.push(req);
    return 'waiting';
  }

  /** Libère tout ce que tient `who` (fin de transaction), puis réveille la file dans l'ordre. */
  releaseAll(who) {
    this.held = this.held.filter((l) => l.who !== who);
    this.queue = this.queue.filter((w) => w.who !== who);
    return this.wake();
  }

  wake() {
    const woken = [];
    const stillWaiting = [];
    for (const req of this.queue) {
      const ahead = stillWaiting.filter((w) => w.resource === req.resource);
      if (this.canGrant(req, ahead)) {
        this.held.push(req);
        woken.push(req);
      } else {
        stillWaiting.push(req);
      }
    }
    this.queue = stillWaiting;
    return woken;
  }

  /** Qui bloque `who` ? Équivalent de pg_blocking_pids(). */
  blockers(who) {
    const out = new Set();
    for (const req of this.queue.filter((w) => w.who === who)) {
      for (const l of this.held) if (l.resource === req.resource && l.who !== who && conflicts(req.mode, l.mode)) out.add(l.who);
      for (const w of this.queue) {
        if (w === req) break;
        if (w.resource === req.resource && w.who !== who && conflicts(req.mode, w.mode)) out.add(w.who);
      }
    }
    return [...out];
  }

  /** Cherche un cycle dans le graphe d'attente. Renvoie le cycle, ou null. */
  findDeadlock() {
    const nodes = [...new Set(this.queue.map((w) => w.who))];
    const path = [];
    const visit = (n) => {
      const at = path.indexOf(n);
      if (at !== -1) return path.slice(at);
      path.push(n);
      for (const m of this.blockers(n)) {
        const c = visit(m);
        if (c) return c;
      }
      path.pop();
      return null;
    };
    for (const n of nodes) {
      const c = visit(n);
      if (c) return c;
    }
    return null;
  }
}
