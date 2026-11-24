#!/usr/bin/env node
// HTTP + SSE server. Binds to localhost by default because agents can run commands on this machine.
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { CONNECTION_IDS } from './connections.js';
import { github } from './github.js';
import { providers } from './providers.js';
import * as service from './service.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { Updater } from './updater.js';
import { authArgs } from './github.js';
import * as orgfiles from './orgfiles.js';
import * as transfer from './transfer.js';
import { EVERY } from './limits.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const HOST = process.env.APIARY_HOST || '127.0.0.1';
const PORT = Number(process.env.APIARY_PORT || 7777);
const TOKEN = process.env.APIARY_TOKEN || '';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const EXTRA_HOSTS = new Set((process.env.APIARY_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean));

export function createServer(engine, { updater = null, restart = () => {} } = {}) {
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
    // A bare IP address cannot be used for DNS rebinding, so with a token set it is safe to accept (LAN use).
    const ipHost = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostName) || /^\[[0-9a-fA-F:]+\]$/.test(hostName);
    if (!LOOPBACK.has(hostName) && !EXTRA_HOSTS.has(hostName) && !(TOKEN && ipHost)) return [403, TOKEN ? 'Host not allowed. Use the server\'s IP address, or set APIARY_ALLOWED_HOSTS=<name>' : 'Host not allowed. To open Apiary from another device, start it with: apiary start --lan'];
    if (req.headers.origin) {
      let o; try { o = new URL(req.headers.origin).host; } catch { return [403, 'Bad origin']; }
      if (o !== req.headers.host) return [403, 'Cross-origin request blocked'];
    }
    if (TOKEN) {
      const cookie = /(?:^|;\s*)apiary_token=([^;]+)/.exec(req.headers.cookie || '')?.[1];
      const given = req.headers['x-apiary-token'] || url.searchParams.get('token') || (cookie && decodeURIComponent(cookie));
      if (given !== TOKEN) return [401, 'Token required'];
    }
    const upload = url.pathname === '/api/import' && /^application\/(gzip|x-gzip|octet-stream)/.test(req.headers['content-type'] || '') && req.headers['x-apiary-import'] === '1';
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && !upload && !(req.headers['content-type'] || '').startsWith('application/json')) {
      return [415, 'Use application/json'];
    }
    return null;
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      const bad = guard(req, url);
      if (bad && bad[0] === 401 && req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Apiary</title><body style="font:16px system-ui;max-width:34em;margin:15vh auto;padding:0 1em"><h1>Apiary needs its access link</h1><p>This Apiary is protected. Open the full link printed in the terminal where it was started (it ends with <code>/?token=…</code>), or run <code>apiary token</code> on that machine.</p>');
      }
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
        return json(res, 200, { agents: Object.values(engine.agents), providers: engine.available, limits: engine.limits, defs: Object.values(engine.defs), teams: Object.values(engine.teams), memory: { enabled: engine.memoryEnabled, count: engine.memory.items.length }, approvals: engine.approvals(), approvalsDefault: engine.approvalsDefault, onboardingDone: engine.onboardingDone, defaultProvider: engine.defaultProvider, orgDone: engine.orgDone, meeting: engine.meeting, autoUpdate: engine.autoUpdate, updateCheck: engine.updateCheck, plainEnglish: engine.plainEnglish, vault: { exists: engine.vault.exists, unlocked: engine.vault.unlocked }, update: updater ? updater.status : { state: 'unsupported' }, tasks: engine.tasks.counts(), usageLimits: engine.usage.limits, version: VERSION });
      }
      if (url.pathname === '/api/settings') {
        if (req.method === 'GET') return json(res, 200, { limits: engine.limits, approvalsDefault: engine.approvalsDefault, onboardingDone: engine.onboardingDone, defaultProvider: engine.defaultProvider, orgDone: engine.orgDone, meeting: engine.meeting, autoUpdate: engine.autoUpdate, updateCheck: engine.updateCheck, plainEnglish: engine.plainEnglish });
        if (req.method === 'PUT') {
          const b = await readBody(req);
          const limits = engine.setLimits(b.limits || {});
          if (b.approvalsDefault !== undefined) engine.setApprovalsDefault(b.approvalsDefault);
          if (b.memory !== undefined) engine.setMemoryEnabled(b.memory);
          engine.setSettings(b);
          return json(res, 200, { limits, approvalsDefault: engine.approvalsDefault, onboardingDone: engine.onboardingDone, defaultProvider: engine.defaultProvider, orgDone: engine.orgDone, meeting: engine.meeting, autoUpdate: engine.autoUpdate, updateCheck: engine.updateCheck, plainEnglish: engine.plainEnglish });
        }
      }
      // ----- task board -----
      if (url.pathname === '/api/tasks' && req.method === 'GET') return json(res, 200, { tasks: engine.tasksView(), counts: engine.tasks.counts() });
      if (url.pathname === '/api/tasks' && req.method === 'POST') { const b = await readBody(req); return json(res, 201, engine.tasks.add({ title: b.title, notes: b.notes, status: ['todo', 'backburner'].includes(b.status) ? b.status : 'todo', labels: b.labels, project: b.project || null, assignee: b.assignee ? { id: b.assignee, name: engine.agents[b.assignee]?.name || '' } : null })); }
      if ((r = m(/^\/api\/tasks\/([\w-]+)$/))) {
        if (req.method === 'PUT') { const b = await readBody(req); if (b.assignee !== undefined) b.assignee = b.assignee ? { id: b.assignee, name: engine.agents[b.assignee]?.name || '' } : null; return json(res, 200, engine.tasks.update(r[1], b)); }
        if (req.method === 'DELETE') { engine.tasks.remove(r[1]); return json(res, 200, { ok: true }); }
      }
      // ----- usage -----
      // ----- install the AI tools (Claude Code, Codex) from inside Apiary -----
      if (url.pathname === '/api/tools' && req.method === 'GET') { const have = engine.toolInstaller.installed(); return json(res, 200, { installed: have, anyAI: engine.available.some((p) => p.id !== 'mock'), install: engine.toolInstaller.status }); }
      if (url.pathname === '/api/tools/install' && req.method === 'POST') { const b = await readBody(req); return json(res, 202, engine.toolInstaller.start(Array.isArray(b.tools) ? b.tools : [])); }
      if (url.pathname === '/api/provider-usage' && req.method === 'GET') { const v = engine.limitsView(); if (v.pending.length) engine.refreshLimits().catch(() => {}); return json(res, 200, v); }
      if (url.pathname === '/api/provider-usage/refresh' && req.method === 'POST') { const b = await readBody(req); await engine.refreshLimits(b.id || null, true); return json(res, 200, engine.limitsView()); }
      if (url.pathname === '/api/usage' && req.method === 'GET') return json(res, 200, engine.usage.summary(Number(url.searchParams.get('days')) || 14));
      if (url.pathname === '/api/usage/limits' && req.method === 'PUT') { engine.usage.setLimits((await readBody(req)).limits || {}); return json(res, 200, engine.usage.summary()); }
      // ----- repositories -----
      if (url.pathname === '/api/repos' && req.method === 'GET') return json(res, 200, engine.repos.list);
      if (url.pathname === '/api/repos' && req.method === 'POST') return json(res, 201, await engine.repos.add(await readBody(req)));
      if ((r = m(/^\/api\/repos\/([\w-]+)$/))) {
        if (req.method === 'PUT') return json(res, 200, engine.repos.update(r[1], await readBody(req)));
        if (req.method === 'DELETE') { engine.repos.remove(r[1]); return json(res, 200, { ok: true }); }
      }
      if ((r = m(/^\/api\/repos\/([\w-]+)\/sync$/)) && req.method === 'POST') return json(res, 200, await engine.repos.sync(r[1]));
      // ----- support tickets -----
      if (url.pathname === '/api/tickets' && req.method === 'GET') return json(res, 200, { tickets: engine.tickets.list, handler: engine.ticketHandler({})?.name || null });
      if (url.pathname === '/api/tickets' && req.method === 'POST') {
        const b = await readBody(req), t = engine.tickets.add({ title: b.title, description: b.description, priority: b.priority, assignee: b.assignee || null });
        if (b.run !== false) { const j = await engine.runTicket(t.id).catch((e) => { engine.tickets.comment(t.id, 'Apiary', e.message, 'error'); return null; }); j?.done.catch(() => {}); }
        return json(res, 201, engine.tickets.get(t.id));
      }
      if ((r = m(/^\/api\/tickets\/([\w-]+)$/))) {
        if (req.method === 'PUT') return json(res, 200, engine.tickets.update(r[1], await readBody(req)));
        if (req.method === 'DELETE') { engine.tickets.remove(r[1]); return json(res, 200, { ok: true }); }
      }
      if ((r = m(/^\/api\/tickets\/([\w-]+)\/comment$/)) && req.method === 'POST') {
        const b = await readBody(req); engine.tickets.comment(r[1], 'You', b.text, 'human');
        if (b.run !== false) { const j = await engine.runTicket(r[1], b.text); j.done.catch(() => {}); }
        return json(res, 200, engine.tickets.get(r[1]));
      }
      if ((r = m(/^\/api\/tickets\/([\w-]+)\/status$/)) && req.method === 'POST') return json(res, 200, engine.tickets.setStatus(r[1], (await readBody(req)).status));
      // ----- project stages -----
      if ((r = m(/^\/api\/projects\/([\w-]+)\/stage$/)) && req.method === 'PUT') { const b = await readBody(req); const root = engine.setStage(r[1], b.stage, b.note); return json(res, 200, { stage: engine.stageOf(root), stageLog: root.stageLog || [] }); }
      // ----- export and import: move everything to another computer -----
      if (url.pathname === '/api/export' && req.method === 'GET') {
        const opt = { vault: url.searchParams.get('vault') !== '0', files: url.searchParams.get('files') !== '0', version: VERSION };
        if (url.searchParams.get('info') === '1') return json(res, 200, transfer.exportInfo(engine.store, opt));
        res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="apiary-export-${new Date().toISOString().slice(0, 10)}.tar.gz"` });
        const { done } = transfer.exportTo(engine, res, opt);
        done.catch((e) => { console.error(e.message); res.destroy(); });
        return;
      }
      if (url.pathname === '/api/import' && req.method === 'POST') {
        let pass = ''; try { pass = decodeURIComponent(req.headers['x-vault-passphrase'] || ''); } catch { /* ignore */ }
        const out = await transfer.importFrom(engine, req, { passphrase: pass });
        json(res, 200, { ...out, restarting: true });
        res.on('finish', () => setTimeout(restart, 600));
        return;
      }
      // ----- project plans -----
      if ((r = m(/^\/api\/projects\/([\w-]+)\/plan$/))) {
        const root = engine.agents[r[1]]; if (!root) throw Object.assign(new Error('No such project'), { status: 404 });
        if (req.method === 'GET') return json(res, 200, { plan: root.plan || null, stats: engine.planStats(root.plan) });
        if (req.method === 'PUT') return json(res, 200, { plan: engine.editPlan(r[1], await readBody(req)) });
        if (req.method === 'DELETE') { engine.clearPlan(r[1]); return json(res, 200, { ok: true }); }
      }
      if ((r = m(/^\/api\/projects\/([\w-]+)\/plan\/ask$/)) && req.method === 'POST') return json(res, 202, engine.askPlan(r[1], (await readBody(req)).text));
      // ----- model advice -----
      if ((r = m(/^\/api\/agents\/([\w-]+)\/model-advice$/)) && req.method === 'GET') return json(res, 200, engine.adviseModel(r[1]));
      if ((r = m(/^\/api\/agents\/([\w-]+)\/model$/)) && req.method === 'PUT') return json(res, 200, engine.setModel(r[1], (await readBody(req)).model));
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
      if ((r = m(/^\/api\/connections\/(\w+)\/models$/)) && req.method === 'GET') return json(res, 200, await engine.connections.models(r[1]));
      if (url.pathname === '/api/service') {
        if (req.method === 'GET') return json(res, 200, await service.status());
        if (req.method === 'POST') {
          const b = await readBody(req);
          const lan = HOST !== '127.0.0.1' && HOST !== 'localhost';
          const st = b.enabled ? await service.install({ lan }) : await service.uninstall();
          json(res, 200, st);
          if (b.enabled && b.startNow && process.env.APIARY_NO_EXIT !== '1') {
            // hand over to the service: restart it shortly, after this process has released the port
            setTimeout(() => { engine.store.flush(); engine.memory.flush(); spawn('sh', ['-c', 'sleep 1; systemctl --user restart apiary'], { detached: true, stdio: 'ignore' }).unref(); process.exit(0); }, 400);
          }
          return;
        }
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
      if (url.pathname === '/api/teams' || (r = m(/^\/api\/teams\/([\w-]+)$/))) {
        if (!r && req.method === 'GET') return json(res, 200, Object.values(engine.teams));
        if (!r && req.method === 'POST') return json(res, 201, engine.saveTeam(await readBody(req)));
        if (r && req.method === 'PUT') { if (!engine.teams[r[1]]) throw Object.assign(new Error('No such team'), { status: 404 }); return json(res, 200, engine.saveTeam(await readBody(req), r[1])); }
        if (r && req.method === 'DELETE') { engine.removeTeam(r[1]); return json(res, 200, { ok: true }); }
      }
      if (url.pathname === '/api/memory' && req.method === 'GET') {
        const q = url.searchParams, mem = engine.memory;
        const items = mem.search(q.get('q') || '', { agent: q.get('agent') || undefined, project: q.get('project') || undefined, kind: q.get('kind') || undefined, limit: 300 });
        const keys = [...new Set(mem.items.filter((i) => i.agent).map((i) => i.agent))].sort();
        return json(res, 200, { enabled: engine.memoryEnabled, total: mem.items.length, items, agents: keys });
      }
      if (url.pathname === '/api/memory' && req.method === 'POST') {
        const b = await readBody(req);
        if (!String(b.text || '').trim()) throw Object.assign(new Error('Write what should be remembered'), { status: 400 });
        const scope = ['global', 'project', 'agent'].includes(b.scope) ? b.scope : 'global';
        const ref = b.agentId ? engine.agents[b.agentId] : null;
        if (scope !== 'global' && !ref) throw Object.assign(new Error('Pick an agent or project for this note'), { status: 400 });
        return json(res, 201, engine.memory.add({ kind: 'note', text: b.text, who: 'You', agent: scope === 'agent' ? engine._mkey(ref) : null, project: scope === 'project' ? engine._pkey(ref) : null }));
      }
      if ((r = m(/^\/api\/memory\/preview\/([\w-]+)$/)) && req.method === 'GET') {
        if (!engine.agents[r[1]]) throw Object.assign(new Error('No such agent'), { status: 404 });
        return json(res, 200, { text: engine.memoryPreview(r[1], url.searchParams.get('q') || '') });
      }
      if ((r = m(/^\/api\/memory\/([\w-]+)$/)) && req.method === 'DELETE') {
        if (!engine.memory.remove(r[1])) throw Object.assign(new Error('No such memory'), { status: 404 });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/chat') return json(res, 200, await engine.general());
      if ((r = m(/^\/api\/projects\/([\w-]+)\/org$/)) && req.method === 'GET') return json(res, 200, engine.org(r[1]));
      if ((r = m(/^\/api\/agents\/([\w-]+)\/files$/)) && req.method === 'GET') return json(res, 200, engine.files(r[1], url.searchParams.get('path') || ''));
      if ((r = m(/^\/api\/agents\/([\w-]+)\/file$/))) {
        const rel = url.searchParams.get('path') || '';
        if (req.method === 'GET') {
          const f = engine.readFile(r[1], rel);
          const buf = readFileSync(f.full);
          const binary = buf.subarray(0, 8000).includes(0);
          if (url.searchParams.get('raw')) {
            res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${f.name.replace(/[^\w.-]/g, '_')}"`, 'x-content-type-options': 'nosniff' });
            return res.end(buf);
          }
          if (binary || f.size > 1_000_000) return json(res, 200, { name: f.name, size: f.size, binary: true });
          return json(res, 200, { name: f.name, size: f.size, content: buf.toString('utf8') });
        }
        if (req.method === 'PUT') { const b = await readBody(req); return json(res, 200, engine.writeFile(r[1], rel, b.content)); }
        if (req.method === 'DELETE') { engine.deleteFile(r[1], rel); return json(res, 200, { ok: true }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/interview') return json(res, 200, await engine.interview(await readBody(req)));
      if (req.method === 'POST' && url.pathname === '/api/org') return json(res, 201, await engine.createOrg(await readBody(req)));
      if ((r = m(/^\/api\/agents\/([\w-]+)\/profile$/))) {
        if (req.method === 'GET') return json(res, 200, engine.profile(r[1]));
        if (req.method === 'PUT') return json(res, 200, engine.setProfile(r[1], await readBody(req)));
      }
      if (req.method === 'GET' && url.pathname === '/api/meetings') {
        const names = { org: 'Organisation' }; for (const a of Object.values(engine.agents)) if (!a.parentId && a.kind !== 'general') names[a.id] = a.name;
        return json(res, 200, orgfiles.listMinutes().map((x) => ({ ...x, scopeName: names[x.scope] || x.scope })).slice(0, 100));
      }
      if ((r = m(/^\/api\/meetings\/([\w-]+)\/(\d{4}-\d{2}-\d{2})$/)) && req.method === 'GET') { let text; try { text = orgfiles.readMinutes(r[1], r[2]); } catch { throw Object.assign(new Error('No such meeting'), { status: 404 }); } return json(res, 200, { text }); }
      if (req.method === 'POST' && url.pathname === '/api/meetings/run') {
        const b = await readBody(req);
        const root = b.projectId ? engine.agents[b.projectId] : await engine.general();
        if (!root || root.parentId) throw Object.assign(new Error('No such project'), { status: 404 });
        if (engine._roster(root).length < 1) throw Object.assign(new Error('A meeting needs at least two people on the team'), { status: 409 });
        engine.runMeeting(root.id).catch((e) => engine._log(root, `! team meeting failed: ${e.message}`));
        return json(res, 202, { started: true });
      }
      if (url.pathname === '/api/vault' && req.method === 'GET') return json(res, 200, { exists: engine.vault.exists, unlocked: engine.vault.unlocked, secrets: engine.vault.list(), eligible: engine.eligibleAgents() });
      if (url.pathname.startsWith('/api/vault/')) {
        const vb = req.method === 'GET' ? {} : await readBody(req), v = engine.vault;
        if (req.method === 'POST' && url.pathname === '/api/vault/init') { v.init(vb.passphrase); return json(res, 201, { ok: true }); }
        if (req.method === 'POST' && url.pathname === '/api/vault/unlock') { await v.unlock(vb.passphrase); return json(res, 200, { ok: true }); }
        if (req.method === 'POST' && url.pathname === '/api/vault/lock') { v.lock(); return json(res, 200, { ok: true }); }
        if (req.method === 'POST' && url.pathname === '/api/vault/secrets') { const it = v.add(vb.name, vb.value, vb.note, vb.username); return json(res, 201, vb.assigned ? v.update(it.id, { assigned: vb.assigned }) : it); }
        if ((r = m(/^\/api\/vault\/secrets\/([\w-]+)$/))) {
          if (req.method === 'PUT') return json(res, 200, v.update(r[1], vb));
          if (req.method === 'DELETE') { v.remove(r[1]); return json(res, 200, { ok: true }); }
        }
      }
      if (url.pathname === '/api/update' && req.method === 'GET') return json(res, 200, updater ? updater.status : { state: 'unsupported', error: 'Updates are not available here.' });
      if (url.pathname === '/api/update/check' && req.method === 'POST') { if (!updater) throw Object.assign(new Error('Updates are not available here.'), { status: 409 }); engine.markUpdateChecked(); return json(res, 200, await updater.check()); }
      if (url.pathname === '/api/update/install' && req.method === 'POST') {
        if (!updater) throw Object.assign(new Error('Updates are not available here.'), { status: 409 });
        const ub = await readBody(req);
        const busy = Object.values(engine.agents).filter((a) => a.status === 'working' || a.status === 'waiting').length;
        if (busy && !ub.force) return json(res, 409, { error: `${busy} agent${busy > 1 ? 's are' : ' is'} working right now. Installing restarts Apiary and interrupts them.`, busy });
        if (updater.s.state === 'installing') return json(res, 202, { started: true });
        if (updater.s.state !== 'ready') throw Object.assign(new Error('There is no downloaded update to install. Check for updates first.'), { status: 409 });
        // The work takes a while and ends in a restart, so it runs in the background and the page watches /api/update.
        updater.install().then(() => { updater.markRestarting(); setTimeout(restart, 1800); }).catch((e) => console.error('Update failed:', e.message));
        return json(res, 202, { started: true });
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
      json(res, e.status || 500, { error: e.message, ...(e.needsPassphrase ? { needsPassphrase: true } : {}) });
    }
  });
}

export function main(links = []) {
  if (!LOOPBACK.has(HOST) && !TOKEN) {
    console.error('Refusing to listen on a non-local address without APIARY_TOKEN set.');
    process.exit(1);
  }
  // the AI tools are installed for this user in ~/.local/bin; make sure a service finds them too
  { const bin = path.join(os.homedir(), '.local', 'bin'), parts = (process.env.PATH || '').split(path.delimiter); if (!parts.includes(bin)) process.env.PATH = [...parts, bin].filter(Boolean).join(path.delimiter); }
  const store = new Store();
  const engine = new Engine(store);
  if (!engine.available.length) console.warn('No AI connected yet. Open the web UI > Connections, or install the `claude` / `codex` CLI.');
  const updater = new Updater({ dir: fileURLToPath(new URL('..', import.meta.url)), current: VERSION, authArgs: () => authArgs(engine.connections.get('github')) });
  const restart = () => {
    store.flush(); engine.memory.flush();
    // INVOCATION_ID is set by systemd for every service it starts
    if (process.env.INVOCATION_ID) {
      // Same as running "systemctl --user restart apiary" by hand: the job belongs to systemd, so it still
      // happens after this process is stopped. (A helper started from in here would be killed with the service.)
      const r = spawnSync('systemctl', ['--user', 'restart', '--no-block', 'apiary'], { stdio: 'ignore' });
      console.log(r.status === 0 ? 'Restarting through systemd…' : 'systemctl failed, exiting so systemd starts Apiary again…');
      if (r.status === 0) setTimeout(() => process.exit(75), 15000);   // systemd normally stops us long before this
      else setTimeout(() => process.exit(75), 300);
      return;
    }
    spawn('sh', ['-c', 'sleep 1; exec "$@"', 'sh', process.execPath, ...process.argv.slice(1)], { detached: true, stdio: 'ignore', env: process.env, cwd: process.cwd() }).unref();
    setTimeout(() => process.exit(0), 200);
  };
  const server = createServer(engine, { updater, restart });
  setInterval(() => engine.tickMeetings().catch(() => {}), 60000).unref();
  setTimeout(() => engine.refreshLimits().catch(() => {}), 8000).unref();
  setInterval(() => engine.refreshLimits().catch(() => {}), EVERY).unref();   // once an hour
  if (process.env.APIARY_NO_UPDATE_CHECK !== '1') {
    // the schedule is the person's choice (daily, weekly, monthly or manual); this only asks whether a check is due
    const auto = () => { if (engine.updateDue()) { engine.markUpdateChecked(); updater.check().catch(() => {}); } };
    setTimeout(auto, 20000).unref(); setInterval(auto, 30 * 60000).unref();
  }
  server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Set APIARY_PORT to another port.` : e.message); process.exit(1); });
  server.listen(PORT, HOST, () => {
    console.log(`Apiary ${VERSION} running at http://${HOST}:${PORT}${TOKEN ? `/?token=${TOKEN}` : ''}`);
    if (links.length) { console.log('\nOpen it from another device on your network with:'); for (const l of links) console.log('  ' + l); console.log('Keep these links private: anyone who has one can run commands as you.\n'); }
    console.log('Connected:', engine.available.map((p) => `${p.id} (${p.method})`).join(', ') || 'nothing yet');
  });
  const bye = () => { store.flush(); engine.memory.flush(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
