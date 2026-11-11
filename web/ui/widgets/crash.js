// Mémoire, disque, WAL : écris, valide, tue le serveur, et compte les morts.
import { h, btn, md } from '../dom.js';
import { MiniPg } from '../../sim/engine.js';
import { setMap } from '../map.js';
import { elephantRain } from '../blocks.js';

const IDS = [1, 2, 3];

export function crashLab() {
  let db;
  let acked; // ce que le client croit, d'après les OK reçus
  let open; // écritures de la transaction ouverte
  let log;
  let counter;
  let recoveryLog;
  let verdict;
  let cfg = { syncCommit: true, walBeforeData: true, fullPageWrites: true };
  const reset = () => {
    db = new MiniPg({ pageCapacity: 6, bufferFrames: 2, ...cfg });
    db.autocommit('s', (d) => IDS.forEach((i) => d.insert('s', i, `v0`)));
    db.checkpoint();
    acked = { 1: 'v0', 2: 'v0', 3: 'v0' };
    open = null;
    log = ['Trois lignes validées et un checkpoint : tout est sur disque.'];
    counter = 0;
    recoveryLog = null;
    verdict = null;
  };
  reset();
  const root = h('div', { 'aria-live': 'polite' });
  const say = (m) => log.push(m);

  const write = (id) => {
    if (!open) { db.begin('T'); open = {}; say('BEGIN'); }
    const value = `v${++counter}`;
    db.update('T', id, value);
    open[id] = value;
    say(`UPDATE ligne ${id} → ${value} : tuple dans shared_buffers, record ajouté aux WAL buffers. Rien sur disque.`);
    setMap(['executor', 'buffers', 'walbuf'], 'L\'UPDATE ne touche que la **mémoire**.');
    paint();
  };
  const commit = () => {
    const r = db.commit('T');
    Object.assign(acked, open);
    open = null;
    const actual = db.visibleRows();
    const ghosts = IDS.filter((i) => actual[i] !== acked[i]);
    if (ghosts.length) {
      verdict = { cls: 'bad', text: `🧟 Ligne ${ghosts.join(', ')} : la base contient ${ghosts.map((i) => actual[i] ?? 'rien').join(', ')}, alors que le client n'a jamais reçu OK pour ça. La page est partie sur disque avant son WAL, le xid a été réattribué après le crash, et ce vieux tuple se croit validé. L'atomicité vient de mourir, sans la moindre erreur.` };
      Object.assign(acked, actual);
    }
    say(r.durable ? `COMMIT : WAL forcé sur disque jusqu'au LSN ${r.lsn}, puis OK au client.` : `COMMIT : OK au client tout de suite (synchronous_commit=off). Le LSN ${r.lsn} n'est pas encore sur disque !`);
    setMap(cfg.syncCommit ? ['executor', 'walbuf', 'wal', 'client'] : ['executor', 'walbuf', 'client'], cfg.syncCommit ? 'Le **WAL** part sur disque, pas les pages.' : 'Personne n\'attend le disque.');
    paint();
  };
  const rollback = () => {
    db.rollback('T');
    open = null;
    say('ROLLBACK : un record ABORT, aucune page à défaire.');
    paint();
  };
  const flushOnePage = () => {
    const i = db.frames.findIndex((f) => f?.dirty);
    if (i === -1) { say('bgwriter : aucune page sale.'); paint(); return; }
    const no = db.frames[i].page.no;
    const before = db.flushedLsn;
    db.writePage(i);
    say(`bgwriter : page ${no} écrite sur disque${db.flushedLsn > before ? ` (il a d'abord forcé le WAL jusqu'au LSN ${db.flushedLsn}, sinon il n'avait pas le droit)` : ''}${!cfg.walBeforeData ? '. Règle désactivée : le WAL n\'a PAS été forcé.' : ''}.`);
    setMap(['bgwriter', 'buffers', 'heap'], 'Le **bgwriter** écrit une page.');
    paint();
  };
  const checkpoint = () => {
    const r = db.checkpoint();
    say(`CHECKPOINT : toutes les pages sales sur disque. Point de reprise : LSN ${r.redo}.`);
    setMap(['checkpointer', 'buffers', 'heap', 'wal'], 'Le **checkpointer** fait le ménage.');
    paint();
  };
  const crash = (torn) => {
    const dirty = db.frames.find((f) => f?.dirty);
    db.crash(torn && dirty ? { tornPage: dirty.page.no } : {});
    open = null;
    say(`💥 kill -9${torn && dirty ? ` pendant l'écriture de la page ${dirty.page.no} : elle est déchirée sur disque` : ''}. Mémoire perdue, WAL non flushé perdu.`);
    setMap(['postmaster'], '💥 Plus personne.');
    paint();
  };
  const recover = () => {
    recoveryLog = db.recover();
    const actual = db.visibleRows();
    const lost = IDS.filter((i) => actual[i] !== acked[i]);
    if (db.corrupted.length) {
      verdict = { cls: 'bad', text: `Page ${db.corrupted.join(', ')} corrompue : moitié ancienne, moitié neuve, et aucune image pour la restaurer. Sans full_page_writes, le rejeu se fait sur des octets invalides. C'est l'heure des sauvegardes.` };
    } else if (lost.length) {
      verdict = { cls: cfg.syncCommit && cfg.walBeforeData ? 'bad' : 'warn', text: `Ligne(s) ${lost.join(', ')} : le client a reçu OK pour ${lost.map((i) => acked[i]).join(', ')}, la base contient ${lost.map((i) => actual[i] ?? 'rien').join(', ')}. Un commit perdu, mais la base reste cohérente.` };
    } else {
      verdict = { cls: 'good', text: 'Tout ce qui a reçu OK est là, et rien d\'autre. ACID tient parole.' };
      elephantRain(6);
    }
    // À partir d'ici, le client recommence depuis la vérité de la base.
    Object.assign(acked, actual);
    setMap(['wal', 'buffers', 'heap'], 'Rejeu du **WAL**.');
    paint();
  };
  const toggle = (key, label) => h('label', { class: 'row tight' },
    h('input', { type: 'checkbox', checked: cfg[key], onchange: (e) => { cfg = { ...cfg, [key]: e.target.checked }; reset(); paint(); } }), label);

  const paintPage = (page, title, dirty, flushedFn) => h('div', { class: `mini-page${dirty ? ' dirty' : ''}` },
    h('h5', {}, `${title} · LSN ${page.lsn}${page.torn ? ' · 🧨 DÉCHIRÉE' : ''}${dirty ? ' · sale' : ''}`),
    page.slots.map((s, i) => s.state === 'normal'
      ? h('div', { class: `slot${s.tuple.xmax != null ? ' dead' : ''}` }, `${i + 1}: ligne ${s.tuple.id}=${s.tuple.value} x${s.tuple.xmin}${s.tuple.xmax ? `→x${s.tuple.xmax}` : ''}`)
      : h('div', { class: 'slot unused' }, `${i + 1}: ${s.state}`)), flushedFn);

  const paint = () => {
    const crashed = db.crashed;
    const frames = db.frames.filter(Boolean);
    const walChips = db.wal.slice(-14).map((r) => h('span', { class: `chip ${r.lsn <= db.flushedLsn ? 'flushed' : 'pending'}` }, `${r.lsn}:${r.type.replace('HEAP_', '')}${r.xid ? ` x${r.xid}` : ''}${r.fpi ? ' +image' : ''}`));
    root.replaceChildren(
      h('div', { class: 'two' },
        h('div', { class: 'pane ram' }, h('h4', {}, crashed ? '🧠 Mémoire : ☠️ vide' : '🧠 Mémoire (shared_buffers)'),
          frames.length ? frames.map((f) => paintPage(f.page, `Page ${f.page.no}`, f.dirty)) : h('div', {}, '(vide)')),
        h('div', { class: 'pane disk' }, h('h4', {}, '💾 Disque (base/)'),
          Object.values(db.disk).length ? Object.values(db.disk).map((p) => paintPage(p, `Page ${p.no}`, false)) : h('div', {}, '(vide)'))),
      h('div', { class: 'pane', style: 'margin-top:10px' }, h('h4', {}, `📜 WAL · sur disque jusqu'au LSN ${db.flushedLsn} · point de reprise ${db.redoLsn}`),
        walChips, md('p', 'Vert : sur disque. Jaune pointillé : encore en mémoire, mort en cas de crash.', { class: 'caption-small' })),
      h('div', { class: 'row', style: 'margin-top:10px' },
        ...(crashed
          ? [btn('🔁 Redémarrer : rejouer le WAL', recover, { class: 'primary big' })]
          : [
            ...IDS.map((i) => btn(`UPDATE ligne ${i}`, () => write(i))),
            btn('COMMIT', commit, { class: 'primary', disabled: !open }),
            btn('ROLLBACK', rollback, { disabled: !open }),
            btn('bgwriter : écrire 1 page', flushOnePage),
            btn('CHECKPOINT', checkpoint),
            btn('💥 kill -9', () => crash(false), { class: 'danger' }),
            btn('💥 kill -9 en pleine écriture', () => crash(true), { class: 'danger' }),
          ])),
      h('div', { style: 'margin-top:8px' }, h('b', {}, 'Le client a reçu OK pour : '), IDS.map((i) => h('span', { class: 'chip' }, `ligne ${i}=${acked[i]}`))),
      verdict ? h('div', { class: `status ${verdict.cls}` }, verdict.text) : '',
      recoveryLog ? h('div', { class: 'log' }, recoveryLog.length ? recoveryLog.map((l) => h('div', {}, `${l.lsn ?? '  '} ${l.text}`)) : h('div', {}, 'Rien à rejouer : le checkpoint était à jour.')) : '',
      h('div', { class: 'log' }, log.slice(-6).map((l) => h('div', {}, l))),
    );
  };
  paint();
  return h('section', { class: 'card' }, h('div', { class: 'row spread' }, h('h3', { style: 'margin:0' }, 'La salle de crash-test'), btn('Recommencer', () => { reset(); paint(); }, { class: 'small' })),
    h('div', { class: 'row', style: 'margin:8px 0 10px' }, toggle('syncCommit', 'synchronous_commit'), toggle('fullPageWrites', 'full_page_writes'), toggle('walBeforeData', 'WAL avant les données (ne le décoche qu\'ici)')),
    root);
}
