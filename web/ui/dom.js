// Petits outils DOM.
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter((c) => c != null && c !== false));
  return el;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Markdown en ligne : `code`, **gras**, *italique*. Le contenu vient des chapitres, pas d'un tiers. */
export function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

export const md = (tag, text, attrs = {}) => h(tag, { ...attrs, html: inline(text) });
export const btn = (label, onclick, attrs = {}) => h('button', { type: 'button', onclick, ...attrs }, label);
export const clear = (el) => { el.replaceChildren(); return el; };

export function slider({ label, min, max, step = 1, value, format = (v) => v, oninput }) {
  const out = h('output', {}, format(value));
  const input = h('input', {
    type: 'range', min, max, step, value, 'aria-label': label,
    oninput: (e) => { const v = Number(e.target.value); out.textContent = format(v); oninput(v); },
  });
  return h('div', { class: 'slider' }, h('label', {}, label), out, input);
}

export function table(head, rows) {
  return h('div', { class: 'scroll' }, h('table', { class: 'tbl' },
    h('thead', {}, h('tr', {}, head.map((c) => md('th', c)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => md('td', String(c))))))));
}

/** Rendu de texte stable : ne redessine pas ce qui n'a pas changé, pour garder le focus. */
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
