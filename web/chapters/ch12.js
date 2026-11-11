import { orderGame } from '../ui/widgets/games.js';

const selectGame = orderGame({
  id: 'select', title: 'Le trajet d\'un SELECT',
  items: ['Le postmaster `fork()` un backend (à la connexion)', 'Le **parser** construit l\'arbre, sans regarder le catalogue', 'L\'**analyzer** résout les noms et prend `AccessShareLock`', 'Le **rewriter** déplie les vues', 'Le **planner** estime les coûts avec `pg_statistic`', 'Le backend prend un **snapshot**', 'L\'**executor** descend dans le B-tree via le buffer pool', 'Il lit le tuple via le line pointer de la page', 'Il teste la **visibilité** (`xmin`, `xmax`, snapshot, clog)', 'La ligne part au client (`D`, puis `C` et `Z`)'],
  shuffled: [4, 0, 8, 2, 6, 9, 1, 5, 3, 7],
});

const updateGame = orderGame({
  id: 'update', title: 'Le trajet d\'un UPDATE + COMMIT, jusqu\'au disque',
  items: ['Parser, analyzer (`RowExclusiveLock`), rewriter, planner', 'L\'executor trouve la version visible de la ligne', 'La transaction reçoit son **xid** à la première écriture', '`xmax` posé sur l\'ancien tuple : le verrou de ligne', 'Nouveau tuple dans le buffer, page marquée sale', 'Record `HOT_UPDATE` dans les WAL buffers, LSN dans la page', 'COMMIT : record COMMIT, puis **fsync du WAL**', 'Clog à `committed`, la transaction sort de la liste des actives', 'Verrous libérés, réponse au client', 'Plus tard : le **bgwriter** ou le **checkpointer** écrit la page', 'Plus tard encore : **VACUUM** retire l\'ancienne version'],
  shuffled: [6, 2, 9, 0, 4, 10, 3, 8, 1, 7, 5],
});

const crashGame = orderGame({
  id: 'crash', title: 'Un crash, puis le retour',
  items: ['💥 Le processus meurt : `shared_buffers` et WAL non flushé disparaissent', 'Le postmaster repart et lit `pg_control`', 'Il trouve le point de reprise (`redo_lsn`) du dernier checkpoint', 'Il rejoue chaque record depuis ce point', 'Si le `pd_lsn` de la page est déjà plus récent : il passe', 'Les images complètes réparent les pages déchirées', 'Fin du WAL : les transactions sans COMMIT sont considérées annulées', 'Un checkpoint de fin de recovery, puis les connexions reprennent'],
  shuffled: [3, 6, 0, 7, 2, 5, 1, 4],
});

export default {
  id: 'tableau', icon: '🎓', nav: '12. L\'examen au tableau', kicker: 'CHAPITRE 12 · FINAL',
  title: 'Le feutre est à toi',
  map: ['client', 'parser', 'analyzer', 'rewriter', 'planner', 'executor', 'buffers', 'walbuf', 'wal', 'heap', 'clog'], mapCaption: 'Tout y est. Tu peux dessiner cette carte de tête ?',
  blocks: [
    { say: 'Ton but de départ : « le trajet complet d\'une requête, du client jusqu\'au disque ». Pas de chapitres sous les yeux. Allez.' },
    { theory: { id: 'final-draw', q: 'Sur une feuille, ou ici : dessine la carte de mémoire, puis raconte `UPDATE users SET name = \'x\' WHERE id = 42` jusqu\'au `COMMIT`.',
      reveal: 'Compare avec le chapitre 4. Ta réponse de départ tenait en cinq étapes. Les détails à vérifier : l\'attribution du xid, le verrou écrit dans le `xmax`, le WAL mémoire puis fsync au COMMIT, le clog qui ne change qu\'après, et la page qui reste sale en mémoire.' } },
    { widget: selectGame },
    { widget: updateGame },
    { widget: crashGame },
    { h: 'Dix questions pour te tester' },
    { guess: { id: 'final-1', q: 'Une transaction met à jour 10 millions de lignes, puis fait un ROLLBACK. Combien de temps prend le ROLLBACK ?',
      options: [
        { t: 'Autant que l\'UPDATE : il faut tout défaire', why: 'C\'est le modèle d\'InnoDB, qui défait via son undo. Pas chez Postgres.' },
        { t: 'Quasiment rien, mais 10 millions de versions mortes restent à nettoyer', ok: true, why: 'Un statut dans le clog, et c\'est fini. La facture arrive plus tard, en vacuum et en bloat.' },
      ] } },
    { guess: { id: 'final-2', q: 'Tu fais `UPDATE t SET x = x` sans rien changer. Que se passe-t-il ?',
      options: [
        { t: 'Rien : Postgres voit que la valeur est identique', why: 'Il ne compare pas. Le trigger `suppress_redundant_updates_trigger` existe pour ça.' },
        { t: 'Une nouvelle version de chaque ligne, du WAL et du bloat', ok: true, why: 'Un UPDATE est un UPDATE. Ajoute `WHERE x IS DISTINCT FROM …` à tes requêtes.' },
      ] } },
    { guess: { id: 'final-3', q: 'Pourquoi `SELECT count(*) FROM t` est-il lent sans `WHERE`, alors que MyISAM le faisait instantanément ?',
      options: [
        { t: 'Parce qu\'il n\'y a pas d\'index par défaut', why: 'Même avec un index, le problème reste.' },
        { t: 'Parce qu\'il n\'y a pas un seul nombre de lignes : il dépend de ton snapshot', ok: true, why: 'MVCC oblige : chaque transaction peut voir un nombre différent. Il faut donc compter ce qui est visible pour toi. La Visibility Map et l\'index only scan aident, mais rien de magique. Pour une estimation : `reltuples`.' },
      ] } },
    { guess: { id: 'final-4', q: 'Ton fsync ment : le disque répond « c\'est écrit » alors que c\'est dans un cache volatile. Après une coupure de courant ?',
      options: [
        { t: 'Rien de grave : le WAL s\'en occupe', why: 'Le WAL repose précisément sur cette promesse.' },
        { t: 'Des commits perdus, et peut-être une corruption', ok: true, why: 'Toute la chaîne de durabilité repose sur un fsync honnête. D\'où `pg_test_fsync`, et des disques avec condensateurs.' },
      ] } },
    { guess: { id: 'final-5', q: 'Un index sur `(a, b)`. Lequel de ces filtres l\'utilise le mieux ?',
      options: [
        { t: '`WHERE b = 1`', why: 'Le B-tree est trié par `a` d\'abord. Sans `a`, les valeurs de `b` sont éparpillées.' },
        { t: '`WHERE a = 1 AND b > 5`', ok: true, why: 'Égalité sur la première colonne, intervalle sur la seconde : une seule zone contiguë dans l\'index. Mets les égalités d\'abord.' },
        { t: '`WHERE a > 1 AND b = 5`', why: 'L\'intervalle sur `a` oblige à parcourir toute la zone, en filtrant sur `b`.' },
      ] } },
    { guess: { id: 'final-6', q: '`DELETE FROM logs WHERE created_at < …` supprime 90 % d\'une table de 1 To. Mieux ?',
      options: [
        { t: 'Partitionner par date, puis `DROP` ou `DETACH` la vieille partition', ok: true, why: 'Un `DELETE` crée autant de versions mortes, du WAL et du vacuum. Un `DROP` retire un fichier, c\'est quasi instantané.' },
        { t: '`VACUUM FULL` après le `DELETE`', why: 'Tu cumules la facture du DELETE avec un verrou exclusif sur toute la table.' },
      ] } },
    { guess: { id: 'final-7', q: 'Quelle est la pire configuration de durabilité ?',
      options: [
        { t: '`synchronous_commit = off`', why: 'Tu peux perdre les dernières transactions validées, mais la base reste cohérente. C\'est un compromis souvent acceptable.' },
        { t: '`fsync = off`', ok: true, why: 'L\'ordre des écritures n\'est plus garanti. Un crash peut corrompre toute l\'instance, sans message d\'erreur.' },
      ] } },
    { guess: { id: 'final-8', q: 'Tu ajoutes `DEFAULT 0` à une colonne d\'une table de 500 Go (PG ≥ 11). Combien de temps ?',
      options: [
        { t: 'Des heures : il faut réécrire chaque ligne', why: 'C\'était vrai avant la version 11.' },
        { t: 'Un instant : la valeur est mémorisée dans le catalogue', ok: true, why: 'Il faut toujours un `AccessExclusiveLock`, même bref : la catastrophe du chapitre 7 reste possible !' },
      ] } },
    { guess: { id: 'final-9', q: 'Une réplica peut-elle retenir du bloat sur le primaire ?',
      options: [
        { t: 'Non : elles sont indépendantes', why: 'Pas avec cette option.' },
        { t: 'Oui, avec `hot_standby_feedback`', ok: true, why: 'Le xmin de ses requêtes remonte au primaire et compte dans l\'horizon du vacuum.' },
      ] } },
    { guess: { id: 'final-10', q: 'Résume le rôle du `pd_lsn` de chaque page.',
      options: [
        { t: 'Il indique la dernière lecture de la page', why: 'Non, il n\'est pas modifié par une lecture.' },
        { t: 'Il garantit le WAL avant la page, et évite de rejouer un record déjà appliqué', ok: true, why: 'À l\'écriture : flush du WAL jusqu\'à ce LSN. À la recovery : on saute si la page est déjà plus récente. Deux lignes de logique, tout repose dessus.' },
      ] } },
    { say: 'Si tu en es là, tu sais lire ma carte, et tu sais pourquoi je fais les choses comme je les fais. Reviens quand tu veux. Il reste le bac à sable.' },
    { keep: ['Pour aller plus loin : *The Internals of PostgreSQL* (Hironobu Suzuki), en ligne et gratuit.', '*PostgreSQL 14 Internals* (Egor Rogov), gratuit lui aussi : la référence.', 'La doc officielle, chapitres « Internals », et les README du code source : `src/backend/access/transam/README`.'] },
  ],
};
