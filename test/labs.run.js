// Exécute TOUTES les requêtes de TOUS les labos sur le vrai Postgres, dans l'ordre d'un apprenant.
// Échoue si une étape renvoie une erreur non prévue, ou si une étape « va bloquer » ne bloque pas.
// Prérequis : `npm start` et le labo démarré. Usage : npm run test:labs [-- id-de-chapitre]
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:4242';
const post = (path, body) => fetch(`${BASE}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Les chapitres importent des widgets qui touchent au DOM seulement à l'appel : l'import est sûr
// hors navigateur, à condition de ne pas exécuter les widgets.
globalThis.document ??= { createElement: () => ({}) };
const dir = new URL('../web/chapters/', import.meta.url);
const files = readdirSync(dir).filter((f) => /^ch\d+\.js$/.test(f)).sort();
const only = process.argv[2];
let failures = 0;
let steps = 0;

const health = await fetch(`${BASE}/api/status`).then((r) => r.json()).catch(() => null);
if (!health) { console.error(`Le serveur ne répond pas sur ${BASE}. Lance d'abord : npm start`); process.exit(2); }
if (!health.primary || !health.replica) { console.error('Le labo est éteint. Lance d\'abord : docker compose up -d --wait'); process.exit(2); }

for (const f of files) {
  const ch = (await import(pathToFileURL(new URL(f, dir).pathname).href)).default;
  if (only && ch.id !== only) continue;
  for (const block of ch.blocks) {
    if (!block.lab) continue;
    const lab = block.lab;
    console.log(`\n=== ${ch.id} / ${lab.title}`);
    const pending = [];
    const used = new Set();
    for (const [i, st] of lab.steps.entries()) {
      steps++;
      const label = `#${i + 1} ${st.sh ? `sh:${st.sh}` : `${st.target ?? 'primary'}/${st.s ?? 'A'}`}`;
      if (st.sh) {
        const r = await post('sh', { id: st.sh });
        if (!r.ok) { failures++; console.log(`  ✖ ${label}\n${r.output}`); } else console.log(`  ✔ ${label}`);
        if (st.sh === 'replica-start' || st.sh === 'crash') await sleep(4000);
        continue;
      }
      used.add(`${st.target ?? 'primary'}/${st.s ?? 'A'}`);
      // Un humain clique en quelques secondes ; ce script, non. Une session réveillée peut encore
      // finir sa réponse : on attend qu'elle soit libre plutôt que de signaler une fausse erreur.
      const send = async () => {
        for (let tries = 0; ; tries++) {
          const r = await post('sql', { session: st.s ?? 'A', target: st.target ?? 'primary', sql: st.sql });
          if (!r.busy || tries > 30) return r;
          await sleep(200);
        }
      };
      const req = send();
      if (st.blocks) {
        const state = await Promise.race([req.then(() => 'fini'), sleep(700).then(() => 'bloqué')]);
        if (state !== 'bloqué') { failures++; console.log(`  ✖ ${label} devait bloquer et a répondu`); } else console.log(`  ✔ ${label} bloque bien`);
        pending.push(req.then((r) => ({ label, r, st })));
        continue;
      }
      const r = await req;
      const hasError = !r.ok;
      if (hasError !== !!st.expectError) {
        failures++;
        console.log(`  ✖ ${label} ${st.expectError ? 'devait échouer' : 'ERREUR'}\n    SQL: ${st.sql.replace(/\n/g, ' ').slice(0, 140)}\n    ${r.output.split('\n').filter((l) => /ERROR|FATAL|perdue/.test(l)).join('\n    ') || r.output.slice(0, 300)}`);
      } else {
        console.log(`  ✔ ${label}${st.expectError ? ' (erreur attendue)' : ''}`);
        if (process.env.VERBOSE) console.log(r.output.split('\n').map((l) => `      ${l}`).join('\n'));
      }
    }
    for (const { label, r, st } of await Promise.all(pending)) {
      if (!r.ok && !st.expectErrorLater) { failures++; console.log(`  ✖ ${label} (débloqué) ${r.output.slice(0, 300)}`); }
    }
    for (const u of used) {
      const [target, session] = u.split('/');
      await post('cancel', { session, target, hard: true });
    }
  }
}
console.log(`\n${steps} étapes, ${failures} échec(s).`);
process.exit(failures ? 1 : 0);
