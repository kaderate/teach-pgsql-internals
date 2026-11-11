// Les formules de coût du planner (costsize.c), en version lisible. Pur, sans DOM.
// Seq scan : exacte. Index scan et bitmap : mêmes ingrédients que Postgres, simplifiés sur la
// hauteur de l'arbre et le cache, donc ordre de grandeur et point de bascule réalistes.

export const DEFAULTS = {
  seq_page_cost: 1,
  random_page_cost: 4,
  cpu_tuple_cost: 0.01,
  cpu_index_tuple_cost: 0.005,
  cpu_operator_cost: 0.0025,
  effective_cache_size: 16384, // en pages : 128 Mo
};

export function seqScanCost({ pages, rows, quals = 1 }, c = DEFAULTS) {
  const disk = pages * c.seq_page_cost;
  const cpu = rows * (c.cpu_tuple_cost + quals * c.cpu_operator_cost);
  return { startup: 0, total: disk + cpu, disk, cpu };
}

/** Formule de Mackert & Lohman, utilisée par index_pages_fetched(). */
export function pagesFetched(tuples, pages, cachePages) {
  const T = Math.max(pages, 1);
  const b = Math.max(1, Math.ceil((cachePages * T) / (T + 1)));
  if (T <= b) {
    const f = (2 * T * tuples) / (2 * T + tuples);
    return Math.ceil(Math.min(f, T));
  }
  const lim = (2 * T * b) / (2 * T - b);
  if (tuples <= lim) return Math.ceil((2 * T * tuples) / (2 * T + tuples));
  return Math.ceil(b + (tuples - lim) * (T - b) / T);
}

function indexDescent({ rows, selectivity, indexPages }, c) {
  const matched = Math.max(1, rows * selectivity);
  const leafPages = Math.max(1, Math.ceil(indexPages * selectivity));
  const startup = Math.ceil(Math.log2(Math.max(rows, 2))) * c.cpu_operator_cost + 50 * c.cpu_operator_cost;
  const io = leafPages * c.random_page_cost;
  const cpu = matched * (c.cpu_index_tuple_cost + c.cpu_operator_cost);
  return { startup, total: startup + io + cpu, matched, leafPages };
}

export function indexScanCost(t, c = DEFAULTS) {
  const { pages, correlation = 0 } = t;
  const idx = indexDescent(t, c);
  const worst = pagesFetched(idx.matched, pages, c.effective_cache_size);
  const maxIo = worst * c.random_page_cost;
  const minPages = Math.max(1, Math.ceil(t.selectivity * pages));
  const minIo = c.random_page_cost + (minPages - 1) * c.seq_page_cost;
  const csq = correlation * correlation;
  const heapIo = maxIo + csq * (minIo - maxIo);
  const cpu = idx.matched * (c.cpu_tuple_cost + (t.quals ?? 0) * c.cpu_operator_cost);
  return { startup: idx.startup, total: idx.total + heapIo + cpu, heapPages: Math.round(worst + csq * (minPages - worst)) };
}

export function indexOnlyScanCost(t, c = DEFAULTS) {
  const allVisible = t.allVisible ?? 1;
  const base = indexScanCost(t, c);
  const idx = indexDescent(t, c);
  const heapPart = base.total - idx.total;
  return { startup: idx.startup, total: idx.total + heapPart * (1 - allVisible), heapPages: Math.round(base.heapPages * (1 - allVisible)) };
}

export function bitmapScanCost(t, c = DEFAULTS) {
  const { pages, selectivity } = t;
  const idx = indexDescent(t, c);
  const fetched = Math.min(pages, pagesFetched(idx.matched, pages, c.effective_cache_size));
  // Plus on lit de pages, plus la lecture triée ressemble à une lecture séquentielle.
  const costPerPage = fetched >= 2
    ? c.random_page_cost - (c.random_page_cost - c.seq_page_cost) * Math.sqrt(fetched / pages)
    : c.random_page_cost;
  const heapIo = fetched * costPerPage;
  const startup = idx.total + 0.1 * c.cpu_operator_cost * idx.matched;
  const cpu = idx.matched * (c.cpu_tuple_cost + (t.quals ?? 0) * c.cpu_operator_cost);
  return { startup, total: startup + heapIo + cpu, heapPages: fetched, selectivity };
}

export function comparePlans(t, c = DEFAULTS) {
  const plans = [
    { name: 'Seq Scan', ...seqScanCost(t, c) },
    { name: 'Index Scan', ...indexScanCost(t, c) },
    { name: 'Bitmap Heap Scan', ...bitmapScanCost(t, c) },
  ];
  if (t.indexOnlyPossible) plans.push({ name: 'Index Only Scan', ...indexOnlyScanCost(t, c) });
  const best = plans.reduce((a, b) => (b.total < a.total ? b : a));
  return { plans, best: best.name };
}

/**
 * La bascule : à partir de quelle sélectivité le Seq Scan gagne-t-il ?
 * `only` restreint la comparaison à un seul concurrent ('index' ou 'bitmap').
 */
export function seqTakeover(t, c = DEFAULTS, only = null) {
  let low = 1e-6;
  let high = 1;
  const seq = seqScanCost(t, c).total;
  const indexBetter = (s) => {
    const row = { ...t, selectivity: s };
    const costs = [];
    if (only !== 'bitmap') costs.push(indexScanCost(row, c).total);
    if (only !== 'index') costs.push(bitmapScanCost(row, c).total);
    return Math.min(...costs) < seq;
  };
  if (!indexBetter(low)) return 0;
  if (indexBetter(high)) return 1;
  for (let i = 0; i < 40; i++) {
    const mid = Math.sqrt(low * high);
    if (indexBetter(mid)) low = mid; else high = mid;
  }
  return low;
}
