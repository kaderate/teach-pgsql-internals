import { mvccLab } from '../ui/widgets/mvcc.js';

export default {
  id: 'mvcc', icon: '👻', nav: '3. MVCC : qui voit quoi', kicker: 'CHAPITRE 3 · VISIBILITÉ',
  title: 'Il y a plusieurs Gérard en même temps',
  map: ['executor', 'clogbuf', 'clog'], mapCaption: 'La visibilité se décide dans l\'**executor**, avec le **snapshot** et le **clog**.',
  blocks: [
    { say: 'Tu m\'as dit « le délire xmin/xmax, je ne sais plus comment ça marche ». Tu vas voir : quatre règles, et tout s\'éclaire.' },
    {
      theory: {
        id: 'mvcc-why',
        q: 'Pourquoi, chez Postgres, un lecteur ne bloque jamais un écrivain, et inversement ? Écris ton idée.',
        reveal: 'Parce qu\'un `UPDATE` **n\'écrase rien**. Il écrit une nouvelle version de la ligne et marque l\'ancienne. Chaque lecteur choisit la version qui existait pour lui, sans demander l\'avis de personne : c\'est le **Multi-Version Concurrency Control**.',
      },
    },
    { h: 'Les quatre ingrédients' },
    { table: [['Pièce', 'Ce que c\'est'],
      ['`xmin`', 'Le xid de la transaction qui a créé cette version.'],
      ['`xmax`', 'Le xid de celle qui l\'a supprimée, remplacée, ou verrouillée. 0 si personne.'],
      ['**Snapshot**', 'La photo prise par une requête : `xmin:xmax:liste des xid en cours`.'],
      ['**Clog** (`pg_xact`)', 'Deux bits par xid : en cours, validée, annulée.'],
    ] },
    {
      guess: {
        id: 'mvcc-rule',
        q: 'Une version a `xmin = 100` (validé) et `xmax = 105`. La transaction 105 est toujours en cours. Moi, transaction 110, je lis. Je la vois ?',
        options: [
          { t: 'Non : elle a été supprimée, son `xmax` est rempli', why: 'Remplir `xmax` ne suffit pas : encore faut-il que cette suppression soit validée et visible pour moi.' },
          { t: 'Oui : tant que la 105 n\'est pas validée, sa suppression n\'existe pas pour moi', ok: true, why: 'Exactement. Une version est visible si son créateur existe pour moi **et** si son destructeur n\'existe pas pour moi.' },
          { t: 'Je bloque en attendant le résultat de la 105', why: 'Un lecteur ne bloque jamais sur un écrivain. C\'est toute la promesse du MVCC.' },
        ],
        explain: '« Exister pour moi » : soit c\'est ma propre transaction, soit elle a validé **et** elle n\'était ni en cours ni future au moment de mon snapshot.',
      },
    },
    { widget: mvccLab },
    { h: 'Trois expériences à tenter dans le théâtre' },
    '**1.** A fait `BEGIN`, `UPDATE`. B fait `SELECT`. Qui voit quoi, et pourquoi ?  **2.** B commence en `REPEATABLE READ` et lit, A met à jour et valide, B relit. **3.** A met à jour sans valider, B tente aussi un `UPDATE`.',
    {
      guess: {
        id: 'mvcc-commit',
        q: 'Après le `COMMIT` d\'un `UPDATE` sur une ligne, que devient le tuple dans la page ?',
        options: [
          { t: 'On y écrit un drapeau « validé » immédiatement', why: 'Sinon COMMIT devrait repasser sur chaque ligne écrite : ingérable sur une transaction d\'un million de lignes. (Un *hint bit* sera posé plus tard, par un lecteur.)' },
          { t: 'Rien : seul le statut du xid change dans le clog', ok: true, why: 'Le COMMIT coûte le même prix pour une ligne ou un milliard. La validité de toutes les lignes bascule d\'un coup, en changeant deux bits ailleurs. C\'est la surprise de ton étape 4 !' },
          { t: 'L\'ancienne version est effacée', why: 'Elle reste là : un autre snapshot en a peut-être encore besoin. C\'est le vacuum qui s\'en occupera.' },
        ],
      },
    },
    { h: 'Les niveaux d\'isolation, simplement' },
    { table: [['Niveau', 'Snapshot', 'Conséquence'],
      ['`READ COMMITTED` (défaut)', 'Un nouveau par **instruction**', 'Deux `SELECT` dans la même transaction peuvent voir des choses différentes.'],
      ['`REPEATABLE READ`', 'Un seul, au premier ordre', 'Vue figée. Conflit d\'écriture : `could not serialize access`, à toi de rejouer.'],
      ['`SERIALIZABLE`', 'Un seul + suivi des dépendances', 'Détecte les anomalies restantes, comme le *write skew*. Voir chapitre 10.'],
    ] },
    {
      lab: {
        id: 'mvcc', title: 'Le théâtre, avec de vrais acteurs',
        steps: [
          { s: 'A', sql: "SELECT txid_current() AS mon_xid,\n       pg_current_snapshot() AS mon_snapshot;\nSELECT xmin, xmax, ctid, * FROM users WHERE id = 42;", note: 'Ces colonnes existent sur toute table, elles sont simplement cachées.', observe: 'Note le snapshot, de la forme `xmin:xmax:liste`, et le `ctid` de Gérard. Son `xmin`, c\'est la transaction qui a créé cette version.' },
          { s: 'A', sql: "BEGIN;\nUPDATE users SET name = 'Gégé' WHERE id = 42;\nSELECT txid_current() AS mon_xid, xmin, xmax, ctid, name\nFROM users WHERE id = 42;", note: 'A met à jour, sans valider.', observe: 'Pour A, Gérard s\'appelle déjà Gégé, et son `xmin` est le xid de A.' },
          { s: 'B', sql: "SELECT txid_current_if_assigned() AS mon_xid, xmin, xmax, ctid, name\nFROM users WHERE id = 42;", note: 'B regarde en même temps.', observe: 'Toujours Gérard, avec `xmax` = le xid de A, et un `ctid` différent : ce sont deux tuples. `mon_xid` est vide : B n\'a rien écrit, il n\'a pas de xid.' },
          { s: 'C', sql: "SELECT lp, t_xmin, t_xmax, t_ctid\nFROM heap_page_items(get_raw_page('users', (SELECT (ctid::text::point)[0]::int FROM users WHERE id = 42)))\nWHERE lp_len > 0\nORDER BY lp DESC LIMIT 4;", note: 'Regardons la page, sans filtre de visibilité.', observe: 'Les deux Gérard sont là, côte à côte : l\'ancien pointe vers le nouveau via `t_ctid` (si la page avait assez de place), et le nouveau a `t_xmax = 0`.' },
          { s: 'A', sql: 'ROLLBACK;', note: 'A renonce.', observe: 'Aucune page n\'a été défaite : le statut du xid passe à `aborted`.' },
          { s: 'B', sql: "SELECT xmin, xmax, ctid, name FROM users WHERE id = 42;", note: 'Et B ?', observe: 'Gérard, de nouveau au `ctid` d\'origine, avec un `xmax` qui vaut peut-être encore le xid annulé : c\'est sans importance, le clog dit qu\'il ne compte pas.' },
          { s: 'A', sql: "BEGIN ISOLATION LEVEL REPEATABLE READ;\nSELECT solde FROM comptes WHERE id = 1;", note: 'À présent, l\'isolation : A prend une photo.', observe: 'A voit le solde actuel.' },
          { s: 'B', sql: 'UPDATE comptes SET solde = solde + 1 WHERE id = 1;', note: 'B modifie et valide (auto-commit).', observe: 'Pas de blocage : A n\'a fait que lire.' },
          { s: 'A', expectError: true, sql: 'SELECT solde FROM comptes WHERE id = 1;\nUPDATE comptes SET solde = solde + 1 WHERE id = 1;\nROLLBACK;', note: 'A relit, puis tente d\'écrire.', observe: 'La lecture renvoie l\'ancienne valeur. L\'écriture échoue : `could not serialize access due to concurrent update`. Le code qui utilise ce niveau **doit** savoir rejouer.' },
          { s: 'A', sql: "BEGIN;\nINSERT INTO orders VALUES (900000001, 42, 'livrée', 9.99, now());\nSELECT txid_current() AS mon_xid;", note: 'Dernière surprise. A crée une commande pour Gérard, sans toucher à la ligne de Gérard. Enfin, c\'est ce qu\'elle croit.' },
          { s: 'B', sql: 'SELECT xmin, xmax, name FROM users WHERE id = 42;', note: 'B regarde Gérard.', observe: '`xmax` vaut le xid de A, alors que personne ne le modifie ni ne le supprime ! La clé étrangère a posé un verrou `FOR KEY SHARE`, pour que Gérard ne soit pas supprimé pendant ce temps. Un verrou de ligne passe par `xmax`, avec un bit qui dit « ce n\'est qu\'un verrou ». **`xmax` non nul ne veut donc pas dire mort.**' },
          { s: 'A', sql: 'ROLLBACK;', note: 'A renonce à la commande.' },
        ],
      },
    },
    { keep: ['Visible = créateur existe pour moi **et** destructeur n\'existe pas pour moi.', 'COMMIT ne touche pas aux lignes : il change un statut dans le clog. ROLLBACK non plus.', '`xmax` sert aussi de verrou de ligne : non nul ne veut pas dire mort.'] },
  ],
};
