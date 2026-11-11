// Un labo : des étapes à lancer sur le VRAI Postgres, chacune dans une session nommée.
import { h, md, btn, inline } from './dom.js';
import { api } from './api.js';
import { store } from './store.js';

const SESSION_COLORS = { A: 'A', B: 'B', C: 'C', R: 'R', X: 'X' };

export async function labBanner() {
  const box = h('div', { class: 'lab-banner' }, 'Je regarde si le labo tourne…');
  const refresh = async () => {
    let st;
    try { st = await api.status(); } catch { st = null; }
    if (!st) {
      box.replaceChildren('Le serveur ne répond pas. Lance `npm start` dans le dossier du projet.');
      return;
    }
    if (st.docker && st.primary && st.replica) {
      box.className = 'lab-banner ok';
      box.replaceChildren(h('span', {}, '🟢 Postgres 17 tourne : primaire + réplica.'));
      return;
    }
    box.className = 'lab-banner';
    if (!st.docker) {
      box.replaceChildren('🔴 Docker ne répond pas. Démarre Docker Desktop puis recharge la page.');
      return;
    }
    const start = btn('Démarrer le labo', async () => {
      start.disabled = true;
      start.textContent = 'Démarrage… (le premier lancement prend une minute)';
      await api.sh('up');
      refresh();
    }, { class: 'primary small' });
    box.replaceChildren(h('span', {}, '🟠 Le labo est éteint.'), start);
  };
  refresh();
  return box;
}

function stepView(step, labId, idx) {
  const session = step.sh ? 'SH' : step.s ?? 'A';
  const target = step.target ?? 'primary';
  const output = h('div', { 'aria-live': 'polite' });
  const observe = step.observe ? h('div', { class: 'observe', hidden: true, html: inline(step.observe) }) : null;
  const area = step.sh ? null : h('textarea', { rows: Math.min(14, step.sql.trim().split('\n').length + 1), spellcheck: 'false', 'aria-label': `Requête pour la session ${session}` });
  if (area) area.value = step.sql.trim();
  const cancelBtn = step.sh ? null : btn('Annuler la requête', () => api.cancel(session, target), { class: 'small', hidden: true });
  const run = btn(step.sh ? `Lancer : ${step.label}` : 'Exécuter', async () => {
    run.disabled = true;
    const pre = h('pre', { class: 'out waiting' }, step.sh ? 'En cours…' : '⏳ En attente de la réponse de Postgres…');
    output.replaceChildren(pre);
    if (cancelBtn) cancelBtn.hidden = false;
    try {
      const r = step.sh ? await api.sh(step.sh) : await api.sql(session, area.value, target);
      pre.className = `out${r.ok ? '' : ' err'}`;
      pre.textContent = r.output || (r.ok ? '(OK, rien à afficher)' : '(erreur sans message)');
      if (r.ms > 800) pre.textContent += `\n\n⏱ ${(r.ms / 1000).toFixed(1)} s d'attente`;
      store.update((s) => {
        const k = `${labId}/${idx}`;
        if (!s.labs[k]) { s.labs[k] = true; s.score += 2; }
      });
    } catch (e) {
      pre.className = 'out err';
      pre.textContent = `Le serveur de labo ne répond pas : ${e.message}`;
    }
    run.disabled = false;
    if (cancelBtn) cancelBtn.hidden = true;
    if (observe) observe.hidden = false;
  }, { class: 'primary small' });
  return h('div', { class: 'step' },
    step.note ? md('p', step.note, { class: 'note' }) : null,
    h('div', { class: 'row', style: 'margin-bottom:5px' },
      h('span', { class: `sess ${SESSION_COLORS[session] ?? 'SH'}` }, step.sh ? 'shell' : target === 'replica' ? `réplica · ${session}` : `session ${session}`),
      step.blocks ? h('span', { class: 'chip wait' }, 'va bloquer') : null),
    area,
    h('div', { class: 'row', style: 'margin-top:5px' }, run, cancelBtn),
    output,
    observe,
  );
}

export function labBlock(lab) {
  const banner = h('div');
  labBanner().then((b) => banner.append(b));
  const closeAll = btn('Fermer les sessions', async () => {
    const used = new Set(lab.steps.filter((s) => !s.sh).map((s) => `${s.target ?? 'primary'}/${s.s ?? 'A'}`));
    for (const u of used) {
      const [target, session] = u.split('/');
      await api.cancel(session, target, true);
    }
    closeAll.textContent = 'Sessions fermées ✓';
    setTimeout(() => { closeAll.textContent = 'Fermer les sessions'; }, 1500);
  }, { class: 'small' });
  return h('section', { class: 'card lab', 'aria-label': `Labo : ${lab.title}` },
    h('div', { class: 'head' }, h('span', { class: 'tagline' }, '🧪 SUR LE VRAI POSTGRES'), closeAll),
    h('h3', {}, lab.title),
    lab.intro ? md('p', lab.intro) : null,
    banner,
    lab.steps.map((s, i) => stepView(s, lab.id, i)),
  );
}
