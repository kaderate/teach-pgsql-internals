import { slottedPage } from '../ui/widgets/basics.js';

export default {
  id: 'page', icon: '📄', nav: '2. La page de 8 Ko', kicker: 'CHAPITRE 2 · STOCKAGE',
  title: 'Toute ta base tient dans des pages de 8 Ko',
  map: ['buffers', 'heap'], mapCaption: 'La **page** est l\'unité de tout : du cache, du disque, et d\'une bonne partie du WAL.',
  blocks: [
    { say: 'Ta table n\'est pas une liste de lignes. C\'est une pile de pages de 8 192 octets, et je n\'échange jamais moins qu\'une page avec le disque.' },
    {
      guess: {
        id: 'page-order',
        q: 'Dans une page, dans quel sens se remplissent les lignes ?',
        options: [
          { t: 'Du haut vers le bas, comme un tableau', why: 'Il faudrait savoir à l\'avance la taille de chaque ligne pour trouver la n-ième. Or elles ont des tailles variables.' },
          { t: 'Des deux bouts : un tableau d\'index en haut, les données en bas, et le vide au milieu', ok: true, why: 'C\'est la *slotted page*. Le tableau de line pointers grandit vers le bas, les tuples remontent vers le haut. Quand ils se rencontrent, la page est pleine.' },
          { t: 'Dans l\'ordre de la clé primaire', why: 'Une table Postgres est un *heap* : aucun ordre garanti. InnoDB, lui, range par clé primaire. C\'est une différence de conception majeure.' },
        ],
        explain: 'L\'astuce du line pointer : un tuple peut bouger dans sa page (compactage) sans changer son `ctid`, donc sans toucher aux index.',
      },
    },
    { widget: slottedPage },
    { say: 'Fais un UPDATE, puis un VACUUM, et regarde les line pointers : le numéro survit au tuple. C\'est pour ça que les index peuvent rester valides.' },
    {
      guess: {
        id: 'page-overhead',
        q: 'Tu stockes une ligne avec une seule colonne `integer` (4 octets). Combien coûte-t-elle réellement dans la page ?',
        options: [
          { t: '4 octets', why: 'Ce serait beau. Tu oublies tout ce qu\'il faut pour le MVCC.' },
          { t: 'Environ 12 octets', why: 'Plus. L\'en-tête de tuple seul dépasse déjà ça.' },
          { t: 'Environ 36 octets', ok: true, why: '24 octets d\'en-tête (`xmin`, `xmax`, `ctid`, masques, avec alignement) + 4 de données, arrondis à 32 par l\'alignement sur 8 octets, + 4 pour le line pointer. Soit 226 lignes par page, au mieux.' },
          { t: 'Environ 8 Ko : une page par ligne', why: 'Heureusement, non !' },
        ],
        explain: 'D\'où l\'importance relative de l\'ordre des colonnes : l\'alignement peut gaspiller quelques octets par ligne, et sur un milliard de lignes, ça se voit.',
      },
    },
    { h: 'Et les grosses valeurs ?' },
    'Un tuple doit tenir dans une page. Au-delà d\'environ 2 Ko, Postgres compresse la valeur et/ou la découpe dans une table annexe, **TOAST**. Conséquence pratique : ton `SELECT *` qui ramène un gros JSON relit toute la table TOAST, alors qu\'un `SELECT id` ne la touche pas.',
    {
      lab: {
        id: 'page', title: 'Ouvrir une vraie page',
        steps: [
          { s: 'A', sql: "SELECT * FROM page_header(get_raw_page('users', 0));", note: '`get_raw_page` renvoie les 8 192 octets bruts, `page_header` les décode.', observe: '`lower` et `upper` bornent le vide. `upper − lower` = espace libre. `lsn` : le dernier record WAL qui a touché cette page. Retiens-le pour le chapitre 5.' },
          { s: 'A', sql: "SELECT lp, lp_off, lp_len, t_xmin, t_xmax, t_ctid, t_hoff\nFROM heap_page_items(get_raw_page('users', 0))\nWHERE lp BETWEEN 40 AND 44;", note: 'Le tableau de line pointers et les en-têtes de tuples.', observe: '`lp_off` diminue quand `lp` augmente : les tuples partent bien du bas. `t_hoff = 24` : l\'en-tête prend 24 octets.' },
          { s: 'A', sql: "SELECT ctid, id, name FROM users WHERE id = 42;", note: 'Le lien avec le monde SQL.', observe: 'Gérard, en `(0,42)` s\'il n\'a pas encore bougé. Le `ctid` n\'est pas stable : **ne jamais** le stocker.' },
          { sh: 'hex-page', label: 'hexdump du vrai fichier', note: 'Et voici le fichier sur disque, octet par octet.', observe: 'Les premiers octets sont le `pd_lsn`. Tout en bas de la page, tu peux lire `user_` en clair. Oui, tes données sont juste là.' },
          { s: 'A', sql: "SELECT pg_relation_size('users') / 8192 AS pages,\n       (SELECT count(*) FROM heap_page_items(get_raw_page('users', 0))) AS lignes_page_0,\n       pg_size_pretty(pg_relation_size('users')) AS table,\n       pg_size_pretty(pg_indexes_size('users')) AS index;", note: 'Les ordres de grandeur.', observe: 'Environ 130 lignes par page ici. Le coût d\'un seq scan se raisonne en pages.' },
        ],
      },
    },
    { keep: ['Page = 8 Ko = unité d\'échange. Line pointers en haut, tuples en bas.', 'Un `ctid` (page, line pointer) n\'est pas stable dans le temps.', 'Le coût d\'une ligne : au moins 24 + 4 octets avant la première donnée.'] },
  ],
};
