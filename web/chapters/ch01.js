import { journey, bufferPool } from '../ui/widgets/basics.js';

const steps = [
  { title: '1. Connexion : le postmaster te reçoit', map: ['client', 'postmaster'],
    text: ['Ton client ouvre une socket. Le postmaster `fork()` un backend, qui vérifie `pg_hba.conf`, t\'authentifie, charge tes paramètres. Tout ça arrive **une seule fois**, à la connexion, pas à chaque requête.', 'Compte quelques millisecondes et un processus neuf : c\'est pourquoi on garde des connexions ouvertes dans un pool.'] },
  { title: '2. Le message part sur le fil', map: ['client', 'parser'],
    text: 'Le protocole est binaire, mais simple. Un octet de type, une longueur, le contenu. En simple query :',
    show: `Client → serveur
  'Q' | longueur | "SELECT name FROM users WHERE id = 42\\0"` },
  { title: '3. Le parser : la grammaire et rien d\'autre', map: ['parser'],
    ask: { q: '`SELECT name FROM table_qui_n_existe_pas` : le parser l\'accepte-t-il ?',
      options: [
        { t: 'Oui : la phrase est grammaticale, il ne connaît pas les tables', ok: true, why: 'Le parser (flex + bison) ne regarde jamais le catalogue. Il transforme le texte en arbre, c\'est tout.' },
        { t: 'Non : il vérifie que la table existe', why: 'C\'est le travail de l\'étape suivante. L\'erreur `relation does not exist` vient de l\'analyzer.' },
      ] },
    text: 'Du texte, il fait des tokens puis un arbre brut. `SELEC name` meurt ici, en `syntax error`.',
    show: `SelectStmt
├─ targetList : ColumnRef(name)
├─ fromClause : RangeVar(users)
└─ whereClause: A_Expr(=)
                ├─ ColumnRef(id)
                └─ A_Const(42)` },
  { title: '4. L\'analyzer : qui est qui ?', map: ['analyzer', 'buffers'],
    text: ['Il cherche `users` dans le catalogue, trouve l\'OID de la table, le type de `id`, l\'opérateur `=` pour des `int4`, vérifie tes droits. Il prend aussi un verrou `AccessShareLock` sur la table, qu\'il gardera jusqu\'à la fin de ta transaction.', 'Détail savoureux : le catalogue (`pg_class`, `pg_attribute`…) est fait de tables ordinaires, lues avec la même machine, derrière un cache par backend.'] },
  { title: '5. Le rewriter : déplier les vues', map: ['rewriter'],
    text: 'Une vue n\'est qu\'une règle : son arbre est collé à la place de son nom. La row level security s\'ajoute ici aussi. Sur notre requête, il ne fait rien.' },
  { title: '6. Le planner : le choix qui compte', map: ['planner'],
    ask: { q: 'Pour choisir son plan, le planner lit-il les lignes de la table ?',
      options: [
        { t: 'Oui, il échantillonne quelques pages à chaque requête', why: 'Ça coûterait trop cher par requête. C\'est `ANALYZE` qui échantillonne, à l\'avance.' },
        { t: 'Non : il utilise les statistiques stockées dans `pg_statistic`, et la taille de la table', ok: true, why: 'Il estime les lignes retournées, calcule le coût de chaque chemin et garde le moins cher. Des statistiques périmées mènent donc à de mauvais plans.' },
      ] },
    text: 'Chemin choisi :',
    show: `Index Scan using users_pkey on users  (cost=0.29..8.31 rows=1 width=10)
  Index Cond: (id = 42)` },
  { title: '7. Le snapshot, puis l\'executor', map: ['clogbuf', 'executor'],
    text: ['Avant d\'exécuter, le backend prend une **photo** : quelles transactions sont finies, lesquelles tournent encore. Elle décidera ce qu\'il a le droit de voir.', 'Puis l\'executor tire sur l\'arbre du plan : le nœud du haut demande une ligne à son enfant, qui en demande une au sien. Une ligne à la fois, à la demande. C\'est le modèle Volcano.'] },
  { title: '8. Descente dans le B-tree', map: ['executor', 'buffers'],
    text: 'Un index est un fichier de pages lui aussi. On lit la racine, puis la bonne branche, puis la feuille, qui donne le `ctid` de Gérard : page 0, ligne 42.',
    show: `             [ racine ]
            /          \\
     [ 1…367 ]        [ 368… ]        (niveaux selon la taille)
      /      \\
 [ 1…366 ]  …        feuille : id=42 → ctid (0,42)` },
  { title: '9. Le buffer pool : personne ne lit le disque en direct', map: ['executor', 'buffers', 'heap'],
    text: ['Le backend calcule une clé (fichier, numéro de page), cherche dans une table de hachage partagée. **Hit** : il épingle la page et la lit. **Miss** : il choisit un cadre, charge les 8 Ko via `read()`.', 'Et ce `read()` tombe souvent dans le cache de l\'OS : tes données sont souvent en mémoire **deux fois**.'] },
  { title: '10. Dans la page : le line pointer', map: ['buffers'],
    text: 'Le `ctid` `(0,42)` ne désigne pas un octet, mais la 42e case du tableau de line pointers en tête de page, qui donne le décalage réel du tuple. Le chapitre suivant ouvre la page.' },
  { title: '11. La visibilité : le tuple existe-t-il pour toi ?', map: ['executor', 'clogbuf'],
    ask: { q: 'La page contient la ligne. Peut-on la renvoyer directement ?',
      options: [
        { t: 'Oui : si elle est dans la page, elle existe', why: 'Une page peut contenir de vieilles versions, des lignes jamais validées, des lignes supprimées. L\'index ne le sait pas non plus.' },
        { t: 'Non : il faut comparer ses `xmin` et `xmax` au snapshot', ok: true, why: 'Présent dans la page ne veut pas dire visible. C\'est tout le sujet du MVCC, au chapitre 3.' },
      ] },
    text: 'Si le test passe, l\'executor extrait la colonne `name` et remonte la ligne.' },
  { title: '12. Retour au client', map: ['executor', 'client'],
    text: ['Chaque ligne repart en message `D`. La fin est signalée par `C` et `Z`.', 'Aucun fsync, pas de xid : un `SELECT` classique ne génère normalement aucun WAL. Normalement, car il peut écrire des *hint bits*, et même nettoyer une page (HOT pruning), ce qui, lui, écrit du WAL. Un `SELECT` n\'est pas toujours en lecture seule au niveau physique.'],
    show: `Serveur → client
  'T' description des colonnes (name : text)
  'D' une ligne : "Gérard"
  'C' "SELECT 1"
  'Z' prêt pour la requête suivante` },
];

export default {
  id: 'select', icon: '🔍', nav: '1. Le trajet d\'un SELECT', kicker: 'CHAPITRE 1 · LECTURE',
  title: 'Le voyage d\'un `SELECT`',
  map: ['client'], mapCaption: 'Regarde 🐘 se déplacer à chaque étape.',
  blocks: [
    'On suit une seule requête, du début à la fin. Le fil rouge : `SELECT name FROM users WHERE id = 42`. La ligne 42, c\'est **Gérard**. Vous allez vous revoir souvent.',
    { widget: journey({ id: 'select', steps }) },
    { h: 'Le cache en action' },
    'Le buffer pool a un nombre fixe de cadres. Pour faire de la place, Postgres utilise le **clock sweep** : une aiguille tourne, décrémente l\'`usage_count` de chaque page et prend la première à zéro.',
    {
      guess: {
        id: 'select-clock',
        q: 'Pourquoi pas un simple LRU, qui évince la page utilisée il y a le plus longtemps ?',
        options: [
          { t: 'Un LRU demande de réordonner une liste partagée à chaque accès : un point de contention énorme', ok: true, why: 'Avec le clock sweep, un accès incrémente seulement un compteur dans la page en mémoire, sans verrou global.' },
          { t: 'Parce que le LRU garde moins bien les pages utiles', why: 'Il n\'est pas si mauvais en qualité d\'éviction, c\'est sa contention sous charge qui pose problème.' },
          { t: 'Parce que le LRU a besoin de plus de mémoire qu\'il n\'y en a', why: 'Quelques pointeurs par page, c\'est négligeable. Le problème est le verrou.' },
        ],
      },
    },
    { widget: bufferPool },
    { say: 'Essaie de garder la page 0 en vie : lis-la plusieurs fois, puis parcours toutes les autres. Elle survit à plusieurs tours d\'aiguille.' },
    {
      lab: {
        id: 'select', title: 'Espionner le trajet',
        steps: [
          { s: 'A', sql: "SET client_min_messages = log;\nSET debug_print_plan = on;\nSELECT name FROM users WHERE id = 42;\nRESET debug_print_plan;\nRESET client_min_messages;", note: 'On demande au serveur d\'afficher son plan interne, tel qu\'il est dans sa mémoire.', observe: 'Ce gros arbre, c\'est la structure C du plan, imprimée telle quelle. Cherche `:indexid` et `:indexqual`. Personne n\'est censé lire ça, et c\'est bien pour ça qu\'on le fait.' },
          { s: 'A', sql: 'EXPLAIN SELECT name FROM users WHERE id = 42;', note: 'La version pour les humains.', observe: 'Le même plan : `Index Scan using users_pkey`. On décortique les coûts au chapitre 8.' },
          { s: 'A', sql: "EXPLAIN (ANALYZE, BUFFERS)\nSELECT * FROM users WHERE id = 99999;", note: 'Maintenant, exécutons-le pour de vrai. Lance-le **deux fois** et compare `shared read` et `shared hit`.', observe: '`Buffers: shared hit=3` : la racine et la feuille de l\'index, puis la page de table. `read` compte les pages qui ne venaient pas du cache de Postgres.' },
          { s: 'A', sql: "SELECT c.relname, count(*) AS pages_en_cache,\n       pg_size_pretty(count(*) * 8192) AS taille\nFROM pg_buffercache b\nJOIN pg_class c ON b.relfilenode = pg_relation_filenode(c.oid)\nWHERE c.relname IN ('users', 'users_pkey', 'orders', 'orders_pkey')\nGROUP BY c.relname ORDER BY 2 DESC;", note: 'Qu\'y a-t-il dans shared_buffers en ce moment ?', observe: 'Lance un `SELECT count(*) FROM orders;` et recommence : les pages arrivent en cache.' },
          { s: 'A', sql: 'SELECT count(*) FROM orders;\nSELECT pg_current_wal_lsn() AS avant \\gset\nSELECT count(*) FROM users;\nSELECT pg_current_wal_lsn() = :\'avant\' AS wal_inchange;', note: 'Un SELECT écrit-il dans le WAL ?', observe: '`wal_inchange` vaut en général `t`. Il arrive qu\'il vaille `f` : d\'autres processus écrivent eux aussi dans le WAL, et un `SELECT` peut nettoyer une page.' },
        ],
      },
    },
    { keep: ['Parser (grammaire) → analyzer (noms, droits) → rewriter (vues) → planner (coûts) → executor (tire les lignes).', 'Toute page lue passe par `shared_buffers`, et l\'éviction se fait par clock sweep.', 'Présent dans la page n\'implique pas visible : il y a toujours un test de visibilité.'] },
  ],
};
