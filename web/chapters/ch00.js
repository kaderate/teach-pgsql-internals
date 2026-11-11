import { systemMap } from '../ui/widgets/basics.js';

export default {
  id: 'ville', icon: '🏙️', nav: '0. La ville', kicker: 'CHAPITRE 0 · VUE SYSTÈME',
  title: 'Postgres est une ville, pas un programme',
  map: ['client', 'postmaster'], mapCaption: 'Cette carte te suit partout. Elle s\'allume selon ce que fait la machine, et 🐘 montre où ça se passe.',
  blocks: [
    { say: 'Salut, moi c\'est Slonik. Ça fait des années que tu m\'envoies des requêtes sans jamais demander comment je vais. On va arranger ça.' },
    'Ici, une règle : **tu devines d\'abord**. Tant que tu n\'as pas répondu, la suite n\'existe pas. Te tromper rapporte moins de points, mais c\'est là que ça rentre.',
    {
      guess: {
        id: 'ville-processes',
        q: '100 clients sont connectés à ton Postgres et ne font rien. Combien de processus de plus qu\'avec 0 client ?',
        options: [
          { t: 'Aucun : un seul processus gère tout, avec une boucle d\'événements', why: 'C\'est le modèle de Redis, ou de Nginx. Pas le mien.' },
          { t: 'Quelques threads, car ils ne font rien', why: 'Postgres n\'utilise pas de threads pour ses connexions, du moins pas en version 17.' },
          { t: '100 processus : un par connexion, même inactive', ok: true, why: 'Un `fork()` par connexion. Chaque client a son backend, sa mémoire privée, sa file de messages. C\'est robuste et simple, mais une connexion coûte cher, d\'où PgBouncer.' },
          { t: '100 processus, mais seulement quand ils lancent une requête', why: 'Le backend naît à la connexion et meurt à la déconnexion, qu\'il travaille ou non.' },
        ],
      },
    },
    { h: 'La carte' },
    'Quatre quartiers : les **backends** qui exécutent tes requêtes, la **mémoire partagée** par où ils se coordonnent, les **processus de fond** qui font le travail différé, et le **disque**.',
    { widget: systemMap },
    {
      guess: {
        id: 'ville-share',
        q: 'Les backends sont des processus séparés. Comment se coordonnent-ils pour ne pas écrire la même page en même temps ?',
        options: [
          { t: 'Ils s\'envoient des messages par sockets', why: 'Beaucoup trop lent pour chaque accès à une page.' },
          { t: 'Le postmaster arbitre chaque accès', why: 'Le postmaster ne touche volontairement pas à la mémoire partagée : il doit survivre si elle est corrompue.' },
          { t: 'Ils mappent le même segment de mémoire et y posent des verrous légers', ok: true, why: 'Le buffer pool, le WAL en cours, la table des verrous, la liste des transactions : tout vit dans un segment partagé, protégé par des spinlocks et des LWLocks.' },
          { t: 'Ils lisent et écrivent directement dans les fichiers, l\'OS arbitre', why: 'Ce serait une catastrophe pour les performances, et l\'OS n\'a aucune notion de transaction.' },
        ],
        explain: 'Conséquence : si un seul backend crashe (segfault, OOM killer), le postmaster tue **tous** les autres et lance une recovery. La mémoire partagée n\'est plus digne de confiance. Une requête folle peut donc redémarrer toute l\'instance.',
      },
    },
    {
      lab: {
        id: 'ville', title: 'La ville, en vrai',
        intro: 'Le primaire tourne dans Docker. Tout ce qui suit s\'exécute pour de bon.',
        steps: [
          { sh: 'ps', label: 'ps dans le conteneur', note: 'Voilà la ville : `postgres` (PID 1, le postmaster) et ses enfants.', observe: 'Repère `checkpointer`, `background writer`, `walwriter`, `autovacuum launcher`, `walsender` (la réplica), et un `postgres: slonik labo …` par session ouverte.' },
          { s: 'A', sql: "SELECT pid, backend_type, application_name, state\nFROM pg_stat_activity\nORDER BY backend_type;", note: 'La même chose, vue de l\'intérieur.', observe: 'Ta session est un `client backend`. Le reste, ce sont les processus de fond de la carte.' },
          { s: 'B', sql: 'SELECT pg_backend_pid();', note: 'Une autre session, c\'est un autre processus.', observe: 'Un PID différent de celui de la session A. Relance `ps` : il y est.' },
          { sh: 'ls-data', label: 'ls de $PGDATA', note: 'Le disque maintenant.', observe: '`base/` : tes tables. `pg_wal/` : le journal. `pg_xact/` : le statut des transactions. `global/pg_control` : le fichier qui sait où reprendre après un crash.' },
          { sh: 'du-data', label: 'Tailles', observe: 'Le WAL peut peser lourd : il garde tout ce qui a changé récemment.' },
          { sh: 'ls-users', label: 'Le fichier de la table users', note: 'Une table est un fichier, ou quelques-uns.', observe: 'Le fichier principal et `_fsm` (où reste-t-il de la place ?). Après un premier VACUUM, s\'y ajoute `_vm` (quelles pages sont propres ?). On y reviendra. Au-delà de 1 Go, Postgres découpe en `.1`, `.2`…' },
        ],
      },
    },
    { keep: ['Un backend par connexion : c\'est un **processus**, avec son coût.', 'La coordination passe par la **mémoire partagée** ; un crash de backend redémarre tout le monde.', 'Tes requêtes écrivent en mémoire et dans le WAL ; d\'autres processus s\'occupent du disque, plus tard.'] },
  ],
};
