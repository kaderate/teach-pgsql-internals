// Tableau blanc, astreinte et bac à sable.
import { h, btn, md, inline, clear } from '../dom.js';
import { api } from '../api.js';
import { labBanner } from '../lab.js';
import { store } from '../store.js';
import { elephantRain } from '../blocks.js';
import { setMap } from '../map.js';

/** Remets les étapes dans l'ordre. L'ordre de départ est fixe pour rester reproductible. */
export function orderGame({ id, title, items, shuffled }) {
  return () => {
    let order = shuffled.map((i) => items[i]);
    const list = h('ol', { class: 'order-list' });
    const status = h('div', { 'aria-live': 'polite' });
    let checked = false;
    const move = (i, d) => {
      const j = i + d;
      if (j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      checked = false;
      paint();
      list.children[j]?.querySelectorAll('button')[d < 0 ? 0 : 1]?.focus();
    };
    const paint = () => {
      clear(list).append(...order.map((t, i) => {
        const ok = checked && t === items[i];
        const ko = checked && t !== items[i];
        return h('li', { class: ok ? 'right' : ko ? 'wrong' : '' },
          h('div', { class: 'row tight' },
            btn('↑', () => move(i, -1), { class: 'small', disabled: i === 0, 'aria-label': 'Monter' }),
            btn('↓', () => move(i, 1), { class: 'small', disabled: i === order.length - 1, 'aria-label': 'Descendre' })),
          h('span', { html: inline(t) }));
      }));
    };
    paint();
    return h('section', { class: 'card' }, h('h3', {}, title), list,
      h('div', { class: 'row', style: 'margin-top:10px' }, btn('Vérifier', () => {
        checked = true;
        paint();
        const good = order.filter((t, i) => t === items[i]).length;
        if (good === items.length) {
          status.replaceChildren(h('div', { class: 'status good' }, 'Sans faute. Tu peux aller le raconter au tableau.'));
          if (!store.get().finished[`order/${id}`]) store.update((s) => { s.finished[`order/${id}`] = true; s.score += 30; });
          elephantRain(30);
        } else {
          status.replaceChildren(h('div', { class: 'status warn' }, `${good} sur ${items.length} bien placées. Le rouge est faux, le vert est bon.`));
        }
      }, { class: 'primary' })), status);
  };
}

/** Une astreinte : symptômes, sondes, hypothèse. Chaque sonde coûte des minutes. */
export function incident(sc) {
  return () => {
    const answered = store.get().answers[`inc/${sc.id}`];
    let minutes = 0;
    const clock = h('span', { class: 'clock' });
    const tick = () => { const m = 12 + minutes; clock.textContent = `03:${String(m).padStart(2, '0')}`; };
    tick();
    const tools = h('div', { class: 'row' });
    const outputs = h('div');
    const verdict = h('div', { 'aria-live': 'polite' });
    sc.probes.forEach((p) => {
      const b = btn(`${p.name} (+${p.cost ?? 2} min)`, () => {
        minutes += p.cost ?? 2;
        tick();
        b.disabled = true;
        outputs.append(h('div', { class: 'tool-out' }, md('p', p.sql ? `\`${p.sql}\`` : p.name, { class: 'caption-small' }), h('pre', { class: 'out' }, p.out)));
      }, { class: 'small' });
      tools.append(b);
    });
    const finish = (o, fresh) => {
      hypo.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      verdict.replaceChildren(
        h('div', { class: `verdict${o.ok ? '' : ' bad'}`, html: inline(o.why) }),
        h('div', { class: 'keep', style: 'margin-top:8px' }, h('h3', {}, '🩹 Le remède'), h('ul', {}, sc.fix.map((f) => md('li', f)))),
        fresh ? h('p', { class: 'caption-small' }, `Diagnostic rendu en ${minutes} minutes d'enquête.`) : '');
      if (fresh && o.ok) elephantRain(10);
    };
    const hypo = h('div', { class: 'opts', style: 'display:grid;gap:6px;margin-top:6px' }, sc.hypotheses.map((o, i) => {
      const b = btn('', () => {
        store.update((s) => { s.answers[`inc/${sc.id}`] = i; s.score += o.ok ? Math.max(10, 30 - minutes) : 3; });
        finish(o, true);
      });
      b.style.textAlign = 'left';
      b.innerHTML = inline(o.t);
      return b;
    }));
    if (answered != null) queueMicrotask(() => finish(sc.hypotheses[answered], false));
    return h('section', { class: 'card pager' },
      h('div', { class: 'row spread' }, h('span', { class: 'alert-head' }, `📟 ${sc.alert}`), clock),
      md('p', sc.story),
      h('h4', { style: 'margin:8px 0 4px' }, 'Tes sondes'), tools, outputs,
      h('h4', { style: 'margin:12px 0 2px' }, 'Ton diagnostic'), hypo, verdict);
  };
}

/** Le bac à sable : autant de sessions que nécessaire, sans scénario. */
export function sandbox() {
  const presets = [
    ['Qui fait quoi', `SELECT pid, application_name, state, wait_event_type, wait_event,
       pg_blocking_pids(pid) AS bloqué_par, left(query, 50) AS query
FROM pg_stat_activity WHERE backend_type = 'client backend';`],
    ['Verrous', `SELECT l.pid, l.locktype, l.mode, l.granted, l.relation::regclass
FROM pg_locks l JOIN pg_stat_activity a USING (pid)
WHERE a.backend_type = 'client backend' AND l.pid <> pg_backend_pid();`],
    ['Vraies versions de Gérard', `SELECT lp, t_xmin, t_xmax, t_ctid, lp_flags
FROM heap_page_items(get_raw_page('users', 0)) WHERE lp BETWEEN 40 AND 44;`],
    ['Réplication', `SELECT application_name, state, sent_lsn, write_lsn, flush_lsn, replay_lsn, sync_state
FROM pg_stat_replication;`],
    ['Dead tuples', `SELECT relname, n_live_tup, n_dead_tup, last_autovacuum, n_tup_hot_upd
FROM pg_stat_user_tables ORDER BY n_dead_tup DESC;`],
  ];
  const pane = (session, target, label) => {
    const area = h('textarea', { rows: 6, spellcheck: 'false', 'aria-label': `SQL pour ${label}` });
    area.value = 'SELECT xmin, xmax, ctid, * FROM users WHERE id = 42;';
    const out = h('pre', { class: 'out' }, 'Prêt.');
    const run = btn('Exécuter (Ctrl+Entrée)', async () => {
      run.disabled = true;
      out.className = 'out waiting';
      out.textContent = '⏳ En attente…';
      try {
        const r = await api.sql(session, area.value, target);
        out.className = `out${r.ok ? '' : ' err'}`;
        out.textContent = r.output || '(OK)';
      } catch (e) {
        out.className = 'out err';
        out.textContent = e.message;
      }
      run.disabled = false;
    }, { class: 'primary small' });
    area.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run.click(); });
    return h('div', { class: 'pane' }, h('div', { class: 'row spread' }, h('span', { class: `sess ${session}` }, label),
      h('select', { 'aria-label': 'Requête préparée', onchange: (e) => { if (e.target.value !== '') area.value = presets[e.target.value][1]; e.target.value = ''; } },
        h('option', { value: '' }, 'Requêtes prêtes…'), presets.map(([n], i) => h('option', { value: i }, n)))),
    h('div', { style: 'height:6px' }), area,
    h('div', { class: 'row', style: 'margin-top:5px' }, run, btn('Annuler', () => api.cancel(session, target), { class: 'small' }), btn('Fermer', async () => { await api.cancel(session, target, true); out.textContent = 'Session fermée.'; out.className = 'out'; }, { class: 'small' })),
    out);
  };
  const banner = h('div');
  labBanner().then((b) => banner.append(b));
  setMap(['client', 'postmaster', 'executor'], 'Le **vrai** Postgres.');
  const resetBtn = btn('🗑️ Recréer le labo à neuf', async () => {
    if (!confirm('Détruire et recréer les conteneurs et les données du labo ? Tes tables de test disparaîtront.')) return;
    resetBtn.disabled = true;
    resetBtn.textContent = 'Recréation en cours…';
    const r = await api.sh('reset-all');
    resetBtn.disabled = false;
    resetBtn.textContent = r.ok ? 'Labo recréé ✓' : 'Échec, regarde Docker';
  }, { class: 'small danger' });
  return h('section', { class: 'card lab' }, banner, h('div', { class: 'two' },
    pane('A', 'primary', 'session A'), pane('B', 'primary', 'session B'), pane('C', 'primary', 'session C'), pane('R', 'replica', 'réplica · R')),
  h('div', { class: 'row', style: 'margin-top:12px' }, resetBtn));
}
