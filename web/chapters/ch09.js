import { replicationLab } from '../ui/widgets/replication.js';

export default {
  id: 'replication', icon: '🛰️', nav: '9. La réplication', kicker: 'CHAPITRE 9 · RÉPLICATION',
  title: 'Une réplica est un crash qui ne finit jamais',
  map: ['wal', 'walsender', 'replica'], mapCaption: 'Le **même WAL** que pour la recovery, envoyé sur le réseau.',
  blocks: [
    { say: 'Tu sais déjà tout : je sais rejouer mon journal après un crash. Alors si j\'envoie ce journal ailleurs, et que l\'autre le rejoue sans arrêt ? Voilà, c\'est une réplica.' },
    { guess: { id: 'rep-what', q: 'Que transporte la réplication en streaming ?',
      options: [
        { t: 'Tes requêtes SQL, rejouées sur la réplica', why: 'C\'est le modèle *statement-based* de certains autres systèmes. Avec `now()` ou `random()`, il donne des résultats différents.' },
        { t: 'Les lignes modifiées', why: 'C\'est la réplication **logique**. Elle existe aussi, avec des usages différents (migrations, versions différentes). Mais ce n\'est pas ce qui nous occupe ici.' },
        { t: 'Le WAL, octet par octet', ok: true, why: 'Des blocs identiques, et au final une réplica physiquement identique au primaire, bloat et index compris. C\'est simple et sûr, mais il faut la même version majeure et la même architecture.' },
      ] } },
    { code: `Primaire                                          Réplica
backend ──WAL──> pg_wal/ ──> walsender ══réseau══> walreceiver ──> pg_wal/
   │               │             │                     │              │
pg_current_wal_lsn │          sent_lsn             write_lsn      flush_lsn
                   │                                                  │
                primaire flush                     processus startup : rejeu
                                                                      │
                                                                 replay_lsn : enfin lisible`, caption: 'Quatre positions, quatre endroits où prendre du retard.' },
    { table: [['Retard sur…', 'Veut dire', 'Coupable probable'],
      ['`sent_lsn`', 'Le primaire n\'arrive pas à envoyer', 'Primaire surchargé, réseau saturé'],
      ['`write_lsn`, `flush_lsn`', 'La réplica écrit lentement', 'Disque de la réplica'],
      ['`replay_lsn` seul', 'Le WAL est reçu, mais pas rejoué', 'Rejeu mono-processus, E/S, ou **une requête longue qui le suspend**'],
    ] },
    { guess: { id: 'rep-sync', q: 'Réplication synchrone, `synchronous_commit = on`, et la réplica tombe en panne. Que devient le primaire ?',
      options: [
        { t: 'Il repasse en asynchrone automatiquement', why: 'Ce serait une promesse trahie sans prévenir personne. Il ne le fera jamais tout seul.' },
        { t: 'Les COMMIT restent bloqués, jusqu\'au retour d\'une réplica', ok: true, why: 'Tu as demandé une garantie, il la tient. Avec une seule réplica synchrone, tu n\'as pas plus de disponibilité : tu en as moins. D\'où les configurations à plusieurs réplicas, avec `ANY 1 (a, b)`.' },
        { t: 'Il rejette les COMMIT en erreur', why: 'Il attend, il ne rejette pas. Un COMMIT bloqué dont on annule l\'attente émet un avertissement, car il est déjà écrit localement.' },
      ] } },
    { h: 'Le simulateur' },
    { widget: replicationLab },
    { table: [['À essayer', 'Pour voir'],
      ['Baisse le curseur « Rejeu »', 'Retard de replay seul : le WAL est bien arrivé.'],
      ['Baisse le curseur « Réseau »', 'Retard de sent : tout le reste suit.'],
      ['Longue requête sur la réplica', 'Le rejeu s\'arrête, puis la requête se fait annuler. Coche `hot_standby_feedback` : elle survit, mais le primaire garde du bloat à cause d\'elle.'],
      ['`synchronous_commit` = on, puis couper', 'Tous les clients bloqués dans COMMIT.'],
      ['Couper la réplica, avec slot, puis Lecture', '`pg_wal` monte et remplit le disque : une réplica morte tue le primaire. Essaie `max_slot_wal_keep_size`.'],
    ] },
    { guess: { id: 'rep-read', q: 'Ton app écrit sur le primaire et lit juste après sur une réplica asynchrone, sans lag visible sur tes graphes. L\'utilisateur ne voit pas sa modification. Pourquoi ?',
      options: [
        { t: 'Un bug de cache applicatif : la réplica est à jour', why: 'Peut-être, mais il y a plus simple. Quelques millisecondes de lag suffisent, et tes graphes par minute ne les montrent pas.' },
        { t: 'Le lag n\'est jamais nul : la lecture part avant le rejeu', ok: true, why: 'Une réplica asynchrone est **toujours** en retard, même d\'une milliseconde. Aucun réglage n\'élimine ça : il faut soit `remote_apply`, soit lire sur le primaire juste après avoir écrit, soit attendre un LSN.' },
      ] } },
    { lab: { id: 'replication', title: 'Une vraie réplica, un vrai retard',
      steps: [
        { s: 'A', sql: "SELECT application_name, state, sync_state,\n       sent_lsn, write_lsn, flush_lsn, replay_lsn,\n       write_lag, flush_lag, replay_lag\nFROM pg_stat_replication;", note: 'Côté primaire, ta réplica est un client comme un autre.', observe: 'Le quatuor de positions, en direct.' },
        { s: 'R', target: 'replica', expectError: true, sql: "SELECT pg_is_in_recovery();\nUPDATE comptes SET solde = 0;", note: 'Côté réplica. On tente une écriture.', observe: '`t` : elle est bien « en recovery », et pour toujours. `ERROR: cannot execute UPDATE in a read-only transaction`.' },
        { sh: 'ps', label: 'Les processus', note: 'Sur le primaire, le walsender.', observe: 'Une ligne `postgres: walsender replicator …`.' },
        { s: 'R', target: 'replica', sql: 'SELECT pg_wal_replay_pause();\nSELECT pg_is_wal_replay_paused();', note: 'On appuie sur pause. La réplica reçoit encore le WAL, mais ne le rejoue plus.', observe: '`t`. C\'est ce qu\'une longue requête de conflit provoquerait, en beaucoup moins propre.' },
        { s: 'A', sql: "UPDATE comptes SET solde = solde + 1000 WHERE id = 2 RETURNING solde;\nSELECT pg_sleep(0.3);\nSELECT application_name, flush_lsn, replay_lsn,\n       pg_wal_lsn_diff(flush_lsn, replay_lsn) AS retard_rejeu_octets\nFROM pg_stat_replication;", note: 'Gros virement sur le primaire.', observe: '`flush_lsn` avance, `replay_lsn` reste : le signe d\'un retard de rejeu.' },
        { s: 'R', target: 'replica', sql: "SELECT solde AS solde_vu_sur_la_replica FROM comptes WHERE id = 2;\nSELECT pg_last_wal_receive_lsn() AS recu, pg_last_wal_replay_lsn() AS rejoue;", note: 'Ton app lit sur la réplica.', observe: 'L\'ancien solde ! Le client dans ton support va adorer. `recu` est devant `rejoue`.' },
        { s: 'R', target: 'replica', sql: "SELECT pg_wal_replay_resume();\nSELECT pg_sleep(0.3);\nSELECT solde AS solde_vu_sur_la_replica FROM comptes WHERE id = 2;", note: 'On reprend.', observe: 'La réplica rattrape instantanément.' },
        { s: 'A', sql: "UPDATE comptes SET solde = 100;\nSELECT slot_name, active, restart_lsn,\n       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS wal_retenu\nFROM pg_replication_slots;", note: 'Le slot, maintenant : il retient le WAL pour la réplica.', observe: 'Très peu retenu, la réplica est à jour.' },
        { sh: 'replica-stop', label: 'Arrêter la réplica', note: 'La panne. Le slot, lui, reste.' },
        { s: 'A', sql: "DROP TABLE IF EXISTS walgen;\nCREATE TABLE walgen AS SELECT i, repeat('x', 200) AS p FROM generate_series(1, 300000) i;\nCHECKPOINT;\nSELECT slot_name, active,\n       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS wal_retenu\nFROM pg_replication_slots;", note: 'Le primaire continue d\'écrire.', observe: '`active = f` et `wal_retenu` monte, même après un checkpoint. Sans alerte, c\'est ton disque qui finira par tomber.' },
        { sh: 'replica-start', label: 'Rallumer la réplica', note: 'Elle revient.', observe: 'Elle reprend là où elle en était, grâce au slot.' },
        { s: 'A', sql: "SELECT pg_sleep(4);\nDROP TABLE IF EXISTS walgen;\nSELECT slot_name, active,\n       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS wal_retenu\nFROM pg_replication_slots;", note: 'Quelques secondes plus tard.', observe: '`active = t`, le retard fond, et le prochain checkpoint recyclera le WAL.' },
      ] } },
    { keep: ['Réplica = recovery sans fin, sur un WAL reçu en continu.', 'Identifie **où** est le retard : sent, flush ou replay.', 'Un slot sans consommateur remplit le disque du primaire. Surveille-le et règle `max_slot_wal_keep_size`.', 'Synchrone n\'augmente pas la disponibilité, mais la durabilité.'] },
  ],
};
