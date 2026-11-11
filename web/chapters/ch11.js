import { incident } from '../ui/widgets/games.js';

const INCIDENTS = [
  {
    id: 'alter', alert: 'CRITICAL api-prod : p99 > 30 s, taux d\'erreur 80 %',
    story: 'Il est 3 h 12. Tout timeoute depuis 4 minutes. Le CPU de la base est à **2 %**. Un déploiement est en cours. Ton collègue jure qu\'« il n\'a touché à rien, juste ajouté une colonne ».',
    probes: [
      { name: 'CPU, RAM, disque', out: 'cpu 2 %   iowait 0 %   ram 41 %   disk 52 %   → tout est calme. Trop calme.' },
      { name: 'Activité', sql: 'SELECT state, wait_event_type, wait_event, count(*) FROM pg_stat_activity GROUP BY 1,2,3', out: ` state               | wait_event_type | wait_event | count
---------------------+-----------------+------------+-------
 active              | Lock            | relation   |   187
 idle in transaction | Client          | ClientRead |     1
 idle                | Client          | ClientRead |    12` },
      { name: 'Chaîne de blocage', sql: 'SELECT pid, pg_blocking_pids(pid), now()-xact_start, left(query,40) …', cost: 3, out: `   pid | bloqué par | âge       | query
-------+------------+-----------+----------------------------------
 40211 | {39002}    | 00:04:10  | ALTER TABLE orders ADD COLUMN gift…
 40215 | {40211}    | 00:04:08  | SELECT * FROM orders WHERE user_id
 40216 | {40211}    | 00:04:08  | SELECT * FROM orders WHERE id = $1
 … (185 lignes de plus)
 39002 | {}         | 02:47:31  | SELECT count(*) FROM orders` },
      { name: 'Requêtes lentes', sql: 'pg_stat_statements', out: 'Aucune requête n\'a changé de plan. Elles n\'ont simplement pas commencé.' },
    ],
    hypotheses: [
      { t: 'Un `ALTER TABLE` attend une transaction vieille de 2 h 47, et tout le monde s\'empile derrière lui', ok: true, why: 'Tout est dans la chaîne. Le pid 39002 est `idle in transaction` : c\'est un `SELECT` oublié. Il suffit d\'annuler l\'ALTER pour que tout reparte.' },
      { t: 'La base est saturée : il faut plus de CPU', why: 'CPU à 2 %. 187 backends qui dorment ne consomment rien.' },
      { t: 'Le nouvel index de la colonne ralentit les lectures', why: 'L\'ALTER n\'a jamais démarré, et il n\'y a pas d\'index. Regarde `wait_event = relation` : ce sont des verrous.' },
    ],
    fix: ['**Immédiat** : `SELECT pg_cancel_backend(40211)` (l\'ALTER), puis `pg_terminate_backend(39002)` (le coupable).', '**Durable** : `SET lock_timeout = \'2s\'` dans toutes les migrations, avec reprise.', '`idle_in_transaction_session_timeout` en production.'],
  },
  {
    id: 'bloat', alert: 'WARNING db-prod : disque à 85 %, +40 Go en une semaine',
    story: 'Le trafic n\'a pas bougé. La table `sessions` (2 Go il y a un mois) pèse 90 Go pour 3 millions de lignes. Les requêtes qui la lisent ralentissent chaque jour. Autovacuum tourne, tu le vois dans les logs.',
    probes: [
      { name: 'Stats de la table', sql: 'SELECT n_live_tup, n_dead_tup, last_autovacuum FROM pg_stat_user_tables', out: ` n_live_tup | n_dead_tup  | last_autovacuum
------------+-------------+---------------------
    3102455 |   284992110 | il y a 3 min` },
      { name: 'Log de l\'autovacuum', cost: 1, out: `automatic vacuum of table "app.public.sessions":
  tuples: 0 removed, 287094565 remain, 284992110 are dead but not yet removable
  removable cutoff: 88120311, which was 41092288 XIDs old when operation ended` },
      { name: 'Qui retient l\'horizon', sql: 'SELECT application_name, state, backend_xmin, now()-xact_start FROM pg_stat_activity ORDER BY age(backend_xmin) DESC', cost: 3, out: ` application_name | state               | backend_xmin | âge
------------------+---------------------+--------------+-----------
 metabase         | idle in transaction |     88120311 | 6 days 04:12
 api              | active              |    129210344 | 00:00:01` },
      { name: 'Index de la table', out: 'Des index normaux, gonflés dans les mêmes proportions.' },
    ],
    hypotheses: [
      { t: 'Autovacuum est trop lent, il faut le rendre plus agressif', why: 'Il repasse toutes les 3 minutes, et retire **0** ligne. Le problème, c\'est ce `not yet removable`.' },
      { t: 'Une transaction ouverte depuis 6 jours empêche tout nettoyage', ok: true, why: '`dead but not yet removable` + `removable cutoff` très vieux, c\'est la signature. Une connexion Metabase restée en transaction retient l\'horizon de **toute l\'instance**.' },
      { t: 'Une fuite applicative : l\'app insère trop de sessions', why: 'Seulement 3 millions de lignes vivantes, c\'est stable. Ce sont les versions mortes qui s\'accumulent.' },
    ],
    fix: ['**Immédiat** : terminer la connexion, puis laisser l\'autovacuum faire.', 'L\'espace est récupéré **pour la table**. Pour réduire le fichier : `pg_repack`.', 'Alerter sur `now() - xact_start` et sur `age(backend_xmin)`. Regarder aussi les slots de réplication et `hot_standby_feedback`.'],
  },
  {
    id: 'lag', alert: 'WARNING replica-2 : replay_lag > 5 min',
    story: 'Les utilisateurs voient des données d\'il y a plusieurs minutes. Le primaire va bien. Un script d\'analytics tourne sur cette réplica depuis ce matin. Le réseau est au vert.',
    probes: [
      { name: 'Positions', sql: 'SELECT sent_lsn, write_lsn, flush_lsn, replay_lsn, replay_lag FROM pg_stat_replication', out: ` sent_lsn   | write_lsn  | flush_lsn  | replay_lsn | replay_lag
------------+------------+------------+------------+-----------
 4A/9F001000| 4A/9F001000| 4A/9F000F00| 4A/1B22A0C8| 00:05:21` },
      { name: 'Réseau et disque de la réplica', out: 'Bande passante : 3 %.  iowait : 2 %.  Le disque de la réplica se tourne les pouces.' },
      { name: 'Sur la réplica', sql: 'SELECT wait_event, state, now()-query_start, left(query,40) FROM pg_stat_activity', cost: 3, out: ` backend_type | wait_event        | durée    | query
--------------+-------------------+----------+-------------------------
 startup      | RecoveryConflict… | 00:05:20 |
 client       | DataFileRead      | 02:14:09 | SELECT … FROM events JOIN …` },
      { name: 'Conflits', sql: 'SELECT * FROM pg_stat_database_conflicts', out: 'confl_snapshot: 12  confl_lock: 0   (les annulations précédentes)' },
    ],
    hypotheses: [
      { t: 'Le réseau entre les deux serveurs est saturé', why: '`sent` et `flush` sont à jour : tout le WAL est arrivé. Le réseau n\'y est pour rien.' },
      { t: 'La réplica n\'a pas assez de disque pour le rejeu', why: 'iowait à 2 %. Le rejeu ne travaille même pas : il attend.' },
      { t: 'Le rejeu est suspendu par la requête d\'analytics, à cause de `max_standby_streaming_delay`', ok: true, why: 'Le rejeu veut retirer des lignes encore visibles par la requête. Il patiente jusqu\'à `max_standby_streaming_delay` (ici, très élevé), puis annulera la requête. `flush` à jour et `replay` en retard : c\'est ce qu\'il fallait voir.' },
    ],
    fix: ['**Immédiat** : annuler la requête. Le rejeu rattrape en quelques secondes.', 'Une réplica dédiée à l\'analytics, avec un délai élevé, et une autre pour le trafic, avec un délai faible.', '`hot_standby_feedback = on` évite le conflit, mais déplace le problème : du bloat sur le primaire.'],
  },
  {
    id: 'slot', alert: 'CRITICAL db-prod : disque à 97 %, PANIC imminent',
    story: 'Le volume du primaire se remplit à vue d\'œil. La taille des tables n\'a pas changé. Une réplica a été supprimée la semaine dernière (« on n\'en avait plus besoin »).',
    probes: [
      { name: 'du sur $PGDATA', out: ` base/    210G
 pg_wal/  485G   ← !!!
 pg_xact/ 120M` },
      { name: 'Paramètres WAL', sql: 'SHOW max_wal_size; SHOW archive_mode; SHOW max_slot_wal_keep_size', cost: 1, out: 'max_wal_size = 8GB   archive_mode = off   max_slot_wal_keep_size = -1' },
      { name: 'Slots', sql: 'SELECT slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) FROM pg_replication_slots', cost: 3, out: ` slot_name   | active | retenu
-------------+--------+--------
 replica_old | f      | 477 GB` },
      { name: 'Checkpoints', sql: 'SELECT * FROM pg_stat_checkpointer', out: 'Réguliers, rien d\'anormal. Le dernier remonte à 4 minutes. Il ne recycle pourtant presque rien.' },
    ],
    hypotheses: [
      { t: 'Un slot abandonné retient 477 Go de WAL', ok: true, why: 'Un slot promet de garder le WAL jusqu\'à ce que son consommateur l\'ait lu. Le consommateur n\'existe plus, et la promesse tient toujours. `active = f`, c\'est la signature.' },
      { t: '`max_wal_size` est trop grand', why: '8 Go. C\'est une cible, et elle ne protège pas de 485 Go. Quelque chose empêche le recyclage.' },
      { t: 'Les checkpoints ne se font plus', why: 'Ils ont lieu. Mais même après un checkpoint, le WAL retenu par un slot reste.' },
    ],
    fix: ['**Immédiat** : `SELECT pg_drop_replication_slot(\'replica_old\')`, puis `CHECKPOINT`. Ne **jamais** supprimer à la main des fichiers de `pg_wal/`.', '`max_slot_wal_keep_size` : le slot sera invalidé avant de tuer le primaire.', 'Alerter sur les slots inactifs et leur retard.'],
  },
  {
    id: 'stats', alert: 'CRITICAL api-prod : /orders passe de 20 ms à 45 s',
    story: 'La nuit dernière, un job a chargé 50 millions de lignes dans `order_items`. Depuis ce matin, une seule requête est devenue catastrophique. CPU à 100 % sur un cœur par appel. Pas de verrou.',
    probes: [
      { name: 'Activité', out: 'Pas d\'attente de type Lock. Les backends sont `active`, sans wait_event : ils calculent.' },
      { name: 'EXPLAIN ANALYZE', cost: 3, out: `Nested Loop  (cost=0.85..16.90 rows=1 width=40) (actual time=0.03..45120.1 rows=4812933 loops=1)
  ->  Index Scan on orders  (…rows=1…) (actual … rows=1 loops=1)
  ->  Index Scan on order_items (cost=0.43..8.45 rows=1 width=20) (actual … rows=4812933 loops=1)` },
      { name: 'Dernières stats', sql: 'SELECT last_analyze, last_autoanalyze, n_mod_since_analyze FROM pg_stat_user_tables', cost: 1, out: ` last_autoanalyze | n_mod_since_analyze
------------------+---------------------
 il y a 9 jours   |            50021883` },
      { name: 'Index', out: 'Tous présents, valides, et utilisés. Pas de changement de schéma.' },
    ],
    hypotheses: [
      { t: 'Un index a disparu ou est corrompu', why: 'L\'index est utilisé, et fonctionne. Il ramène 4,8 millions de lignes alors que le planner en attendait une.' },
      { t: 'Le planner travaille avec des statistiques périmées : `rows=1` estimé pour 4,8 millions', ok: true, why: '`n_mod_since_analyze` à 50 millions : le chargement est passé avant que l\'auto-analyze n\'ait pu suivre. Le plan repose sur des données d\'il y a 9 jours.' },
      { t: 'Il faut plus de `work_mem`', why: 'Pas de tri ni de hash ici. Un Nested Loop n\'a pas besoin de mémoire, c\'est sa boucle qui coûte.' },
    ],
    fix: ['**Immédiat** : `ANALYZE order_items`. Quelques secondes, et le plan revient.', 'Toujours faire un `ANALYZE` à la fin d\'un gros chargement, sans attendre l\'autovacuum.', 'Baisser `autovacuum_analyze_scale_factor` sur les grosses tables.'],
  },
  {
    id: 'oom', alert: 'CRITICAL db-prod : toutes les connexions coupées à 03:09',
    story: 'Toutes les apps ont perdu leur connexion d\'un coup, puis tout est revenu au bout de 40 s. Le serveur (64 Go) n\'a pas redémarré. `shared_buffers` = 16 Go, `work_mem` = 256 Mo, `max_connections` = 800.',
    probes: [
      { name: 'Log Postgres', cost: 1, out: `LOG:  server process (PID 8123) was terminated by signal 9: Killed
DETAIL:  Failed process was running: SELECT … GROUP BY … ORDER BY …
LOG:  terminating any other active server processes
LOG:  all server processes terminated; reinitializing
LOG:  database system was not properly shut down; automatic recovery in progress
LOG:  redo done at 3A/2F11C0D8` },
      { name: 'dmesg de l\'hôte', cost: 2, out: 'Out of memory: Killed process 8123 (postgres) total-vm:41876512kB, anon-rss:38123004kB' },
      { name: 'Le plan de la requête', cost: 2, out: 'Quatre Hash et Sort imbriqués, en parallèle sur 8 workers. Chacun a droit à son `work_mem`.' },
      { name: 'Le disque', out: 'Aucun problème de place, ni d\'E/S.' },
    ],
    hypotheses: [
      { t: 'Le disque a planté, et la recovery a tout coupé', why: 'Rien n\'indique ça sur le disque. Le signal 9 vient du noyau.' },
      { t: 'L\'OOM killer a tué un backend, et le postmaster a redémarré tout le monde pour protéger la mémoire partagée', ok: true, why: 'Tu l\'as appris au chapitre 0 : un backend qui meurt brutalement fait tomber les autres. `work_mem` est **par nœud de plan et par processus** : 256 Mo × plusieurs nœuds × workers × connexions dépasse vite 64 Go.' },
      { t: 'Une attaque par déni de service', why: 'Un seul processus tué, et une seule requête suspecte. Pas besoin d\'aller chercher si loin.' },
    ],
    fix: ['`work_mem` raisonnable par défaut, relevé par session (ou rôle) pour les requêtes analytiques.', '`vm.overcommit_memory = 2` sur l\'hôte, conformément à la doc de Postgres.', 'Un pooler pour ne plus avoir 800 connexions.', 'Calcul à faire : `shared_buffers` + connexions × `work_mem` × nœuds typiques.'],
  },
  {
    id: 'checkpoint', alert: 'WARNING api-prod : pic de latence toutes les 5 minutes',
    story: 'Chaque 5 minutes, à la seconde près, les écritures ralentissent, puis ça se calme. Le débit de WAL grimpe à ce moment-là. Pas de job planifié à cette fréquence, ni de verrou.',
    probes: [
      { name: 'Log', cost: 1, out: 'LOG:  checkpoint starting: time\nLOG:  checkpoint complete: wrote 412094 buffers (39.3%); write=52.1 s, sync=11.8 s, total=64.2 s' },
      { name: 'Réglages', sql: 'SHOW checkpoint_timeout; SHOW max_wal_size; SHOW checkpoint_completion_target', cost: 1, out: 'checkpoint_timeout = 5min   max_wal_size = 8GB   checkpoint_completion_target = 0.3' },
      { name: 'Volume du WAL', sql: 'SELECT wal_fpi, wal_records, wal_bytes FROM pg_stat_wal', cost: 2, out: ' wal_records | wal_fpi  | wal_bytes\n   912000312 | 88120771 | 1094 GB       → 66 % du volume en images de pages' },
      { name: 'Verrous', out: 'Aucune attente significative sur les verrous.' },
    ],
    hypotheses: [
      { t: 'Un job caché tourne toutes les 5 minutes', why: 'La régularité colle parfaitement à `checkpoint_timeout`. Regarde les logs : le coupable s\'y annonce lui-même.' },
      { t: 'Des checkpoints trop fréquents et trop brutaux, aggravés par une tempête de full page writes', ok: true, why: '`checkpoint starting: time` : c\'est bien `checkpoint_timeout` qui déclenche. `completion_target` de 0.3 : tout est écrit en peu de temps, d\'où un pic d\'E/S. Puis les premières modifications de chaque page après le checkpoint emportent une image complète : le WAL explose juste après.' },
      { t: 'Le WAL est sur un disque trop lent', why: 'Ça expliquerait une lenteur permanente, pas un pic parfaitement régulier.' },
    ],
    fix: ['`checkpoint_completion_target = 0.9` : étaler les écritures.', 'Un `checkpoint_timeout` à 15 min, avec un `max_wal_size` assez grand pour que ce soit bien lui qui décide.', 'Le compromis, toujours : des checkpoints plus rares, mais une recovery plus longue.'],
  },
  {
    id: 'maxconn', alert: 'CRITICAL api-prod : FATAL sorry, too many clients already',
    story: 'Après la montée en charge de 20 à 80 pods, l\'API refuse des connexions. Chaque pod a un pool de 20 connexions. La base n\'est pas chargée, et les requêtes sont rapides. On te propose de « monter `max_connections` à 5000 ».',
    probes: [
      { name: 'Compter', sql: 'SELECT state, count(*) FROM pg_stat_activity GROUP BY 1', out: ` state  | count
--------+-------
 active |    14
 idle   |  1582` },
      { name: 'Réglages', sql: 'SHOW max_connections', cost: 1, out: 'max_connections = 1600' },
      { name: 'Latence interne', out: 'Requêtes : 3 ms de moyenne. CPU à 25 %. La base n\'est absolument pas à la peine.' },
      { name: 'Attentes', out: 'Des pics sur `LWLock:ProcArray` dès que l\'activité grimpe un peu.' },
    ],
    hypotheses: [
      { t: 'Les requêtes sont trop lentes et les connexions s\'accumulent', why: '14 actives seulement, à 3 ms. Le problème ne vient pas de leur durée.' },
      { t: 'Il suffit de monter `max_connections` à 5000', why: 'Chaque connexion est un processus. Prendre un snapshot parcourt la liste des transactions actives, et le coût monte avec le nombre de backends. Tu paierais ça sur toutes les requêtes, pour 14 actives.' },
      { t: '1 600 connexions à ne rien faire, un processus chacune : il faut un pooler', ok: true, why: '80 pods × 20 = 1 600 slots, pour 14 requêtes actives. PgBouncer en mode transaction multiplexe tout ça sur quelques dizaines de vraies connexions.' },
    ],
    fix: ['PgBouncer (mode transaction), attention aux `SET` de session et aux requêtes préparées selon les versions.', 'Réduire la taille des pools par pod.', 'Dimensionner sur le nombre de **requêtes simultanées**, pas sur le nombre de clients.'],
  },
];

const realSteps = [
  { s: 'X', sql: "BEGIN;\nSELECT count(*) FROM comptes;", note: '🐘 Slonik sabote en coulisses (session X). Ne lis pas trop ce code, fais comme si tu ne l\'avais pas vu.' },
  { s: 'B', blocks: true, sql: 'ALTER TABLE comptes ADD COLUMN sabotage int;', note: 'Le collègue déploie. Lance.' },
  { s: 'A', expectError: true, sql: "SET statement_timeout = '2s';\nSELECT * FROM comptes;\nRESET statement_timeout;", note: '📟 Ton app tente de lire. Elle timeoute après 2 s.', observe: 'À toi de jouer. Écris ta requête de diagnostic ci-dessous, sans relire les chapitres si possible.' },
  { s: 'C', sql: "-- Trouve le coupable. Voici un point de départ :\nSELECT pid, application_name, state, wait_event_type, pg_blocking_pids(pid)\nFROM pg_stat_activity\nWHERE application_name LIKE 'labo-%';", note: 'Ton enquête. Remonte la chaîne.', observe: 'B bloquée par X, et X en `idle in transaction`.' },
  { s: 'C', sql: "SELECT pg_terminate_backend(pid)\nFROM pg_stat_activity\nWHERE application_name = 'labo-X';", note: 'Le remède : on coupe le coupable.', observe: 'B se débloque aussitôt, plus haut. La prod repart.' },
  { s: 'B', sql: 'ALTER TABLE comptes DROP COLUMN sabotage;', note: 'Le ménage.' },
];

export default {
  id: 'astreinte', icon: '📟', nav: '11. Astreinte', kicker: 'CHAPITRE 11 · 3 H DU MATIN', night: true,
  title: 'Ton téléphone vibre',
  map: [], mapCaption: 'Pense toujours à la carte. Où ça coince ?',
  blocks: [
    { say: 'Fini de jouer. Enfin, non : maintenant on joue vraiment. Chaque sonde te coûte des minutes de panne. Moins tu en utilises, plus tu marques de points.' },
    'La méthode tient en une question : **est-ce que ça travaille, ou est-ce que ça attend ?** Regarde `wait_event_type` : `Lock` (verrous), `LWLock` (contention interne), `IO` (disque), `Client` (on attend ton app), rien (ça calcule).',
    { table: [['Symptôme', 'Premier réflexe'],
      ['Tout est lent, CPU bas', '`pg_stat_activity` + `pg_blocking_pids`. Des verrous ?'],
      ['Une requête lente, CPU haut', '`EXPLAIN ANALYZE`, et `rows` contre `actual rows`'],
      ['Tout est lent, iowait haut', '`Buffers: read`, cache trop petit, checkpoints'],
      ['Le disque grossit', '`pg_wal` ? Slots. Tables ? Horizon et vacuum'],
      ['Une réplica en retard', '`sent` / `flush` / `replay` : où est l\'écart ?'],
      ['Connexions coupées', 'Les logs : `signal 9`, OOM, recovery'],
    ] },
    { h: '📟 Incident n° 1' }, { widget: incident(INCIDENTS[0]) },
    { h: '📟 Incident n° 2' }, { widget: incident(INCIDENTS[1]) },
    { h: '📟 Incident n° 3' }, { widget: incident(INCIDENTS[2]) },
    { h: '📟 Incident n° 4' }, { widget: incident(INCIDENTS[3]) },
    { h: '📟 Incident n° 5' }, { widget: incident(INCIDENTS[4]) },
    { h: '📟 Incident n° 6' }, { widget: incident(INCIDENTS[5]) },
    { h: '📟 Incident n° 7' }, { widget: incident(INCIDENTS[6]) },
    { h: '📟 Incident n° 8' }, { widget: incident(INCIDENTS[7]) },
    { h: '🔥 Pour de vrai, cette fois' },
    { lab: { id: 'incident-real', title: 'Slonik sabote ton Postgres', intro: 'Vrais backends, vrai blocage. Trouve la cause et répare.', steps: realSteps } },
    { keep: ['Ça travaille ou ça attend ? `wait_event_type` répond en une seconde.', 'Le coupable est souvent celui qui ne fait **rien** : `idle in transaction`.', 'Quatre alertes à poser demain : âge de `xact_start`, slots inactifs, `age(datfrozenxid)`, retard de réplication.'] },
  ],
};
