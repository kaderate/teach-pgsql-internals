import { crashLab } from '../ui/widgets/crash.js';

export default {
  id: 'wal', icon: '📜', nav: '5. WAL et crash', kicker: 'CHAPITRE 5 · DURABILITÉ',
  title: 'Le WAL, sa tête, et le jour où tout s\'arrête',
  map: ['walbuf', 'wal'], mapCaption: 'Le **WAL** est la seule chose qui compte quand la lumière s\'éteint.',
  blocks: [
    { say: 'Tu m\'as dit : « Le WAL, je ne sais même pas quelle gueule il a. » Assieds-toi, je te le présente.' },
    { theory: { id: 'wal-why', q: 'Pourquoi écrire tout en double, une fois dans un journal et une fois dans les pages ? Pourquoi ne pas juste écrire les pages au COMMIT ?',
      reveal: 'Trois raisons. **Vitesse** : écrire à la suite d\'un fichier (séquentiel) coûte bien moins cher qu\'écrire 50 pages dispersées, et une transaction peut en toucher des milliers. **Atomicité** : tu ne sais pas écrire 50 pages d\'un coup, un crash au milieu laisserait la base à moitié modifiée. **Réutilisation** : le journal, on peut aussi l\'envoyer à une réplica ou l\'archiver.' } },
    { h: 'À quoi ressemble un record' },
    'Le WAL est un flux continu d\'octets, découpé en fichiers de 16 Mo. Sa position est le **LSN** : `0/080A71C0` n\'est rien d\'autre qu\'un décalage en octets dans ce flux infini. Chaque record suit le même format :',
    { code: `┌─ En-tête : 24 octets ─────────────────────────────┐
│ xl_tot_len  taille totale du record               │
│ xl_xid      la transaction (0 si aucune)          │
│ xl_prev     LSN du record précédent               │
│ xl_info     le type précis (HOT_UPDATE, COMMIT…)  │
│ xl_rmid     qui sait le rejouer (Heap, Btree…)    │
│ xl_crc      somme de contrôle                     │
├─ Références de blocs ─────────────────────────────┤
│ rel 1663/16384/16400  blk 0   (et parfois l'image │
│ complète de la page : le full page write)         │
├─ Données ─────────────────────────────────────────┤
│ « sur cette page, en position 42, pose ce xmax    │
│   et ajoute ce tuple en position 131 »            │
└───────────────────────────────────────────────────┘`, caption: 'C\'est physique : il décrit ce qui change sur quel bloc, pas ton SQL.' },
    { lab: { id: 'wal-look', title: 'Retrouver ton UPDATE dans le WAL',
      steps: [
        { s: 'A', sql: "SELECT pg_current_wal_lsn() AS lsn,\n       pg_walfile_name(pg_current_wal_lsn()) AS fichier;", note: 'Où en est le journal, et dans quel fichier ?', observe: 'Le nom du fichier se déduit du LSN : timeline, puis numéro de segment. Il n\'y a pas de table d\'index, c\'est de l\'arithmétique.' },
        { s: 'A', sql: "CHECKPOINT;\nSELECT pg_current_wal_insert_lsn() AS avant \\gset\nUPDATE users SET name = 'Gégé' WHERE id = 42;\nUPDATE users SET name = 'Gérard' WHERE id = 42;\nSELECT pg_current_wal_insert_lsn() AS apres \\gset\nSELECT start_lsn, xid, resource_manager AS rm, record_type, record_length AS taille, fpi_length AS image, left(description, 56) AS description\nFROM pg_get_wal_records_info(:'avant', :'apres');", note: 'Après un checkpoint, deux UPDATE en auto-commit. Prédis : combien de records ? Le premier sera-t-il plus gros ?', observe: 'Le voilà ! Un `HOT_UPDATE` suivi d\'un `COMMIT`, deux fois. Le premier traîne une **image complète de la page** : quelques Ko dans `image`, car le trou vide du milieu n\'est pas copié. C\'est le full page write après checkpoint. Le second pèse moins de 100 octets, soit 30 fois moins.' },
        { sh: 'waldump', label: 'pg_waldump : le fichier lui-même', note: 'L\'outil officiel. Les dernières lignes du segment courant.', observe: 'Repère `rmgr: Heap`, `rmgr: Transaction … COMMIT`, et `XLOG … CHECKPOINT` si tu en vois un. Chaque ligne a son `lsn` et son `prev`, qui pointe vers la précédente.' },
        { sh: 'hex-wal', label: 'hexdump d\'un segment', note: 'Et la voilà, sa vraie gueule.', observe: 'Du binaire. L\'en-tête de segment porte un « magic number » et la version du format. Personne ne lit ça à la main, sauf toi, là, maintenant.' },
        { sh: 'ls-wal', label: 'Les fichiers de pg_wal', observe: 'Chaque fichier fait exactement 16 Mo, même à moitié rempli : ils sont préalloués et recyclés.' },
      ] } },
    { h: 'La règle d\'or, et ce qu\'elle permet' },
    { guess: { id: 'wal-rule', q: 'Le bgwriter veut écrire sur disque une page modifiée par une transaction **non validée**. A-t-il le droit ?',
      options: [
        { t: 'Non : une page ne part sur disque qu\'après le COMMIT', why: 'C\'est la politique *no steal*. Avec elle, une grosse transaction devrait tenir entièrement en mémoire.' },
        { t: 'Oui, sans condition', why: 'Il y a une condition, et elle est sacrée.' },
        { t: 'Oui, à condition que le WAL de cette page soit déjà sur disque', ok: true, why: 'C\'est le **Write-Ahead Logging**. Avant d\'écrire une page, on force le WAL jusqu\'au `pd_lsn` de la page. Le non-validé peut donc atteindre le disque (*steal*), car le clog le rendra invisible.' },
      ] } },
    { table: [['', 'Politique', 'Ce que ça veut dire', 'Ce que ça permet'],
      ['**Steal**', 'Oui', 'Une page non validée peut partir sur disque', 'Des transactions plus grosses que la RAM'],
      ['**No force**', 'Oui', 'Le COMMIT n\'écrit pas les pages', 'Un COMMIT rapide : un seul fsync séquentiel'],
    ] },
    { h: 'Le checkpoint' },
    { guess: { id: 'wal-checkpoint', q: 'Sans checkpoint, que se passerait-il après des mois de fonctionnement ?',
      options: [
        { t: 'Le disque se remplirait de WAL, et un crash demanderait de tout rejouer depuis le début', ok: true, why: 'Le checkpoint écrit toutes les pages sales et note un point de reprise (le *redo*). Le WAL antérieur ne sert plus à la recovery : il peut être recyclé.' },
        { t: 'Rien, les pages finiraient bien par être écrites par le bgwriter', why: 'Rien ne garantirait que **toutes** soient écrites à une date donnée : impossible de jeter le moindre WAL.' },
        { t: 'Les COMMIT deviendraient de plus en plus lents', why: 'Pas directement : le COMMIT ne dépend que du flush du WAL.' },
      ] } },
    'Le prix : chaque première modification d\'une page après un checkpoint emporte une **image complète** dans le WAL (*full page write*). Pourquoi ? Parce qu\'une page de 8 Ko s\'écrit rarement de façon atomique sur des blocs de 4 Ko : un crash peut la **déchirer**. L\'image permet de la reconstruire.',
    { h: 'La salle de crash-test' },
    { say: 'Le mode d\'emploi : écris, valide, écris sans valider, puis tue-moi. Ensuite, trois missions.' },
    { widget: crashLab },
    { table: [['Mission', 'Comment', 'Ce que tu dois voir'],
      ['1. Comprendre le rejeu', 'Quelques UPDATE et COMMIT, puis kill -9', 'Le validé est là, le reste a disparu.'],
      ['2. Perdre un commit, sans corrompre', 'Décoche `synchronous_commit`, UPDATE, COMMIT, kill -9', 'Le client a reçu OK, la ligne a son ancienne valeur. La base reste cohérente.'],
      ['3. Déchirer une page', 'CHECKPOINT, UPDATE, COMMIT, « kill -9 en pleine écriture », avec puis sans `full_page_writes`', 'Avec : image restaurée. Sans : corruption.'],
      ['4. Le pire du pire', 'Décoche « WAL avant les données ». UPDATE ligne 1 sans valider, bgwriter, kill -9, rejeu. Puis UPDATE ligne 2, COMMIT', 'Une écriture jamais validée ressuscite, sans aucune erreur.'],
    ] },
    { lab: { id: 'wal-crash', title: 'kill -9 pour de vrai',
      intro: 'Oui, on va vraiment tuer le primaire. C\'est son conteneur, il s\'en remettra.',
      steps: [
        { s: 'A', sql: "CREATE TABLE IF NOT EXISTS crashtest (id serial PRIMARY KEY, msg text);\nINSERT INTO crashtest (msg) VALUES ('validé avant le crash') RETURNING *;", note: 'A écrit et valide. Ses pages sont en mémoire, son WAL est sur disque.' },
        { s: 'B', sql: "BEGIN;\nINSERT INTO crashtest (msg) VALUES ('jamais validé') RETURNING *;", note: 'B écrit, sans valider.' },
        { s: 'C', sql: "SHOW synchronous_commit;\nSELECT checkpoint_lsn, redo_lsn FROM pg_control_checkpoint();", note: 'Le point de reprise qui servira au redémarrage.', observe: '`redo_lsn` : c\'est là que commencera le rejeu.' },
        { sh: 'crash', label: '💥 kill -9 sur le primaire', note: 'SIGKILL, sans préavis ni checkpoint ni politesse.', observe: 'Le conteneur meurt et repart.' },
        { sh: 'logs-primary', label: 'Les logs du redémarrage', observe: 'Lis l\'histoire : `database system was interrupted`, `was not properly shut down; automatic recovery in progress`, `redo starts at …`, `redo done at …`, puis `ready to accept connections`.' },
        { s: 'A', sql: 'SELECT * FROM crashtest ORDER BY id;', note: 'Le verdict.', observe: '« validé avant le crash » est là. « jamais validé » n\'est pas là. Personne ne l\'a défait : son xid n\'a tout simplement jamais été validé.' },
      ] } },
    { keep: ['WAL d\'abord, données ensuite : c\'est la règle dont tout découle.', 'Steal + no force : la souplesse côté pages, la sécurité côté journal.', 'Recovery = rejouer depuis le dernier point de reprise. Le `pd_lsn` évite de rejouer deux fois.', 'Un checkpoint plus rare accélère l\'exécution, moins de full page writes, mais rallonge la recovery.'] },
  ],
};
