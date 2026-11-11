// Progression dans localStorage. Si le navigateur le refuse, ça marche quand même, sans mémoire.
const KEY = 'slonik-folies-v1';
const empty = () => ({ answers: {}, visited: {}, finished: {}, labs: {}, score: 0, theory: {}, theme: null });

function load() {
  try { return { ...empty(), ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return empty(); }
}
let state = load();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* tant pis */ } };
const listeners = new Set();

export const store = {
  get: () => state,
  update(fn) { fn(state); save(); listeners.forEach((l) => l(state)); },
  subscribe(l) { listeners.add(l); },
  reset() { state = empty(); save(); listeners.forEach((l) => l(state)); },
};

const RANKS = [
  [0, 'Stagiaire du pg_hba'], [40, 'Lecteur de pg_class'], [100, 'Dompteur de tuples'],
  [180, 'Rejoueur de WAL'], [280, 'Exorciste de locks'], [400, 'DBA de minuit'], [550, 'Grand Vizir du WAL'],
];
export const rank = (score) => RANKS.filter(([s]) => score >= s).at(-1)[1];
