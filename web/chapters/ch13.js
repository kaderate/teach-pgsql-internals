import { sandbox } from '../ui/widgets/games.js';

export default {
  id: 'bac-a-sable', icon: '🏖️', nav: 'Bac à sable', kicker: 'HORS CHAPITRE',
  title: 'Trois sessions, une réplica, aucune consigne',
  map: ['client', 'postmaster', 'executor'], mapCaption: 'Le **vrai** Postgres, sans filet.',
  blocks: [
    'Chaque panneau est une vraie connexion, qui garde ses transactions ouvertes d\'une exécution à l\'autre. `Ctrl+Entrée` pour lancer. Les `\\d`, `\\gset` et autres commandes de `psql` marchent.',
    { widget: sandbox },
    { say: 'Tu casses tout ? Ce n\'est que ton labo. Le bouton rouge remet tout à neuf.' },
  ],
};
