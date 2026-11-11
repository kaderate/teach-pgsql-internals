// La réplica : quatre LSN, plusieurs façons de prendre du retard.
import { h, btn, md, slider } from '../dom.js';
import { Replication, SYNC_MODES } from '../../sim/replication.js';
import { setMap } from '../map.js';

const DISK = 3000;

export function replicationLab() {
  let r;
  let timer = null;
  // « Recommencer » remet les compteurs à zéro, mais garde les réglages visibles à l'écran.
  const ctl = { writeRate: 10, network: 40, replayRate: 40, slot: true, feedback: false, maxSlotWal: Infinity, mode: 'local' };
  const reset = () => {
    r = new Replication(ctl);
    r.feedback = ctl.feedback;
    r.diskLimit = DISK;
  };
  reset();
  const out = h('div', { 'aria-live': 'off' });
  const paint = () => {
    const lag = r.lag();
    const max = Math.max(r.current, 1);
    const line = (name, v, cls, sub) => h('div', { class: 'bar-row' }, h('span', {}, name), h('div', { class: 'bar-track' }, h('div', { class: `bar-fill ${cls}`, style: `width:${(100 * v) / max}%` })), h('span', { class: 'v' }, sub));
    const wal = r.walOnDisk();
    const walPct = Math.min(100, (100 * wal) / DISK);
    let msg = 'Tout va bien, pour l\'instant.';
    let cls = 'good';
    if (r.diskFull) { msg = '🧨 pg_wal a rempli le disque. PANIC, le primaire s\'arrête. Une réplica morte vient de tuer le primaire.'; cls = 'bad'; }
    else if (r.lostSlot) { msg = 'Slot invalidé par max_slot_wal_keep_size : le primaire est sauvé, la réplica devra être reconstruite.'; cls = 'warn'; }
    else if (r.commitsWaiting >= 8) { msg = `🛑 Tous les clients sont bloqués dans COMMIT : le primaire attend un accusé que la réplica ne donne pas (synchronous_commit=${r.mode}).`; cls = 'bad'; }
    else if (r.blockedByQuery > 0) { msg = `🐢 Le rejeu est suspendu par une longue requête sur la réplica. Annulée dans ${r.feedback ? '(jamais, feedback actif)' : `${Math.max(0, r.maxStandbyDelay - r.queryAge)} ticks si max_standby_streaming_delay est atteint`}.`; cls = 'warn'; }
    else if (lag.sent > 0 && r.connected) { msg = 'Retard d\'envoi : le réseau ou le walsender ne suit pas. Regarde sent_lsn.'; cls = 'warn'; }
    else if (!r.connected) { msg = `Réplica déconnectée. ${r.slot ? 'Le slot retient le WAL : surveille le disque.' : 'Sans slot, le WAL est recyclé : la réplica risque de ne jamais pouvoir revenir.'}`; cls = 'warn'; }
    else if (lag.replay > 0 && lag.flush === 0) { msg = 'Le WAL arrive bien, c\'est le rejeu qui traîne. Rejeu mono-processus : souvent limité par les E/S de la réplica.'; cls = 'warn'; }
    out.replaceChildren(
      line('current (primaire)', r.current, '', `${r.current}`),
      line('sent', r.sent, '', `-${lag.sent} Mo`),
      line('write', r.write, '', `-${lag.write} Mo`),
      line('flush', r.flush, '', `-${lag.flush} Mo`),
      line('replay (lisible)', r.replay, 'hot', `-${lag.replay} Mo`),
      h('div', { class: 'three', style: 'margin-top:8px' },
        h('div', {}, h('b', {}, `pg_wal : ${wal} Mo`), h('div', { class: `gauge ${walPct > 80 ? 'bad' : walPct > 50 ? 'warn' : ''}` }, h('i', { style: `width:${walPct}%` }))),
        h('div', {}, h('b', {}, `COMMIT validés : ${r.committed}`), h('div', { class: 'caption-small' }, `${r.commitsWaiting} en attente d'accusé`)),
        h('div', {}, h('b', {}, `Requêtes annulées : ${r.cancelled}`), h('div', { class: 'caption-small' }, 'canceling statement due to conflict with recovery'))),
      h('div', { class: `status ${cls}` }, msg));
    setMap(r.connected ? ['walbuf', 'wal', 'walsender', 'replica'] : ['wal', 'walsender'], r.connected ? 'Le WAL traverse le **réseau**.' : 'Plus de réplica à l\'autre bout.');
  };
  const play = () => {
    if (timer) { clearInterval(timer); timer = null; playBtn.textContent = '▶ Lecture'; return; }
    timer = setInterval(() => {
      if (!out.isConnected) { clearInterval(timer); timer = null; return; }
      r.tick();
      paint();
    }, 300);
    playBtn.textContent = '⏸ Pause';
  };
  const playBtn = btn('▶ Lecture', play, { class: 'primary' });
  const select = h('select', { 'aria-label': 'synchronous_commit', onchange: (e) => { r.mode = ctl.mode = e.target.value; paint(); } },
    Object.entries(SYNC_MODES).map(([k, v]) => h('option', { value: k, title: v, selected: k === 'local' }, k)));
  const linkBtn = btn('✂️ Couper la réplica', () => { r.connected = !r.connected; linkBtn.textContent = r.connected ? '✂️ Couper la réplica' : '🔌 Rebrancher'; paint(); });
  paint();
  return h('section', { class: 'card' }, h('h3', {}, 'Le simulateur de retard'),
    h('div', { class: 'row', style: 'margin-bottom:8px' }, playBtn, btn('+10 ticks', () => { r.run(10); paint(); }),
      linkBtn,
      btn('🐢 Longue requête sur la réplica', () => { r.startLongQuery(15); paint(); }),
      h('label', { class: 'row tight' }, 'synchronous_commit ', select),
      h('label', { class: 'row tight' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { r.slot = ctl.slot = e.target.checked; paint(); } }), 'slot'),
      h('label', { class: 'row tight' }, h('input', { type: 'checkbox', onchange: (e) => { r.feedback = ctl.feedback = e.target.checked; paint(); } }), 'hot_standby_feedback'),
      h('label', { class: 'row tight' }, h('input', { type: 'checkbox', onchange: (e) => { r.maxSlotWal = ctl.maxSlotWal = e.target.checked ? 1000 : Infinity; paint(); } }), 'max_slot_wal_keep_size')),
    h('div', { class: 'three', style: 'margin-bottom:8px' },
      slider({ label: 'Écriture (Mo/tick)', min: 0, max: 60, value: 10, oninput: (v) => { r.writeRate = ctl.writeRate = v; } }),
      slider({ label: 'Réseau (Mo/tick)', min: 1, max: 100, value: 40, oninput: (v) => { r.network = ctl.network = v; } }),
      slider({ label: 'Rejeu (Mo/tick)', min: 1, max: 100, value: 40, oninput: (v) => { r.replayRate = ctl.replayRate = v; } })),
    out,
    h('div', { class: 'row', style: 'margin-top:8px' }, btn('Recommencer', () => { reset(); linkBtn.textContent = '✂️ Couper la réplica'; paint(); }, { class: 'small' })),
    md('p', 'Simulation : le débit et la taille du disque sont symboliques, les mécanismes sont ceux de Postgres.', { class: 'caption-small' }));
}
