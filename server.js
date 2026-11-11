// Serveur du labo : fichiers statiques + pont vers de vraies sessions psql dans Docker.
// Zéro dépendance. N'écoute que sur 127.0.0.1.
//
// Une session = un processus `psql` qui vit longtemps, donc une vraie connexion, donc un vrai
// backend Postgres : un BEGIN survit entre deux clics et un verrou bloque pour de vrai.
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const WEB = join(ROOT, 'web');
const PORT = Number(process.env.PORT || 4242);
const HOST = '127.0.0.1';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// ---------- Commandes shell autorisées : liste fermée, aucune entrée utilisateur. ----------
const inPrimary = (cmd) => ['exec', '-T', 'primary', 'sh', '-c', cmd];
const psqlPrimary = (sql) => `psql -U slonik -d labo -Atc "${sql}"`;
const SHELL = {
  up: { args: ['up', '-d', '--wait'], timeout: 300_000 },
  'reset-all': { chain: [['down', '-v'], ['up', '-d', '--wait']], timeout: 300_000 },
  ps: { args: inPrimary('ps -eo pid,ppid,rss,cmd --forest | grep -v "ps -eo" | grep -v "sh -c"') },
  'ls-data': { args: inPrimary('cd $PGDATA && ls -la') },
  'du-data': { args: inPrimary('cd $PGDATA && du -sh base global pg_wal pg_xact pg_multixact pg_stat 2>/dev/null') },
  'ls-wal': { args: inPrimary('cd $PGDATA/pg_wal && ls -la | tail -8') },
  'ls-xact': { args: inPrimary('cd $PGDATA/pg_xact && ls -la') },
  'ls-users': { args: inPrimary(`cd $PGDATA && F=$(${psqlPrimary("select pg_relation_filepath('users')")}) && echo "users -> $F" && ls -la $F*`) },
  'hex-page': { args: inPrimary(`cd $PGDATA && F=$(${psqlPrimary("checkpoint; select pg_relation_filepath('users')")} | tail -1) && echo "Page 0 de $F, 64 premiers octets (en-tête + début des line pointers) :" && od -A d -t x1z -N 64 $F && echo && echo "Fin de la page 0 (les tuples partent du bas) :" && od -A d -t x1z -j 8064 -N 128 $F`) },
  'hex-wal': { args: inPrimary(`cd $PGDATA/pg_wal && F=$(ls | grep -E '^[0-9A-F]{24}$' | sort | tail -1) && echo "Segment $F, 96 premiers octets :" && od -A d -t x1z -N 96 $F`) },
  waldump: { args: inPrimary(`cd $PGDATA/pg_wal && F=$(${psqlPrimary("select pg_walfile_name(pg_current_wal_flush_lsn())")}) && pg_waldump -p . $F 2>/dev/null | tail -25 | cut -c1-170`) },
  'logs-primary': { base: ['logs', '--tail', '30', '--no-color', 'primary'] },
  'logs-replica': { base: ['logs', '--tail', '20', '--no-color', 'replica'] },
  crash: { chain: [['kill', '-s', 'KILL', 'primary'], ['start', 'primary']], timeout: 120_000 },
  'replica-stop': { base: ['stop', 'replica'], timeout: 60_000 },
  'replica-start': { base: ['start', 'replica'], timeout: 60_000 },
  ls: { base: ['ps', '--format', '{{.Service}} {{.Status}}'] },
};
SHELL.up.base = SHELL.up.args; delete SHELL.up.args;
for (const s of Object.values(SHELL)) if (s.args) { s.base = s.args; delete s.args; }

function compose(args, timeout = 30_000) {
  return new Promise((resolve) => {
    execFile('docker', ['compose', ...args], { cwd: ROOT, timeout, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}${stderr}`.trimEnd() });
    });
  });
}

async function runShell(id) {
  const cmd = Object.hasOwn(SHELL, id) ? SHELL[id] : null;
  if (!cmd) return { ok: false, output: `Commande inconnue : ${id}` };
  if (cmd.chain) {
    const out = [];
    let ok = true;
    for (const args of cmd.chain) {
      const r = await compose(args, cmd.timeout);
      out.push(r.output);
      ok &&= r.ok;
    }
    if (id === 'crash') {
      const ready = await waitReady();
      out.push(ready ? 'Le primaire accepte de nouveau les connexions.' : 'Le primaire ne répond toujours pas.');
      ok &&= ready;
    }
    return { ok, output: out.filter(Boolean).join('\n') };
  }
  return compose(cmd.base, cmd.timeout);
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    const r = await compose(['exec', '-T', 'primary', 'pg_isready', '-U', 'slonik', '-d', 'labo'], 5000);
    if (r.ok) return true;
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

// ---------- Sessions psql ----------
const SESSION_NAME = /^[A-Za-z0-9]{1,8}$/;
const TARGETS = new Set(['primary', 'replica']);
const sessions = new Map();

/** Ajoute le `;` manquant sans toucher aux méta-commandes psql. */
export function terminate(sql) {
  const trimmed = sql.trim();
  if (!trimmed) return '';
  const last = trimmed.split('\n').at(-1).trim();
  if (trimmed.endsWith(';') || last.startsWith('\\') || /\\g\w*(\s+\S+)?$/.test(last)) return trimmed;
  return `${trimmed};`;
}

class PsqlSession {
  constructor(name, target) {
    this.name = name;
    this.target = target;
    this.buffer = '';
    this.pending = null;
    this.pid = null;
    this.alive = true;
    this.proc = spawn('docker', ['compose', 'exec', '-T', '-e', `PGAPPNAME=labo-${name}`, target, 'sh', '-c',
      'exec psql -U slonik -d labo -X -P pager=off 2>&1'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => this.onData(d));
    this.proc.stderr.on('data', (d) => this.onData(d));
    this.proc.stdin.on('error', () => {});
    this.proc.on('exit', () => this.onExit());
    this.proc.on('error', () => this.onExit());
    this.ready = this.send('SELECT pg_backend_pid();').then((r) => {
      const m = /^\s*(\d+)\s*$/m.exec(r.output);
      if (m) this.pid = Number(m[1]);
      return r;
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    if (!this.pending) return;
    const { marker, resolve } = this.pending;
    const at = this.buffer.indexOf(marker);
    if (at === -1) return;
    const output = this.buffer.slice(0, at).trimEnd();
    this.buffer = this.buffer.slice(at + marker.length).replace(/^\n/, '');
    this.pending = null;
    resolve({ ok: !/^(.*:\d+: )?(ERROR|FATAL|PANIC):/m.test(output), output });
  }

  onExit() {
    this.alive = false;
    if (sessions.get(this.key) === this) sessions.delete(this.key);
    this.lastOutput = this.buffer.trim();
    if (this.pending) {
      const { resolve } = this.pending;
      this.pending = null;
      resolve({ ok: false, output: `${this.buffer.trimEnd()}\n(connexion perdue : le backend de cette session est mort)`.trim(), died: true });
    }
  }

  send(sql) {
    if (!this.alive) return Promise.resolve({ ok: false, died: true, output: '(connexion perdue)' });
    if (this.pending) return Promise.reject(new Error('busy'));
    const marker = `__FIN_${randomBytes(8).toString('hex')}__`;
    return new Promise((resolve) => {
      this.pending = { marker, resolve };
      this.proc.stdin.write(`${sql}\n\\echo ${marker}\n`);
    });
  }

  kill() {
    this.alive = false;
    this.proc.kill('SIGKILL');
  }
}

function getSession(name, target) {
  const key = `${target}/${name}`;
  let s = sessions.get(key);
  if (!s || !s.alive) {
    s = new PsqlSession(name, target);
    s.key = key;
    sessions.set(key, s);
  }
  return s;
}

/** Une connexion jetable pour parler au serveur quand une session est bloquée. */
async function adminSql(target, sql) {
  return compose(['exec', '-T', target, 'psql', '-U', 'slonik', '-d', 'labo', '-X', '-Atc', sql], 10_000);
}

async function runSql({ session, target = 'primary', sql }) {
  if (!SESSION_NAME.test(session || '')) return { status: 400, body: { ok: false, output: 'Nom de session invalide.' } };
  if (!TARGETS.has(target)) return { status: 400, body: { ok: false, output: 'Cible invalide.' } };
  if (typeof sql !== 'string' || !sql.trim()) return { status: 400, body: { ok: false, output: 'Requête vide.' } };
  const s = getSession(session, target);
  if (s.pending && !s.pid) await s.ready;
  // psql est mort au démarrage : le labo est éteint, ou le serveur redémarre encore.
  if (!s.alive) {
    const why = s.lastOutput ? `\n\n${s.lastOutput}` : '';
    return { status: 200, body: { ok: false, output: `Impossible de joindre Postgres (${target}). Le labo est-il démarré ?${why}` } };
  }
  if (s.pending) return { status: 409, body: { ok: false, busy: true, output: 'Cette session attend déjà une réponse. Annule-la ou attends.' } };
  const started = Date.now();
  const r = await s.send(terminate(sql));
  return { status: 200, body: { ...r, ms: Date.now() - started, pid: s.pid } };
}

async function cancelSession({ session, target = 'primary', hard = false }) {
  if (!SESSION_NAME.test(session || '') || !TARGETS.has(target)) return { status: 400, body: { ok: false } };
  const s = sessions.get(`${target}/${session}`);
  if (!s) return { status: 200, body: { ok: true, output: 'Aucune session à ce nom.' } };
  if (hard) {
    if (s.pid) await adminSql(target, `select pg_terminate_backend(${Number(s.pid)})`);
    s.kill();
    sessions.delete(`${target}/${session}`);
    return { status: 200, body: { ok: true, output: 'Session fermée.' } };
  }
  if (!s.pid) return { status: 200, body: { ok: false, output: 'Backend inconnu.' } };
  const r = await adminSql(target, `select pg_cancel_backend(${Number(s.pid)})`);
  return { status: 200, body: { ok: r.ok, output: r.output } };
}

function closeAllSessions() {
  for (const s of sessions.values()) s.kill();
  sessions.clear();
}

async function status() {
  const r = await compose(['ps', '--format', '{{.Service}}|{{.State}}|{{.Health}}'], 8000);
  if (!r.ok) return { docker: false, primary: false, replica: false, output: r.output };
  const lines = r.output.split('\n').map((l) => l.split('|'));
  const up = (svc) => lines.some(([name, state, health]) => name === svc && state === 'running' && health !== 'starting' && health !== 'unhealthy');
  return { docker: true, primary: up('primary'), replica: up('replica'), sessions: [...sessions.keys()] };
}

// ---------- HTTP ----------
function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new Error('trop gros');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = normalize(join(WEB, rel));
  if (file !== WEB && !file.startsWith(WEB + sep)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Introuvable');
  }
}

const allowedHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

export const server = createServer(async (req, res) => {
  try {
    // Bloque le DNS rebinding et les POST lancés par un autre site vers ce serveur local.
    if (!allowedHosts.has(req.headers.host)) { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!url.pathname.startsWith('/api/')) return await serveStatic(req, res, url.pathname);
    if (url.pathname === '/api/status' && req.method === 'GET') return json(res, 200, await status());
    if (req.method !== 'POST' || !(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { ok: false });
    const body = await readJson(req);
    if (url.pathname === '/api/sql') { const r = await runSql(body); return json(res, r.status, r.body); }
    if (url.pathname === '/api/cancel') { const r = await cancelSession(body); return json(res, r.status, r.body); }
    if (url.pathname === '/api/sh') {
      if (body.id === 'reset-all' || body.id === 'crash') closeAllSessions();
      return json(res, 200, await runShell(body.id));
    }
    return json(res, 404, { ok: false });
  } catch (e) {
    json(res, 500, { ok: false, output: String(e.message || e) });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.on('error', (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    console.log(`\n🐘  Le port ${PORT} est déjà pris, sans doute par un Slonik Folies qui tourne encore : http://localhost:${PORT}`);
    console.log(`    Pour l'arrêter : kill $(lsof -tiTCP:${PORT} -sTCP:LISTEN)   ·   ou changer de port : PORT=4243 npm start\n`);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`\n🐘  Slonik Folies : http://localhost:${PORT}\n`);
  });
  const stop = () => { closeAllSessions(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
