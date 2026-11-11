// Réplication physique en streaming : une horloge, des LSN et les vrais points d'attente.
// Pur, sans DOM. Unité : 1 LSN = 1 Mo de WAL pour garder des chiffres parlants.

export const SYNC_MODES = {
  off: 'Le primaire n\'attend personne, pas même son disque',
  local: 'Attend son propre disque, pas la réplica',
  remote_write: 'Attend que la réplica ait écrit (sans fsync)',
  on: 'Attend que la réplica ait fait son fsync',
  remote_apply: 'Attend que la réplica ait rejoué : lisible là-bas',
};

export class Replication {
  constructor({ mode = 'local', writeRate = 10, network = 100, replayRate = 100, connected = true, slot = true, maxSlotWal = Infinity } = {}) {
    Object.assign(this, { mode, writeRate, network, replayRate, connected, slot, maxSlotWal });
    this.t = 0;
    this.current = 0; // pg_current_wal_lsn
    this.primaryFlush = 0;
    this.sent = 0;
    this.write = 0;
    this.flush = 0;
    this.replay = 0;
    this.blockedByQuery = 0; // ticks restants d'une longue requête sur la réplica
    this.maxStandbyDelay = 3;
    this.queryAge = 0;
    this.cancelled = 0;
    this.feedback = false;
    this.commitsWaiting = 0;
    this.committed = 0;
    this.segmentsRecycled = 0;
    this.lostSlot = false;
    this.diskFull = false;
    this.diskLimit = Infinity;
    this.oldestRetained = 0;
    this.pendingCommits = [];
  }

  /** L'accusé de réception qui libère un COMMIT, selon synchronous_commit. */
  ackFor(mode = this.mode) {
    switch (mode) {
      case 'off': return Infinity;
      case 'local': return this.primaryFlush;
      case 'remote_write': return this.write;
      case 'on': return this.flush;
      case 'remote_apply': return this.replay;
      default: throw new Error(mode);
    }
  }

  tick() {
    this.t++;
    if (!this.diskFull) {
      // Les COMMIT synchrones bloqués n'empêchent pas d'autres écrivains d'arriver, mais ici la
      // charge est un groupe fermé de clients : s'ils attendent tous, plus personne n'écrit.
      const acks = this.ackFor();
      const stuck = this.pendingCommits.filter((c) => c > acks).length;
      const capacity = Math.max(0, 8 - stuck);
      const produced = Math.min(this.writeRate, capacity > 0 ? this.writeRate : 0);
      if (produced > 0) {
        this.current += produced;
        this.pendingCommits.push(this.current);
      }
    }
    this.primaryFlush = this.current;
    if (this.connected && !this.lostSlot) {
      this.sent = Math.min(this.current, this.sent + this.network);
      this.write = this.sent;
      this.flush = this.write;
    }
    if (this.blockedByQuery > 0) {
      // Une lecture sur la réplica a besoin de lignes que le rejeu veut retirer.
      this.queryAge++;
      this.blockedByQuery--;
      if (!this.feedback && this.queryAge > this.maxStandbyDelay) {
        this.blockedByQuery = 0;
        this.cancelled++;
        this.queryAge = 0;
      }
    } else {
      this.replay = Math.min(this.flush, this.replay + this.replayRate);
      this.queryAge = 0;
    }
    const acks = this.ackFor();
    const before = this.pendingCommits.length;
    this.pendingCommits = this.pendingCommits.filter((c) => c > acks);
    this.committed += before - this.pendingCommits.length;
    this.commitsWaiting = this.pendingCommits.length;
    // Le slot retient le WAL tant que la réplica ne l'a pas confirmé.
    this.oldestRetained = this.slot && !this.lostSlot ? this.flush : Math.max(this.current - 64, 0);
    if (this.slot && !this.lostSlot && this.walOnDisk() > this.maxSlotWal) {
      this.lostSlot = true;
      this.oldestRetained = Math.max(this.current - 64, 0);
    }
    if (this.walOnDisk() >= this.diskLimit) this.diskFull = true;
    return this;
  }

  walOnDisk() { return this.current - this.oldestRetained; }

  /** Les quatre retards, exactement comme dans pg_stat_replication. */
  lag() {
    return {
      sent: this.current - this.sent,
      write: this.current - this.write,
      flush: this.current - this.flush,
      replay: this.current - this.replay,
    };
  }

  startLongQuery(ticks = 12) { this.blockedByQuery = ticks; this.queryAge = 0; }
  run(n) { for (let i = 0; i < n; i++) this.tick(); return this; }
}
