# 🐘 Slonik Folies

Apprendre le fonctionnement de PostgreSQL de bout en bout : d'abord une simulation pour **voir** le
mécanisme, ensuite un vrai Postgres pour le **vérifier**. Et toujours : tu devines avant qu'on te dise.

## Démarrer

```sh
npm start                 # http://localhost:4242
```

Il faut Node ≥ 22 et Docker, sans aucune dépendance npm. Le labo se démarre depuis la page, ou avec
`docker compose up -d --wait`. Les chapitres et les simulations fonctionnent sans Docker ; seuls les
blocs « Sur le vrai Postgres » en ont besoin.

Le serveur n'écoute que sur `127.0.0.1`, et les conteneurs ne publient aucun port.

## Le parcours

| # | Chapitre | Simulation | Vrai Postgres |
|---|---|---|---|
| 0 | La ville | Carte du système | `ps`, `pg_stat_activity`, `$PGDATA` |
| 1 | Le trajet d'un SELECT | Voyage en 12 étapes, buffer pool | `debug_print_plan`, `BUFFERS`, `pg_buffercache` |
| 2 | La page de 8 Ko | Page slottée | `pageinspect`, hexdump du fichier |
| 3 | MVCC | Deux sessions, une ligne | `xmin`/`xmax`, vrais snapshots |
| 4 | Le trajet d'un UPDATE | Voyage en 10 étapes | `pg_locks`, blocage réel |
| 5 | WAL et crash | Salle de crash-test | `pg_walinspect`, `pg_waldump`, vrai `kill -9` |
| 6 | VACUUM | Décharge, HOT, horizon | `pgstattuple`, bloat, transaction qui retient tout |
| 7 | Les verrous | File d'attente, deadlock | La catastrophe de l'`ALTER`, vrai deadlock |
| 8 | Planner et EXPLAIN | Coûts en direct, plan à décoder | Bascules, statistiques périmées, `CREATE STATISTICS` |
| 9 | La réplication | Simulateur de retard | Vraie réplica, rejeu en pause, slot qui retient le WAL |
| 10 | Le contrat | Questions | Write skew, `SERIALIZABLE` |
| 11 | Astreinte | 8 incidents à diagnostiquer | Slonik sabote ton Postgres |
| 12 | L'examen au tableau | Remise en ordre, 10 questions | |
| | Bac à sable | | 3 sessions + la réplica |

## Tester

```sh
npm test            # le cœur de simulation, sans Docker ni navigateur
npm run test:labs   # chaque requête de chaque labo, sur le vrai Postgres
```

`npm run test:labs` demande `npm start` et le labo démarrés. Il joue les étapes dans l'ordre d'un
apprenant, vérifie que celles qui doivent bloquer bloquent, et que seules les erreurs prévues se
produisent. Il tue le primaire au passage et modifie les données.

Le test de propriété de `test/engine.test.js` vérifie, sur 150 scénarios, qu'après un crash tout
commit survit et rien d'autre. `test/others.test.js` compare les coûts du planner simulé à des valeurs
relevées sur PostgreSQL 17.11.

## Architecture

```
server.js          Fichiers statiques + pont vers des sessions psql persistantes
docker-compose.yml Primaire + réplica en streaming, PostgreSQL 17
docker/            Schéma initial (users, orders, comptes), démarrage de la réplica
web/sim/           Cœur pur, sans DOM : engine (pages, buffer pool, WAL, MVCC, recovery, vacuum),
                   locks, planner, replication
web/ui/            Rendu : blocks (règle du « devine d'abord »), lab, map, widgets/
web/chapters/      Le contenu, sous forme de données
test/              node --test, plus labs.run.js
```

Pour le contenu, un chapitre est une liste de blocs : texte, `guess`, `theory`, `widget`, `lab`,
`keep`, `table`, `code`. Tant qu'un `guess` ou un `theory` n'a pas de réponse, la suite ne s'affiche pas.

## Ce que la simulation simplifie

Pages à quelques slots, une seule table, pas de sous-transactions ni de hint bits. L'index se résume à
`id → line pointers`, le clog et l'index sont reconstruits depuis le WAL entier à la recovery. La
réplication raisonne en ticks. Le planner approche les coûts d'index et de bitmap, sans parallélisme.

## Réinitialiser

- Le labo : bouton rouge du bac à sable, ou `docker compose down -v`.
- La progression : bouton « Tout oublier » (localStorage).
