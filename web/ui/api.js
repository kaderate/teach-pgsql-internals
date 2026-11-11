// Client du serveur de labo.
async function post(path, body) {
  const r = await fetch(`/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
export const api = {
  status: () => fetch('/api/status').then((r) => r.json()),
  sql: (session, sql, target = 'primary') => post('sql', { session, sql, target }),
  sh: (id) => post('sh', { id }),
  cancel: (session, target = 'primary', hard = false) => post('cancel', { session, target, hard }),
};
