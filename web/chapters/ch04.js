import { journey } from '../ui/widgets/basics.js';

const steps = [
  { title: '1. Jusqu\'au plan : comme le SELECT', map: ['parser', 'analyzer', 'rewriter', 'planner'],
    text: 'Même chemin, à un détail près : l\'analyzer prend un verrou `RowExclusiveLock` sur la table et ses index. Il ne gêne pas les autres `UPDATE`, seulement ceux qui veulent figer la table entière.' },
  { title: '2. Trouver la ligne', map: ['executor', 'buffers'],
    text: 'Le plan est un Index Scan sous un nœud `ModifyTable`. Le scan trouve Gérard exactement comme le `SELECT`, avec le snapshot de l\'instruction.' },
  { title: '3. Obtenir un xid', map: ['executor', 'clogbuf'],
    ask: { q: 'À quel moment ta transaction reçoit-elle son numéro (xid) ?',
      options: [
        { t: 'Dès le `BEGIN`', why: 'Les transactions en lecture seule n\'en consomment jamais. Comme le stock de xid est limité (32 bits), on les économise.' },
        { t: 'À sa première écriture', ok: true, why: 'Avant ça, elle n\'a qu\'un identifiant virtuel, purement en mémoire. Les lectures ne brûlent donc aucun xid.' },
        { t: 'Au `COMMIT`', why: 'Trop tard : `xmin` et `xmax` en ont besoin dès l\'écriture du tuple.' },
      ] },
    text: 'Le backend prend le prochain xid, s\'inscrit dans la liste des transactions actives (la source des snapshots) et prend un verrou exclusif **sur son propre xid**. Le sens de ce verrou apparaît à l\'étape suivante.' },
  { title: '4. Le verrou de ligne : aucune table de verrous !', map: ['executor', 'buffers', 'locks'],
    ask: { q: 'Où est stocké le verrou d\'une ligne ?',
      options: [
        { t: 'Dans la table des verrous en mémoire partagée', why: 'Mettre à jour un milliard de lignes exploserait une table de taille fixe.' },
        { t: 'Dans la ligne elle-même, via `xmax`', ok: true, why: 'Poser `xmax` = mon xid sur le tuple, c\'est verrouiller la ligne. Aucune limite sur leur nombre, et aucune mémoire consommée.' },
      ] },
    text: ['Si une autre transaction en cours tient déjà la ligne, tu ne peux pas attendre « sur la ligne » : tu attends **sur son xid**, le fameux verrou de l\'étape 3. Quand elle finit, tout le monde est réveillé.', 'C\'est pour ça que `pg_stat_activity` affiche `wait_event = transactionid`, ce que tu verras au chapitre 7. Et en `READ COMMITTED`, le réveillé relit la version la plus récente et reprend depuis là.'] },
  { title: '5. Écrire d\'abord le WAL, en mémoire', map: ['executor', 'buffers', 'walbuf'],
    text: ['Dans une section critique, avec la page verrouillée, le backend :', '① pose `xmax` sur l\'ancien tuple et insère le nouveau dans le buffer ② marque la page **sale** ③ ajoute un record `HEAP_UPDATE` (ou `HOT_UPDATE`) aux WAL buffers ④ écrit le LSN du record dans l\'en-tête de la page.', 'Rien n\'a touché le disque. Rien.'],
    show: `rmgr: Heap  len (rec/tot): 84/84, tx: 916, lsn: 0/16C3CE70
  desc: HOT_UPDATE old_xmax: 916, old_off: 49, old_infobits: [], flags: 0x6, new_xmax: 0, new_off: 50
  blkref #0: rel 1663/16384/16389 blk 816` },
  { title: '6. Les index', map: ['executor', 'buffers', 'walbuf'],
    ask: { q: 'Tu changes `name`, qui n\'est pas indexé. La table a 5 index. Combien sont modifiés ?',
      options: [
        { t: 'Les 5 : chaque nouvelle version doit être indexée', why: 'C\'est le cas général, et le coût caché des index. Mais ici on a de la chance.' },
        { t: 'Aucun, si le nouveau tuple tient dans la même page', ok: true, why: 'C\'est une mise à jour **HOT** (Heap-Only Tuple) : les index pointent vers l\'ancien tuple, qui renvoie au nouveau. Si une colonne indexée change, ou si la page est pleine, il faut toucher **tous** les index.' },
      ] },
    text: 'C\'est pourquoi un index inutile ne coûte pas que sa place : il peut empêcher des HOT et donc faire exploser les écritures. `fillfactor` laisse de la place dans les pages pour favoriser le HOT.' },
  { title: '7. Fin de l\'instruction : UPDATE 1', map: ['executor', 'client'],
    text: 'Le client reçoit `UPDATE 1`. Sans `BEGIN`, le `COMMIT` s\'enchaîne automatiquement. Sinon, à ce stade, tout reste en mémoire, et d\'autres transactions peuvent attendre derrière ton verrou. D\'où la nocivité des transactions qui traînent.' },
  { title: '8. COMMIT : le record décisif', map: ['executor', 'walbuf', 'wal'],
    ask: { q: 'Quel est l\'instant exact où ta transaction devient durable ?',
      options: [
        { t: 'Quand la page modifiée est écrite sur disque', why: 'Ta page attendra probablement encore des minutes. Si le COMMIT devait l\'attendre, ce serait des écritures aléatoires à chaque transaction.' },
        { t: 'Quand le record COMMIT est passé par `fsync` dans le WAL', ok: true, why: 'Le backend écrit un record COMMIT et force le WAL sur disque jusqu\'à lui. À partir de là, un crash ne peut plus l\'effacer.' },
        { t: 'Quand le statut passe à « committed » dans le clog', why: 'Le clog est mis à jour juste après, et lui-même pourrait être reconstruit depuis le WAL.' },
      ] },
    text: 'Un seul fsync, en écriture séquentielle, pour valider autant de lignes que tu veux. Et si plusieurs backends valident au même moment, un seul fait le fsync pour tout le monde : c\'est le **group commit**.' },
  { title: '9. Devenir visible, puis libérer', map: ['clogbuf', 'locks'],
    text: ['Dans cet ordre : ① le clog passe à `committed` ② la transaction sort de la liste des transactions actives : les **nouveaux** snapshots la voient ③ les verrous sont libérés, ce qui réveille ceux qui attendent.', 'Avec une réplica synchrone, une attente de plus s\'insère avant ②.'] },
  { title: '10. Retour au client', map: ['executor', 'client'],
    text: 'Le client reçoit `COMMIT`. Résumé de ce qui a changé sur disque : **quelques lignes dans le WAL**. Tes pages de données sont toujours en mémoire, sales. Elles attendent le chapitre suivant.' },
];

export default {
  id: 'update', icon: '✏️', nav: '4. Le trajet d\'un UPDATE', kicker: 'CHAPITRE 4 · ÉCRITURE',
  title: 'Le voyage d\'un `UPDATE`, jusqu\'au `COMMIT`',
  map: ['client'], mapCaption: 'Regarde bien où ça s\'arrête : presque jamais sur le disque.',
  blocks: [
    { say: 'Tu as déjà fait le SELECT. On garde le même chemin, et on ajoute tout ce qui fait d\'une écriture un acte engageant.' },
    { code: "BEGIN;\nUPDATE users SET name = 'Gégé' WHERE id = 42;\nCOMMIT;" },
    { widget: journey({ id: 'update', steps }) },
    {
      lab: {
        id: 'update', title: 'Regarder l\'UPDATE se faire',
        steps: [
          { s: 'A', sql: "SELECT pg_current_wal_insert_lsn() AS avant \\gset\nBEGIN;\nSELECT txid_current_if_assigned() AS xid_apres_begin;\nUPDATE users SET name = 'Gégé' WHERE id = 42;\nSELECT txid_current_if_assigned() AS xid_apres_update;\nSELECT pg_current_wal_insert_lsn() AS apres \\gset\nSELECT :'avant' AS lsn_avant, :'apres' AS lsn_apres,\n       pg_wal_lsn_diff(:'apres', :'avant') AS octets_de_wal;", note: 'A écrit, sans valider. Note le xid qui n\'apparaît qu\'après l\'UPDATE, et le WAL qui avance.', observe: 'Une poignée d\'octets de WAL pour changer un nom.' },
          { s: 'C', sql: "SELECT l.locktype, l.mode, l.granted, coalesce(l.relation::regclass::text, l.transactionid::text, l.virtualxid) AS sur\nFROM pg_locks l JOIN pg_stat_activity a USING (pid)\nWHERE a.application_name = 'labo-A';", note: 'Les verrous de A, vus par C.', observe: '`RowExclusiveLock` sur `users` et son index, un `ExclusiveLock` sur son `transactionid`, comme prévu. Et **aucune** trace de la ligne 42 : ce verrou-là, il est dans le `xmax` du tuple.' },
          { s: 'B', sql: "UPDATE users SET name = 'Gérald' WHERE id = 42;", blocks: true, note: 'B veut la même ligne. **Lance-le, il va rester bloqué**, c\'est le but.', observe: 'B s\'est réveillée dès que A a fini, et a écrit sur la version la plus récente.' },
          { s: 'C', sql: "SELECT application_name, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS bloque_par\nFROM pg_stat_activity\nWHERE application_name LIKE 'labo-%';", note: 'Pendant que B attend.', observe: 'B : `wait_event = transactionid`. Elle dort sur le xid de A, exactement comme à l\'étape 4.' },
          { s: 'A', sql: 'COMMIT;', note: 'A valide. Regarde B se débloquer au-dessus.', observe: 'Le `COMMIT` fait le fsync et libère les verrous.' },
          { s: 'A', sql: "UPDATE users SET name = 'Gérard' WHERE id = 42;\nSELECT n_tup_upd, n_tup_hot_upd\nFROM pg_stat_user_tables WHERE relname = 'users';", note: 'On rend à Gérard son nom. Compte les mises à jour.', observe: '`n_tup_hot_upd` monte avec `n_tup_upd` si la page a de la place : pas d\'entrée d\'index en plus. (Les compteurs peuvent mettre un instant à se mettre à jour.)' },
        ],
      },
    },
    { keep: ['Un UPDATE écrit dans `shared_buffers` et dans les WAL buffers : le disque n\'est pas concerné.', 'COMMIT = fsync du WAL, puis clog, puis visibilité, puis libération des verrous.', 'Un verrou de ligne, c\'est un `xmax`. On attend sur le xid de l\'autre transaction.', 'HOT : pas de colonne indexée modifiée et de la place dans la page = aucun index touché.'] },
  ],
};
