#!/usr/bin/env node
// HTTP + SSE server. Binds to localhost by default because agents can run commands on this machine.
import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { CONNECTION_IDS } from './connections.js';
import { github } from './github.js';
import { providers } from './providers.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Store } from './store.js';
import { Engine } from './engine.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const HOST = process.env.APIARY_HOST || '127.0.0.1';
const PORT = Number(process.env.APIARY_PORT || 7777);
const TOKEN = process.env.APIARY_TOKEN || '';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const EXTRA_HOSTS = new Set((process.env.APIARY_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean));

export function createServer(engine) {
  const clients = new Set();
  engine.on('event', (ev) => {
    const data = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of clients) res.write(data);
  });
  setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000).unref();

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 1e6) reject(Object.assign(new Error('Body too large'), { status: 413 })); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(Object.assign(new Error('Bad JSON'), { status: 400 })); } });
  });

  function guard(req, url) {
    // Stops other websites (CSRF) and DNS-rebinding from driving a local agent runner.
    const hostName = (req.headers.host || '').replace(/:\d+$/, '');
    if (!LOOPBACK.has(hostName) && !EXTRA_HOSTS.has(hostName)) return [403, 'Host not allowed (set APIARY_ALLOWED_HOSTS)'];
    if (req.headers.origin) {
      let o; try { o = new URL(req.headers.origin).host; } catch { return [403, 'Bad origin']; }
      if (o !== req.headers.host) return [403, 'Cross-origin request blocked'];
    }
    if (TOKEN) {
      const cookie = /(?:^|;\s*)apiary_token=([^;]+)/.exec(req.headers.cookie || '')?.[1];
      const given = req.headers['x-apiary-token'] || url.searchParams.get('token') || (cookie && decodeURIComponent(cookie));
      if (given !== TOKEN) return [401, 'Token required'];
    }
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && !(req.headers['content-type'] || '').startsWith('application/json')) {
      return [415, 'Use application/json'];
    }
    return null;
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      const bad = guard(req, url);
      if (bad) return json(res, bad[0], { error: bad[1] });
      if (url.searchParams.get('token') && TOKEN && req.method === 'GET' && url.pathname === '/') {
        res.setHeader('set-cookie', `apiary_token=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/`);
      }
      const m = (re) => re.exec(url.pathname);
      let r;

      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
        const file = path.resolve(PUBLIC, rel);
        if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'Forbidden' });
        let body; try { body = readFileSync(file); } catch { return json(res, 404, { error: 'Not found' }); }
        const headers = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' };
        if (res.getHeader('set-cookie')) headers['set-cookie'] = res.getHeader('set-cookie');
        res.writeHead(200, headers);
        return res.end(body);
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return json(res, 200, { agents: Object.values(engine.agents), providers: engine.available, limits: engine.limits, defs: Object.values(engine.defs), approvals: engine.approvals(), approvalsDefault: engine.approvalsDefault, version: VERSION });
      }
      if (url.pathname === '/api/settings') {
        if (req.method === 'GET') return json(res, 200, { limits: engine.limits, approvalsDefault: engine.approvalsDefault });
        if (req.method === 'PUT') {
          const b = await readBody(req);
          const limits = engine.setLimits(b.limits || {});
          if (b.approvalsDefault !== undefined) engine.setApprovalsDefault(b.approvalsDefault);
          return json(res, 200, { limits, approvalsDefault: engine.approvalsDefault });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/approvals') return json(res, 200, engine.approvals());
      if ((r = m(/^\/api\/approvals\/([\w-]+)\/decide$/)) && req.method === 'POST') return json(res, 200, engine.decide(r[1], await readBody(req)));
      if (req.method === 'GET' && url.pathname === '/api/connections') {
        return json(res, 200, await Promise.all(CONNECTION_IDS.map((id) => engine.connections.view(id))));
      }
      if ((r = m(/^\/api\/connections\/(\w+)$/)) && req.method === 'PUT') {
        engine.connections.update(r[1], await readBody(req));
        return json(res, 200, await engine.connections.view(r[1]));
      }
      if ((r = m(/^\/api\/connections\/(\w+)\/test$/)) && req.method === 'POST') {
        if (!CONNECTION_IDS.includes(r[1])) throw Object.assign(new Error('Unknown connection'), { status: 404 });
        return json(res, 200, await engine.connections.test(r[1], providers));
      }
      if (req.method === 'GET' && url.pathname === '/api/github/repos') {
        return json(res, 200, await github.listRepos(engine.connections.get('github'), url.searchParams.get('q') || ''));
      }
      if (req.method === 'GET' && url.pathname === '/api/github/branches') {
        return json(res, 200, await github.listBranches(engine.connections.get('github'), url.searchParams.get('repo') || ''));
      }
      if (url.pathname === '/api/defs' || (r = m(/^\/api\/defs\/([\w-]+)$/))) {
        if (!r && req.method === 'GET') return json(res, 200, Object.values(engine.defs));
        if (!r && req.method === 'POST') return json(res, 201, engine.saveDef(await readBody(req)));
        if (r && req.method === 'PUT') { if (!engine.defs[r[1]]) throw Object.assign(new Error('No such saved agent'), { status: 404 }); return json(res, 200, engine.saveDef(await readBody(req), r[1])); }
        if (r && req.method === 'DELETE') { engine.removeDef(r[1]); return json(res, 200, { ok: true }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': hello\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/agents') {
        const b = await readBody(req);
        if (!b.provider) throw Object.assign(new Error('provider is required'), { status: 400 });
        if (!b.goal && !b.name && !b.source) throw Object.assign(new Error('Describe what you want done'), { status: 400 });
        if (b.cwd) {
          let ok = false; try { ok = statSync(b.cwd).isDirectory(); } catch { /* not a dir */ }
          if (!ok) throw Object.assign(new Error(`Folder does not exist: ${b.cwd}`), { status: 400 });
        }
        return json(res, 201, await engine.createLead(b));
      }
      if ((r = m(/^\/api\/agents\/([\w-]+)\/messages$/))) {
        const id = r[1];
        if (!engine.agents[id]) throw Object.assign(new Error('No such agent'), { status: 404 });
        if (req.method === 'GET') return json(res, 200, engine.messages(id));
        if (req.method === 'POST') {
          const b = await readBody(req);
          if (!b.text?.trim()) throw Object.assign(new Error('Empty message'), { status: 400 });
          engine.send(id, b.text).catch(() => {});
          return json(res, 202, { ok: true });
        }
      }
      if ((r = m(/^\/api\/agents\/([\w-]+)\/(logs|resume|takeover|pr|diff)$/))) {
        const [, id, what] = r;
        if (!engine.agents[id]) throw Object.assign(new Error('No such agent'), { status: 404 });
        if (what === 'diff' && req.method === 'GET') return json(res, 200, await engine.diff(id));
        if (what === 'logs' && req.method === 'GET') return json(res, 200, engine.logs(id));
        if (what === 'resume' && req.method === 'GET') return json(res, 200, { command: engine.resumeCommand(id) });
        if (what === 'takeover' && req.method === 'POST') return json(res, 200, engine.takeover(id));
        if (what === 'pr' && req.method === 'POST') return json(res, 200, { url: await engine.openPr(id, await readBody(req)) });
      }
      if ((r = m(/^\/api\/agents\/([\w-]+)\/stop$/)) && req.method === 'POST') {
        engine.stop(r[1]);
        return json(res, 200, { ok: true });
      }
      if ((r = m(/^\/api\/agents\/([\w-]+)$/)) && req.method === 'DELETE') {
        if (!engine.agents[r[1]]) throw Object.assign(new Error('No such agent'), { status: 404 });
        await engine.remove(r[1]);
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: 'Not found' });
    } catch (e) {
      json(res, e.status || 500, { error: e.message });
    }
  });
}

export function main() {
  if (!LOOPBACK.has(HOST) && !TOKEN) {
    console.error('Refusing to listen on a non-local address without APIARY_TOKEN set.');
    process.exit(1);
  }
  const store = new Store();
  const engine = new Engine(store);
  if (!engine.available.length) console.warn('No AI connected yet. Open the web UI > Connections, or install the `claude` / `codex` CLI.');
  const server = createServer(engine);
  server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Set APIARY_PORT to another port.` : e.message); process.exit(1); });
  server.listen(PORT, HOST, () => {
    console.log(`Apiary ${VERSION} running at http://${HOST}:${PORT}${TOKEN ? `/?token=${TOKEN}` : ''}`);
    console.log('Connected:', engine.available.map((p) => `${p.id} (${p.method})`).join(', ') || 'nothing yet');
  });
  const bye = () => { store.flush(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
