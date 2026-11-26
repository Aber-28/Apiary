#!/usr/bin/env node
// HTTP + SSE server. Binds to localhost by default because agents can run commands on this machine.
import { createHash, timingSafeEqual } from 'node:crypto';
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
import { Store, HOME } from './store.js';
import { Auth, COOKIE, maxAge } from './auth.js';
import { Engine } from './engine.js';
import { Updater } from './updater.js';
import { search as globalSearch } from './search.js';
import { KINDS, ACTIONS } from './policy.js';
import { authArgs } from './github.js';
import * as orgfiles from './orgfiles.js';
import * as transfer from './transfer.js';
import { TYPES } from './infra.js';
import { ResetGate, factoryReset } from './reset.js';
import { snapshot as systemSnapshot } from './system.js';
import { createReadStream } from 'node:fs';
import { EVERY } from './limits.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const HOST = process.env.APIARY_HOST || '127.0.0.1';
const PORT = Number(process.env.APIARY_PORT || 7777);
const TOKEN = process.env.APIARY_TOKEN || '';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const EXTRA_HOSTS = new Set((process.env.APIARY_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean));

export function createServer(engine, { updater = null, restart = () => {}, auth = new Auth(path.join(HOME, 'auth.json')) } = {}) {
  engine.backups.version = VERSION;
  const clients = new Set();
  const resetGate = new ResetGate();
  engine.on('event', (ev) => {
    const data = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of clients) res.write(data);
  });
  setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000).unref();

  // Sent on every answer: stops framing, content sniffing, outside scripts and referrer leaks.
  const SECURITY_HEADERS = {
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req, max = 1e6) => new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > max) reject(Object.assign(new Error('Body too large'), { status: 413 })); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(Object.assign(new Error('Bad JSON'), { status: 400 })); } });
  });

  // Compare in constant time so the token cannot be guessed from response timing.
  const sameToken = (given) => {
    if (typeof given !== 'string') return false;
    const a = createHash('sha256').update(given).digest(), b = createHash('sha256').update(TOKEN).digest();
    return timingSafeEqual(a, b);
  };

  // what can be reached before signing in
  const OPEN = new Set(['/login', '/login.js', '/login.css', '/theme.js', '/style.css', '/themes.css', '/api/login']);
  const secure = (req) => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  const ipOf = (req) => req.socket.remoteAddress || '?';

  function guard(req, url) {
    // Stops other websites (CSRF) and DNS-rebinding from driving a local agent runner.
    const hostName = (req.headers.host || '').replace(/:\d+$/, '');
    // A bare IP address cannot be used for DNS rebinding, so with a token set it is safe to accept (LAN use).
    const ipHost = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostName) || /^\[[0-9a-fA-F:]+\]$/.test(hostName);
    if (!LOOPBACK.has(hostName) && !EXTRA_HOSTS.has(hostName) && !((TOKEN || auth.exists) && ipHost)) return [403, (TOKEN || auth.exists) ? 'Host not allowed. Use the server\'s IP address, or set APIARY_ALLOWED_HOSTS=<name>' : 'Host not allowed. To open Apiary from another device, start it with: apiary start --lan'];
    if (req.headers.origin) {
      let o; try { o = new URL(req.headers.origin).host; } catch { return [403, 'Bad origin']; }
      if (o !== req.headers.host) return [403, 'Cross-origin request blocked'];
    }
    if (TOKEN || auth.exists) {
      const cookies = req.headers.cookie || '';
      const pick = (n) => { const v = new RegExp(`(?:^|;\\s*)${n}=([^;]+)`).exec(cookies)?.[1]; try { return v && decodeURIComponent(v); } catch { return ''; } };
      const given = req.headers['x-apiary-token'] || url.searchParams.get('token') || pick('apiary_token');
      const okToken = !!TOKEN && sameToken(given);
      const okSession = auth.exists && auth.validCookie(pick(COOKIE));
      if (!okToken && !okSession && !OPEN.has(url.pathname)) return [401, auth.exists ? 'Sign in required' : 'Token required'];
    }
    const upload = url.pathname === '/api/import' && /^application\/(gzip|x-gzip|octet-stream)/.test(req.headers['content-type'] || '') && req.headers['x-apiary-import'] === '1';
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && !upload && !(req.headers['content-type'] || '').startsWith('application/json')) {
      return [415, 'Use application/json'];
    }
    return null;
  }

  // Updates: an install waits, without starting anything new, until the work already running has finished.
  const startUpdate = () => {
    if (!updater) return;
    engine.holdNewWork(false); updater.s.queued = false; updater.s.busy = 0;
    updater.install().then(() => { updater.markRestarting(); setTimeout(restart, 1800); }).catch((e) => console.error('Update failed:', e.message));
  };
  const runQueuedUpdate = () => {
    if (!updater || !updater.s.queued || updater.s.state === 'installing') return;
    const b = engine.busy(); updater.s.busy = b.total;
    if (!b.total) startUpdate();
  };
  if (updater) {
    engine.on('event', runQueuedUpdate);
    setInterval(runQueuedUpdate, 5000).unref();
  }
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      // The approval bridge that a safe-mode Claude run starts. Only this machine may call it, and only with that run's one-time token.
      if (url.pathname === '/api/approval-bridge' && req.method === 'POST') {
        const from = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        const auth = req.headers.authorization || '';
        if (!(from === '127.0.0.1' || from === '::1') || !auth.startsWith('Bearer ')) return json(res, 403, { error: 'Not allowed' });
        return json(res, 200, await engine.requestCommandApproval(auth.slice(7), await readBody(req)));
      }
      const bad = guard(req, url);
      if (bad && bad[0] === 401 && auth.exists && req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
        res.writeHead(302, { location: '/login', 'cache-control': 'no-store' });
        return res.end();
      }
      if (bad && bad[0] === 401 && req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Apiary</title><body style="font:16px system-ui;max-width:34em;margin:15vh auto;padding:0 1em"><h1>Apiary needs its access link</h1><p>This Apiary is protected. Open the full link printed in the terminal where it was started (it ends with <code>/?token=…</code>), or run <code>apiary token</code> on that machine.</p>');
      }
      if (bad) return json(res, bad[0], { error: bad[1] });
      if (url.searchParams.get('token') && TOKEN && req.method === 'GET' && url.pathname === '/') {
        // Remember the token in a cookie, then drop it from the address bar (history, screenshots, shoulder-surfing).
        res.writeHead(302, { location: '/', 'cache-control': 'no-store', 'set-cookie': `apiary_token=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${req.socket.encrypted ? '; Secure' : ''}` });
        return res.end();
      }
      const m = (re) => re.exec(url.pathname);
      let r;

      // ----- sign-in -----
      if (req.method === 'GET' && url.pathname === '/login') { url.pathname = '/login.html'; }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        if (!auth.exists) return json(res, 400, { error: 'No account has been created yet.' });
        const b = await readBody(req);
        let value;
        try { value = await auth.login(b.username, b.password, ipOf(req)); } catch (e) { engine.audit.add('signin', { actor: String(b.username || '?').slice(0, 40), action: 'failed sign-in', detail: ipOf(req) }); throw e; }
        engine.audit.add('signin', { actor: auth.username, action: 'signed in', detail: ipOf(req) });
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': `${COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}` });
        return res.end(JSON.stringify({ ok: true }));
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        engine.audit.add('signin', { actor: auth.username || 'You', action: 'signed out', detail: ipOf(req) });
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure(req) ? '; Secure' : ''}` });
        return res.end(JSON.stringify({ ok: true }));
      }
      if (url.pathname === '/api/account') {
        const info = () => ({ exists: auth.exists, username: auth.username, secure: secure(req) || LOOPBACK.has((req.headers.host || '').replace(/:\d+$/, '')) });
        if (req.method === 'GET') return json(res, 200, info());
        const b = await readBody(req);
        // changing or removing needs the current password, so a borrowed open window is not enough
        if (auth.exists && !(await auth.verify(b.current))) { await new Promise((r) => setTimeout(r, 800)); return json(res, 403, { error: 'The current password is not right.' }); }
        if (req.method === 'POST') {
          await auth.set(b.username || auth.username, b.password);
          const value = auth.cookie();
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': `${COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}` });
          return res.end(JSON.stringify(info()));
        }
        if (req.method === 'DELETE') { await auth.remove(); return json(res, 200, info()); }
      }

      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
        const file = path.resolve(PUBLIC, rel);
        if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'Forbidden' });
        let body; try { body = readFileSync(file); } catch { return json(res, 404, { error: 'Not found' }); }
        const headers = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' };
        // Stamp the files with the version, so a proxy or browser that keeps old copies fetches the new ones after an update.
        const ext = path.extname(file);
        if (ext === '.html') body = Buffer.from(body.toString('utf8').replace(/(href|src)="\/(style|themes|theme|app|login)\.(css|js)"/g, `$1="/$2.$3?v=${VERSION}"`));
        else if (path.basename(file) === 'app.js') body = Buffer.from(body.toString('utf8').replace("from './map.js'", `from './map.js?v=${VERSION}'`));
        res.writeHead(200, headers);
        return res.end(body);
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return json(res, 200, { agents: Object.values(engine.agents), providers: engine.available, limits: engine.limits, defs: Object.values(engine.defs), teams: Object.values(engine.teams), memory: { enabled: engine.memoryEnabled, count: engine.memory.items.length }, account: { exists: auth.exists, username: auth.username }, approvals: engine.approvals(), approvalsDefault: engine.approvalsDefault, reviewWork: engine.reviewWork, onboardingDone: engine.onboardingDone, defaultProvider: engine.defaultProvider, orgDone: engine.orgDone, meeting: engine.meeting, autoUpdate: engine.autoUpdate, updateCheck: engine.updateCheck, plainEnglish: engine.plainEnglish, imageKeepDays: engine.imageKeepDays, vault: { exists: engine.vault.exists, unlocked: engine.vault.unlocked, auto: engine.vault.auto }, update: updater ? updater.status : { state: 'unsupported' }, tasks: engine.tasks.counts(), health: engine.health.summary, runbookDrafts: engine.runbooks.draftCount, usageLimits: engine.usage.limits, version: VERSION });
      }
      if (url.pathname === '/api/settings') {
        if (req.method === 'GET') return json(res, 200, { limits: engine.limits, reviewWork: engine.reviewWork, approvalsDefault: engine.approvalsDefault, onboardingDone: engine.onboardingDone, defaultProvider: engine.defaultProvider, orgDone: engine.orgDone, meeting: engine.meeting, autoUpdate: engine.autoUpdate, updateCheck: engine.updateCheck, plainEnglish: engine.plainEnglish, imageKeepDays: engine.imageKeepDays });
        if (req.method === 'PUT') {
          const b = await readBody(req);
          const limits = engine.setLimits(b.limits || {});
          if (b.approvalsDefault !== undefined) engine.setApprovalsDefault(b.approvalsDefault);
          if (b.reviewWork !== undefined) engine.setReviewWork(b.reviewWork);
          if (b.memory !== undefined) engine.setMemoryEnabled(b.memory);
          if (b.imageKeepDays !== undefined) engine.setImageKeepDays(b.imageKeepDays);
          engine.setSettings(b);
          return json(res, 200, { limits, approvalsDefault: engine.approvalsDefault, onboardingDone: engine.onboardingDone, defaultProvider: engine.defaultProvider, orgDone: engine.orgDone, meeting: engine.meeting, autoUpdate: engine.autoUpdate, updateCheck: engine.updateCheck, plainEnglish: engine.plainEnglish, imageKeepDays: engine.imageKeepDays });
        }
      }
      // ----- task board -----
      if (url.pathname === '/api/library' && req.method === 'GET') return json(res, 200, engine.library());
      { // a Library icon is fetched live from the public internet the first time, then the kept copy is used for good
        const ic = /^\/api\/library\/icon\/([a-z0-9]+)$/.exec(url.pathname);
        if (ic && req.method === 'GET') {
          const svg = await engine.icon(ic[1]);
          if (!svg) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return; }
          res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'private, max-age=86400', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'x-content-type-options': 'nosniff' }); res.end(svg); return;
        }
      }
      { const la = /^\/api\/library\/([a-z0-9]+)\/add$/.exec(url.pathname); if (la && req.method === 'POST') return json(res, 201, engine.addFromLibrary(la[1], await readBody(req))); }
      if (url.pathname === '/api/images' && req.method === 'POST') return json(res, 201, engine.images.save(await readBody(req, 12e6)));
      if (req.method === 'GET' && (r = m(/^\/api\/images\/(img-[a-f0-9]{16})$/))) {
        const im = engine.images.read(r[1]); if (!im) throw Object.assign(new Error('No such picture'), { status: 404 });
        res.writeHead(200, { 'content-type': im.mime, 'content-length': im.buf.length, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", 'cache-control': 'private, max-age=86400' });
        return res.end(im.buf);
      }
      if (url.pathname === '/api/refs' && req.method === 'GET') return json(res, 200, { refs: engine.refs() });
      if (url.pathname === '/api/tasks' && req.method === 'GET') return json(res, 200, { tasks: engine.tasksView(), counts: engine.tasks.counts() });
      if (url.pathname === '/api/tasks' && req.method === 'POST') return json(res, 201, engine.createTask(await readBody(req)));
      if (req.method === 'GET' && url.pathname === '/api/tasks/agents') return json(res, 200, engine.assignable());
      if (req.method === 'POST' && (r = m(/^\/api\/tasks\/([\w-]+)\/start$/))) return json(res, 202, engine.startTask(r[1]));
      if ((r = m(/^\/api\/tasks\/([\w-]+)$/))) {
        if (req.method === 'GET') { const t = engine.tasksView().find((x) => x.id === r[1]); if (!t) throw Object.assign(new Error('No such task'), { status: 404 }); return json(res, 200, t); }
        if (req.method === 'PUT') return json(res, 200, engine.updateTask(r[1], await readBody(req)));
        if (req.method === 'DELETE') { engine.tasks.remove(r[1]); return json(res, 200, { ok: true }); }
      }
      // ----- usage -----
      // ----- install the AI tools (Claude Code, Codex) from inside Apiary -----
      if (url.pathname === '/api/tools' && req.method === 'GET') { const have = engine.toolInstaller.installed(); return json(res, 200, { installed: have, anyAI: engine.available.some((p) => p.id !== 'mock'), install: engine.toolInstaller.status }); }
      if (url.pathname === '/api/tools/install' && req.method === 'POST') { const b = await readBody(req); return json(res, 202, engine.toolInstaller.start(Array.isArray(b.tools) ? b.tools : [])); }
      if (url.pathname === '/api/provider-usage' && req.method === 'GET') { const v = engine.limitsView(); if (v.pending.length) engine.refreshLimits().catch(() => {}); return json(res, 200, v); }
      if (url.pathname === '/api/provider-usage/refresh' && req.method === 'POST') { const b = await readBody(req); await engine.refreshLimits(b.id || null, true); return json(res, 200, engine.limitsView()); }
      if (url.pathname === '/api/dashboard' && req.method === 'GET') return json(res, 200, engine.dashboard());
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
      if ((r = m(/^\/api\/projects\/([\w-]+)\/owner$/)) && req.method === 'PUT') { const b = await readBody(req); return json(res, 200, { ownerId: engine.setOwner(r[1], b.agent).ownerId }); }
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
      // ----- factory reset: three checks, enforced here and not just in the page -----
      if (url.pathname === '/api/reset') {
        if (req.method === 'POST') {
          const b = await readBody(req);
          if (b.action === 'start') return json(res, 200, resetGate.start());
          if (b.action === 'cancel') { resetGate.cancel(); return json(res, 200, { ok: true }); }
          const out = resetGate.answer(b.id, b.answer);
          if (!out.done) return json(res, 200, out);
          const r = factoryReset(engine, { keepAccount: b.removeAccount !== true });
          if (b.removeAccount === true) auth.data = null;
          json(res, 200, { done: true, ...r, restarting: true });
          res.on('finish', () => setTimeout(restart, 600));
          return;
        }
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
      const aiRoute = /^\/api\/ai-login\/(claude|codex)(?:\/(code))?$/.exec(url.pathname);
      if (aiRoute) {
        const [, prov, sub] = aiRoute;
        if (sub === 'code' && req.method === 'POST') return json(res, 200, engine.aiLogin.submit(prov, (await readBody(req)).code));
        if (!sub && req.method === 'GET') return json(res, 200, engine.aiLogin.status(prov));
        if (!sub && req.method === 'POST') return json(res, 202, engine.aiLogin.start(prov));
        if (!sub && req.method === 'DELETE') return json(res, 200, engine.aiLogin.cancel(prov));
      }
      if (url.pathname === '/api/github/login') {
        if (req.method === 'GET') return json(res, 200, engine.ghLogin.status);
        if (req.method === 'POST') { const st = engine.ghLogin.start(); engine.connections.update('github', { method: 'cli' }); return json(res, 202, st); }
        if (req.method === 'DELETE') return json(res, 200, engine.ghLogin.cancel());
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
      // ----- machine usage (top bar) -----
      if (url.pathname === '/api/system' && req.method === 'GET') return json(res, 200, systemSnapshot(path.dirname(engine.store.file)));
      // ----- automatic backups -----
      if (url.pathname === '/api/runbooks' && req.method === 'GET') return json(res, 200, { items: engine.runbooks.list(), drafts: engine.runbooks.draftCount });
      if (url.pathname === '/api/runbooks' && req.method === 'POST') return json(res, 201, engine.runbooks.create(await readBody(req)));
      if ((r = m(/^\/api\/runbooks\/([\w-]+)$/))) {
        if (req.method === 'PUT') return json(res, 200, engine.runbooks.update(r[1], await readBody(req)));
        if (req.method === 'DELETE') { engine.runbooks.remove(r[1]); return json(res, 200, { ok: true }); }
      }
      if (url.pathname === '/api/policy' && req.method === 'GET') return json(res, 200, { rules: engine.policy.view(), kinds: KINDS, actions: ACTIONS });
      if (url.pathname === '/api/policy' && req.method === 'POST') return json(res, 201, engine.policy.add(await readBody(req)));
      if ((r = m(/^\/api\/policy\/([\w-]+)$/)) && req.method === 'DELETE') { engine.policy.remove(r[1]); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/reports' && req.method === 'GET') return json(res, 200, { config: engine.reports.config, list: engine.reports.list() });
      if (url.pathname === '/api/reports' && req.method === 'PUT') return json(res, 200, { config: engine.reports.setConfig(await readBody(req)), list: engine.reports.list() });
      if (url.pathname === '/api/reports/run' && req.method === 'POST') { await readBody(req); return json(res, 201, await engine.reports.generate({})); }
      if ((r = m(/^\/api\/reports\/([\w-]+)$/)) && req.method === 'GET') return json(res, 200, engine.reports.get(r[1]));
      if (url.pathname === '/api/search' && req.method === 'GET') return json(res, 200, globalSearch(engine, url.searchParams.get('q') || ''));
      if (url.pathname === '/api/templates' && req.method === 'GET') return json(res, 200, engine.templates.list());
      if (url.pathname === '/api/templates' && req.method === 'POST') { const b = await readBody(req); return json(res, 201, engine.templates.save(b.projectId, b)); }
      if ((r = m(/^\/api\/templates\/([\w-]+)(?:\/(start))?$/))) {
        if (req.method === 'PUT' && !r[2]) return json(res, 200, engine.templates.update(r[1], await readBody(req)));
        if (req.method === 'DELETE' && !r[2]) { engine.templates.remove(r[1]); return json(res, 200, { ok: true }); }
        if (req.method === 'POST' && r[2]) { const b = await readBody(req); if (!b.provider) throw Object.assign(new Error('provider is required'), { status: 400 }); return json(res, 201, await engine.templates.start(r[1], b)); }
      }
      if (url.pathname === '/api/telegram' && req.method === 'GET') return json(res, 200, { config: engine.telegram.config, status: engine.telegram.status });
      if (url.pathname === '/api/telegram' && req.method === 'PUT') { const status = engine.telegram.setConfig(await readBody(req)); engine.audit.add('system', { actor: 'You', action: 'changed Telegram alert settings' }); return json(res, 200, { config: engine.telegram.config, status }); }
      if (url.pathname === '/api/telegram/test' && req.method === 'POST') { await readBody(req); return json(res, 200, await engine.telegram.test()); }
      if (url.pathname === '/api/telegram/link' && req.method === 'POST') { await readBody(req); return json(res, 200, engine.telegram.startLink()); }
      if (url.pathname === '/api/telegram/unlink' && req.method === 'POST') { await readBody(req); return json(res, 200, engine.telegram.unlink()); }
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ...engine.health.state, count: engine.health.count });
      if (url.pathname === '/api/health/check' && req.method === 'POST') { await readBody(req); const st = await engine.health.run(); return json(res, 200, { ...st, count: engine.health.count }); }
      if (url.pathname === '/api/audit' && req.method === 'GET') { const q = Object.fromEntries(url.searchParams); return json(res, 200, engine.audit.search({ ...q, from: +q.from || 0, to: +q.to || 0 })); }
      if (url.pathname === '/api/backups' && req.method === 'GET') return json(res, 200, { config: engine.backups.config, status: engine.backups.status, files: engine.backups.list(), vaultExists: engine.vault.exists });
      if (url.pathname === '/api/backups' && req.method === 'PUT') { const config = engine.backups.setConfig(await readBody(req)); return json(res, 200, { config, status: engine.backups.status, files: engine.backups.list() }); }
      if (url.pathname === '/api/backups/run' && req.method === 'POST') { await readBody(req); const r = await engine.backups.run('manual'); return json(res, 200, { ...r, files: engine.backups.list(), status: engine.backups.status }); }
      if (req.method === 'GET' && (r = m(/^\/api\/backups\/(apiary-backup-[\d-]+\.tgz)$/))) {
        const f = engine.backups.file(r[1]);
        res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${r[1]}"`, 'cache-control': 'no-store' });
        return createReadStream(f).pipe(res);
      }
      // ----- infrastructure map -----
      { const tm = /^\/api\/infra\/([\w-]+)\/troubleshoot$/.exec(url.pathname); if (tm && req.method === 'POST') return json(res, 202, await engine.troubleshoot(tm[1])); }
      if (url.pathname === '/api/infra' && req.method === 'GET') return json(res, 200, { items: engine.infra.view(), types: TYPES });
      if (url.pathname === '/api/infra' && req.method === 'POST') { const it = engine.infra.add(await readBody(req)); engine.audit.add('infra', { actor: 'You', action: 'added a device', detail: it.name || it.id }); engine.emit('event', { type: 'infra' }); return json(res, 201, it); }
      if ((r = m(/^\/api\/infra\/([\w-]+)(?:\/(test|confirm|answer|discover))?$/))) {
        const [, id, act] = r;
        if (req.method === 'PUT' && !act) { const it = engine.infra.update(id, await readBody(req)); engine.emit('event', { type: 'infra' }); return json(res, 200, it); }
        if (req.method === 'DELETE' && !act) { engine.audit.add('infra', { actor: 'You', action: 'removed a device', detail: id }); engine.infra.remove(id); engine.emit('event', { type: 'infra' }); return json(res, 200, { ok: true }); }
        if (req.method === 'POST' && act === 'test') { const it = await engine.testDevice(id); engine.audit.add('infra', { actor: 'You', action: 'tested a connection', detail: `${it.name || id}: ${it.status || ''}` }); engine.emit('event', { type: 'infra' }); return json(res, 200, it); }
        if (req.method === 'POST' && act === 'discover') { await readBody(req); return json(res, 200, await engine.discover(id)); }
        if (req.method === 'POST' && act === 'confirm') { const b = await readBody(req); engine.infra.confirm(id, b.ok !== false); engine.emit('event', { type: 'infra' }); return json(res, 200, { ok: true }); }
        if (req.method === 'POST' && act === 'answer') { const it = engine.infra.answer(id, (await readBody(req)).text); engine.emit('event', { type: 'infra' }); return json(res, 200, it); }
      }
      if (url.pathname === '/api/vault' && req.method === 'GET') return json(res, 200, { exists: engine.vault.exists, unlocked: engine.vault.unlocked, auto: engine.vault.auto, autoProblem: engine.vault.autoProblem, secrets: engine.vault.list(), eligible: engine.eligibleAgents() });
      if (url.pathname.startsWith('/api/vault/')) {
        const vb = req.method === 'GET' ? {} : await readBody(req), v = engine.vault;
        if (req.method === 'POST' && url.pathname === '/api/vault/init') { v.init(vb.passphrase); return json(res, 201, { ok: true }); }
        if (req.method === 'POST' && url.pathname === '/api/vault/unlock') { await v.unlock(vb.passphrase); engine.telegram.poll(); engine.audit.add('vault', { actor: 'You', action: 'unlocked the vault' }); return json(res, 200, { ok: true }); }
        if (req.method === 'POST' && url.pathname === '/api/vault/auto') {
          // turning it on needs the passphrase again, so a borrowed open window cannot do it
          if (vb.enable) v.enableAuto(vb.passphrase); else v.disableAuto();
          engine.audit.add('vault', { actor: 'You', action: vb.enable ? 'turned on auto-unlock' : 'turned off auto-unlock' });
          return json(res, 200, { auto: v.auto });
        }
        if (req.method === 'POST' && url.pathname === '/api/vault/lock') { v.lock(); engine.audit.add('vault', { actor: 'You', action: 'locked the vault' }); return json(res, 200, { ok: true }); }
        if (req.method === 'POST' && url.pathname === '/api/vault/secrets') { const it = v.add(vb.name, vb.value, vb.note, vb.username, { type: vb.type, host: vb.host, port: vb.port, auth: vb.auth }); return json(res, 201, vb.assigned ? v.update(it.id, { assigned: vb.assigned }) : it); }
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
        if (updater.s.state === 'installing') return json(res, 202, { started: true });
        if (updater.s.state !== 'ready') throw Object.assign(new Error('There is no downloaded update to install. Check for updates first.'), { status: 409 });
        const b = engine.busy();
        if (b.total && !ub.force) {
          // Queue it: nothing new starts, and the update installs by itself once the work in progress has finished.
          updater.s.queued = true; updater.s.busy = b.total; engine.holdNewWork(true);
          return json(res, 202, { queued: true, busy: b.total, runs: b.runs, approvals: b.approvals });
        }
        startUpdate();
        return json(res, 202, { started: true, forced: !!(b.total && ub.force) });
      }
      if (url.pathname === '/api/update/cancel' && req.method === 'POST') {
        if (!updater) throw Object.assign(new Error('Updates are not available here.'), { status: 409 });
        updater.s.queued = false; updater.s.busy = 0; engine.holdNewWork(false);
        return json(res, 200, { ok: true });
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
      if (req.method === 'GET' && (r = m(/^\/api\/agents\/([\w-]+)\/mentionables$/))) return json(res, 200, engine.mentionables(r[1]));
      if (req.method === 'POST' && url.pathname === '/api/agents/trust-all') return json(res, 200, engine.setTrustAll(await readBody(req)));
      if (req.method === 'POST' && (r = m(/^\/api\/agents\/([\w-]+)\/trust$/))) return json(res, 200, engine.setTrust(r[1], await readBody(req)));
      if ((r = m(/^\/api\/agents\/([\w-]+)\/messages$/))) {
        const id = r[1];
        if (!engine.agents[id]) throw Object.assign(new Error('No such agent'), { status: 404 });
        if (req.method === 'GET') return json(res, 200, engine.messages(id));
        if (req.method === 'POST') {
          const b = await readBody(req);
          if (!b.text?.trim() && !b.images?.length) throw Object.assign(new Error('Empty message'), { status: 400 });
          if (!b.text?.trim()) b.text = 'Please look at the attached picture.';
          return json(res, 202, { ok: true, ...engine.tag(id, b.text, engine.images.resolve(b.images)) });
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
  if (!LOOPBACK.has(HOST) && !TOKEN && !new Auth(path.join(HOME, 'auth.json')).exists) {
    console.error('Refusing to listen on a non-local address without APIARY_TOKEN set or a sign-in account (apiary user set <name>).');
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
  setTimeout(() => engine.telegram.poll(), 3000).unref();
  setTimeout(() => engine.health.run().catch(() => {}), 15000).unref();
  setInterval(() => engine.health.run().catch(() => {}), 5 * 60000).unref();   // the map turns red by itself
  setInterval(() => engine.audit.prune(), 3600000).unref();
  setInterval(() => engine.reports.tick().catch(() => {}), 60000).unref();
  setInterval(() => engine.backups.tick().catch(() => {}), 60000).unref();
  setTimeout(() => engine.refreshLimits().catch(() => {}), 8000).unref();
  setInterval(() => engine.refreshLimits().catch(() => {}), EVERY).unref();   // once an hour
  if (process.env.APIARY_NO_UPDATE_CHECK !== '1') {
    // the schedule is the person's choice (daily, weekly, monthly or manual); this only asks whether a check is due
    const auto = () => { if (engine.updateDue()) { engine.markUpdateChecked(); updater.check().catch(() => {}); } };
    setTimeout(auto, 20000).unref(); setInterval(auto, 30 * 60000).unref();
  }
  server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Set APIARY_PORT to another port.` : e.message); process.exit(1); });
  server.listen(PORT, HOST, () => {
    const bound = server.address();
    const local = bound.address === '0.0.0.0' || bound.address === '::' ? '127.0.0.1' : bound.address;
    engine.baseUrl = `http://${local.includes(':') ? `[${local}]` : local}:${bound.port}`;
    console.log(`Apiary ${VERSION} running at http://${HOST}:${PORT}${TOKEN ? `/?token=${TOKEN}` : ''}`);
    if (links.length) { console.log('\nOpen it from another device on your network with:'); for (const l of links) console.log('  ' + l); console.log('Keep these links private: anyone who has one can run commands as you.\n'); }
    console.log('Connected:', engine.available.map((p) => `${p.id} (${p.method})`).join(', ') || 'nothing yet');
  });
  const bye = () => { store.flush(); engine.memory.flush(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
