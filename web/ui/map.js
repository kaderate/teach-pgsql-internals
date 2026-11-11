// La carte du système : la même dans le chapitre 0 et, en réduction, tout au long de l'app.
import { h, inline } from './dom.js';

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
};

export const NODES = {
  client: { x: 12, y: 8, w: 130, h: 30, label: 'Ton client (psql, Rails…)', short: 'Client' },
  postmaster: { x: 218, y: 8, w: 130, h: 30, label: 'postmaster' },
  parser: { x: 22, y: 76, w: 76, h: 26, label: 'parser' },
  analyzer: { x: 104, y: 76, w: 76, h: 26, label: 'analyzer' },
  rewriter: { x: 186, y: 76, w: 76, h: 26, label: 'rewriter' },
  planner: { x: 268, y: 76, w: 76, h: 26, label: 'planner' },
  executor: { x: 22, y: 108, w: 322, h: 26, label: 'executor : index, heap, snapshots, verrous de ligne' },
  buffers: { x: 22, y: 176, w: 156, h: 30, label: 'shared_buffers' },
  walbuf: { x: 186, y: 176, w: 158, h: 30, label: 'WAL buffers' },
  locks: { x: 22, y: 212, w: 156, h: 26, label: 'table des verrous' },
  clogbuf: { x: 186, y: 212, w: 158, h: 26, label: 'cache du clog, snapshots' },
  bgwriter: { x: 22, y: 280, w: 76, h: 26, label: 'bgwriter' },
  checkpointer: { x: 104, y: 280, w: 96, h: 26, label: 'checkpointer' },
  walwriter: { x: 206, y: 280, w: 66, h: 26, label: 'walwriter' },
  walsender: { x: 278, y: 280, w: 66, h: 26, label: 'walsender' },
  autovacuum: { x: 22, y: 312, w: 322, h: 26, label: 'autovacuum' },
  heap: { x: 22, y: 380, w: 118, h: 30, label: 'base/ (tables, index)' },
  wal: { x: 146, y: 380, w: 96, h: 30, label: 'pg_wal/' },
  clog: { x: 248, y: 380, w: 96, h: 30, label: 'pg_xact/' },
  replica: { x: 112, y: 438, w: 232, h: 30, label: 'Réplica : walreceiver + startup' },
};

const ZONES = [
  { x: 12, y: 54, w: 342, h: 88, label: 'Backend : un processus par connexion' },
  { x: 12, y: 154, w: 342, h: 92, label: 'Mémoire partagée' },
  { x: 12, y: 258, w: 342, h: 88, label: 'Processus de fond' },
  { x: 12, y: 358, w: 342, h: 60, label: 'Disque' },
];

const LINKS = [
  ['M77,38 V76'], ['M283,38 C283,48 220,48 180,54'], ['M183,134 V176'], ['M266,134 V176'],
  ['M100,206 C70,250 60,260 60,280'], ['M265,238 C250,260 240,270 239,280'],
  ['M81,306 L81,380'], ['M239,306 L200,380'], ['M311,306 C320,380 320,420 300,438'],
];

export const DESCRIPTIONS = {
  client: ['Ton client', 'Il parle le protocole Postgres sur TCP ou socket Unix. Il ne touche jamais ni la mémoire ni les fichiers du serveur.'],
  postmaster: ['postmaster', 'Le père de tout le monde. Il écoute le port, `fork()` un backend à chaque connexion et relance les enfants qui meurent. Il ne traite aucune requête : si un backend crashe, il tue tous les autres et déclenche une recovery, car la mémoire partagée n\'est plus digne de confiance.'],
  parser: ['Parser', 'Texte vers arbre, grammaire seule. Il ne sait pas si ta table existe, seulement si ta phrase est grammaticale.'],
  analyzer: ['Analyzer', 'Résout les noms via le catalogue (`pg_class`, `pg_attribute`…) et vérifie les types et les droits.'],
  rewriter: ['Rewriter', 'Applique les règles : c\'est ici que les vues sont dépliées et que la row level security s\'ajoute.'],
  planner: ['Planner', 'Énumère des chemins possibles, estime leur coût avec les statistiques, garde le moins cher. Il ne lit aucune donnée de la table.'],
  executor: ['Executor', 'Exécute l\'arbre du plan : chaque nœud réclame la ligne suivante à ses enfants. C\'est lui qui parle au buffer pool, teste la visibilité et pose les verrous de ligne.'],
  buffers: ['shared_buffers', 'Le cache de pages de 8 Ko, partagé par tous les backends. Toute lecture et toute écriture passent par lui. Personne ne lit un tuple directement sur disque.'],
  walbuf: ['WAL buffers', 'Le tampon en mémoire des enregistrements du journal, avant leur écriture dans `pg_wal/`.'],
  locks: ['Table des verrous', 'Les verrous lourds (tables, xid…) vivent en mémoire partagée, avec leurs files d\'attente. Les verrous de ligne, eux, sont écrits dans la ligne, via son `xmax`.'],
  clogbuf: ['Clog et snapshots', 'Le statut des transactions (en cours, validée, annulée) en cache, et la liste des transactions actives d\'où chaque snapshot est tiré.'],
  bgwriter: ['Background writer', 'Écrit tranquillement des pages sales pour que les backends trouvent des cadres propres, et n\'aient pas à écrire eux-mêmes.'],
  checkpointer: ['Checkpointer', 'Force périodiquement toutes les pages sales sur disque et note un point de reprise : le WAL antérieur n\'est plus nécessaire à une recovery.'],
  walwriter: ['WAL writer', 'Écrit le WAL en tâche de fond. Un backend qui valide en `synchronous_commit=on` n\'attend personne : il force lui-même le flush si ce n\'est pas déjà fait.'],
  walsender: ['WAL sender', 'Un processus par réplica connectée. Il lit le WAL sur disque et le pousse sur le réseau.'],
  autovacuum: ['Autovacuum', 'Un lanceur et des workers qui nettoient les versions mortes, mettent à jour les statistiques et gèlent les vieilles lignes.'],
  heap: ['base/', 'Tes tables et tes index : des fichiers découpés en pages de 8 Ko, et en segments de 1 Go. Ils sont écrits en retard, et le WAL garantit qu\'on s\'y retrouve.'],
  wal: ['pg_wal/', 'Le journal : des segments de 16 Mo, écrits uniquement à la suite. Pour Postgres, c\'est la vraie source de vérité en cas de crash.'],
  clog: ['pg_xact/', 'Le clog : deux bits par transaction. C\'est lui qui sait si un xid a été validé.'],
  replica: ['Réplica', 'Un autre serveur. Son walreceiver écrit le WAL reçu, son processus startup le rejoue en boucle : c\'est une recovery qui ne se termine jamais.'],
};

export function createMap({ interactive = false, onSelect } = {}) {
  const svg = s('svg', { viewBox: '0 0 366 478', class: `map${interactive ? ' interactive' : ''}`, role: 'img', 'aria-label': 'Carte des composants de PostgreSQL' });
  for (const z of ZONES) {
    svg.append(s('rect', { x: z.x, y: z.y, width: z.w, height: z.h, class: 'zone' }));
    svg.append(s('text', { x: z.x + 8, y: z.y + 15, class: 't' }, z.label));
  }
  for (const [d] of LINKS) svg.append(s('path', { d, class: 'link' }));
  const els = {};
  for (const [id, n] of Object.entries(NODES)) {
    const label = s('text', { x: n.x + n.w / 2, y: n.y + n.h / 2 + 4, 'text-anchor': 'middle' }, n.short && !interactive ? n.short : n.label);
    const g = s('g', { class: 'node', 'data-id': id }, s('rect', { x: n.x, y: n.y, width: n.w, height: n.h }), label);
    if (interactive) {
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', n.label);
      const pick = () => {
        Object.values(els).forEach((e) => e.classList.remove('sel'));
        g.classList.add('sel');
        onSelect?.(id);
      };
      g.addEventListener('click', pick);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    }
    els[id] = g;
    svg.append(g);
  }
  const token = s('text', { class: 'token', x: 0, y: 0, opacity: 0 }, '🐘');
  token.style.fontSize = '22px';
  svg.append(token);
  return {
    el: svg,
    light(ids = []) {
      Object.entries(els).forEach(([id, e]) => e.classList.toggle('lit', ids.includes(id)));
      const last = ids.at(-1);
      if (last && NODES[last]) {
        const n = NODES[last];
        token.setAttribute('opacity', 1);
        token.style.transform = `translate(${n.x + n.w - 18}px, ${n.y + 8}px)`;
      } else {
        token.setAttribute('opacity', 0);
      }
    },
  };
}

// La carte latérale, unique, pilotée par tout le monde.
let side = null;
let captionEl = null;
export function mountSideMap(container) {
  side = createMap();
  captionEl = h('p', { class: 'caption', 'aria-live': 'polite' });
  container.append(h('h2', {}, 'Tu es ici'), side.el, captionEl);
}
export function setMap(ids = [], caption = '') {
  side?.light(ids);
  if (captionEl) captionEl.innerHTML = inline(caption);
}
