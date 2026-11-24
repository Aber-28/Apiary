// End-to-end test with the mock provider: lead -> spawns 2 sub-agents -> reports -> final answer.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'apiary-test-'));
process.env.APIARY_HOME = tmp;
process.env.APIARY_MOCK = '1';
const { Store } = await import('../src/store.js');
const { Engine, parseSpawns } = await import('../src/engine.js');
const { createServer } = await import('../src/server.js');
const { execFileSync } = await import('node:child_process');
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

// parser unit checks
{
  const r = parseSpawns('x\n```apiary-send\n{"to":"Writer","text":"hi"}\n```\n```apiary-send\n{"to":"Lead","text":"q","wait":false}\n```\n```apiary-send\n{"nope":1}\n```');
  assert.equal(r.sends.length, 2); assert.equal(r.sends[0].wait, true); assert.equal(r.sends[1].wait, false); assert.equal(r.errors.length, 1); assert.equal(r.clean, 'x');
}
{
  const r = parseSpawns('hi\n```apiary-spawn\n{"name":"A","task":"t"}\n```\n```apiary-spawn\n[{"task":"x"},{"nope":1}]\n```\n```apiary-spawn\n{bad\n```');
  assert.equal(r.spawns.length, 2); assert.equal(r.errors.length, 2); assert.equal(r.clean, 'hi');
}

const store = new Store(path.join(tmp, 'state.json'));
const engine = new Engine(store);
const server = createServer(engine);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (p, method = 'GET', body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const until = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 30)); } throw new Error('timeout'); };

// security checks
{
  const http = await import('node:http');
  const status = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/state', headers: { host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); }));
  assert.equal(status, 403, 'DNS-rebinding style Host must be rejected');
}
{
  const r = await fetch(base + '/api/agents', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 415);
  const o = await fetch(base + '/api/agents', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' });
  assert.equal(o.status, 403);
}

const events = [];
engine.on('event', (e) => events.push(e));

// bad input
assert.equal((await call('/api/agents', 'POST', { provider: 'nope', goal: 'x' })).status, 400);
assert.equal((await call('/api/agents', 'POST', { provider: 'mock', approvals: false, goal: 'x', cwd: '/definitely/not/here' })).status, 400);

// plain chat, no delegation
let lead = (await call('/api/agents', 'POST', { provider: 'mock', approvals: false, goal: 'hello there' })).body;
await until(() => engine.agents[lead.id].status === 'idle' && engine.messages(lead.id).some((m) => m.role === 'agent'));
assert.match(engine.messages(lead.id).find((m) => m.role === 'agent').text, /You said: hello there/);

// delegation
await call(`/api/agents/${lead.id}/messages`, 'POST', { text: 'please delegate this to your team' });
await until(() => engine.messages(lead.id).some((m) => m.role === 'report') && engine.agents[lead.id].status === 'idle' && engine.messages(lead.id).filter((m) => m.role === 'agent').length >= 3);
const kids = Object.values(engine.agents).filter((a) => a.parentId === lead.id);
assert.deepEqual(kids.map((k) => k.name).sort(), ['Researcher', 'Writer']);
assert.ok(kids.every((k) => k.depth === 1 && k.status === 'idle' && k.cwd === engine.agents[lead.id].cwd));
const finalMsg = engine.messages(lead.id).filter((m) => m.role === 'agent').at(-1).text;
assert.match(finalMsg, /### Researcher/); assert.match(finalMsg, /### Writer/);
assert.ok(!engine.messages(lead.id).some((m) => m.text?.includes('apiary-spawn')), 'spawn blocks must be stripped from chat');
assert.ok(engine.messages(kids[0].id)[0].from?.name, 'child task shows who it came from');
assert.ok(events.some((e) => e.type === 'delta'), 'streaming deltas emitted');

// sub-agents run in parallel (both working at the same time)
// stop + delete
const lead2 = (await call('/api/agents', 'POST', { provider: 'mock', approvals: false, goal: 'delegate work' })).body;
await until(() => Object.values(engine.agents).some((a) => a.parentId === lead2.id));
await call(`/api/agents/${lead2.id}/stop`, 'POST', {});
await until(() => engine.agents[lead2.id].status === 'idle' && Object.values(engine.agents).filter((a) => a.parentId === lead2.id).every((a) => a.status === 'idle'));

// saved agents + settings + connections
{
  const d = await call('/api/defs', 'POST', { name: 'Reviewer', role: 'Reviews work', instructions: 'Be strict.' });
  assert.equal(d.status, 201);
  assert.equal((await call('/api/defs', 'POST', { name: 'reviewer' })).status, 409);
  const l3 = (await call('/api/agents', 'POST', { provider: 'mock', approvals: false, goal: 'use a saved agent please' })).body;
  await until(() => Object.values(engine.agents).some((a) => a.parentId === l3.id && a.name === 'Reviewer' && a.instructions === 'Be strict.'));
  await until(() => engine.agents[l3.id].status === 'idle');
  assert.equal((await call('/api/settings', 'PUT', { limits: { maxDepth: 99 } })).status, 400);
  assert.equal((await call('/api/settings', 'PUT', { limits: { maxRounds: 3 } })).body.limits.maxRounds, 3);
  await call('/api/settings', 'PUT', { limits: { maxRounds: 4 } });
  const c = await call('/api/connections');
  assert.deepEqual(c.body.map((x) => x.id), ['claude', 'codex', 'github']);
  const put = await call('/api/connections/claude', 'PUT', { method: 'api', apiKey: 'sk-secret-1234' });
  assert.equal(put.body.api.hint, '••••1234');
  assert.ok(!JSON.stringify((await call('/api/connections')).body).includes('sk-secret'), 'secrets never returned');
  assert.equal((await call('/api/connections/claude', 'PUT', { method: 'bogus' })).status, 400);
  await call('/api/connections/claude', 'PUT', { method: 'cli', apiKey: '' });
  assert.equal((await call(`/api/agents/${l3.id}/logs`)).body.length > 0, true, 'terminal log recorded');
  assert.equal((await call(`/api/agents/${l3.id}/resume`)).status, 200);
}

// git project: worktrees, auto-commit, merge of sub-agent branches, pull request
{
  const repo = path.join(tmp, 'proj'); const remote = path.join(tmp, 'remote.git');
  execFileSync('git', ['init', '-q', '-b', 'main', remote, '--bare']);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  sh(repo, 'config', 'user.email', 't@t'); sh(repo, 'config', 'user.name', 't');
  execFileSync('sh', ['-c', 'echo hi > README.md'], { cwd: repo });
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'init'); sh(repo, 'remote', 'add', 'origin', remote); sh(repo, 'push', '-q', 'origin', 'main');
  assert.equal((await call('/api/agents', 'POST', { provider: 'mock', approvals: false, goal: 'x', source: 'not a repo' })).status, 400);
  const gl = (await call('/api/agents', 'POST', { provider: 'mock', approvals: false, goal: 'delegate in a repo', source: repo, name: 'Repo job' })).body;
  assert.match(gl.git.branch, /^apiary\/repo-job-[\w]+\/lead$/);
  await until(() => engine.agents[gl.id].status === 'idle' && engine.messages(gl.id).filter((m) => m.role === 'agent').length >= 2, 8000);
  const kids = Object.values(engine.agents).filter((a) => a.parentId === gl.id);
  assert.equal(kids.length, 2);
  assert.ok(kids.every((k) => k.cwd !== gl.cwd && k.branch), 'each child has its own worktree');
  const files = (await import('node:fs')).readdirSync(gl.cwd);
  assert.ok(files.includes('researcher.txt') && files.includes('writer.txt') && files.includes('lead.txt'), 'child work merged into lead branch: ' + files);
  assert.match(sh(gl.cwd, 'log', '--format=%s', '-3'), /Researcher|Writer|Repo job/);
  assert.equal(sh(repo, 'status', '--porcelain'), '', 'original checkout untouched');
  assert.ok(sh(repo, 'branch', '--list', 'apiary/*').includes('lead'), 'agent branches exist');
  // open a PR: push works against the local remote; gh/REST is stubbed out by expecting a clean error
  const pr = await call(`/api/agents/${gl.id}/pr`, 'POST', { title: 'T' });
  assert.ok(pr.status === 200 || pr.status === 502 || pr.status === 400, 'pr route responds: ' + pr.status);
  assert.match(sh(remote, 'branch', '--list', 'apiary/*'), /lead/, 'branch was pushed');
  assert.equal((await call(`/api/agents/${gl.id}`, 'DELETE')).status, 200);
  assert.ok(!sh(repo, 'worktree', 'list').includes('/lead'), 'worktrees removed on delete');
  assert.match(sh(repo, 'branch', '--list', 'apiary/*'), /lead/, 'branches kept');
}

// ---- approvals: sub-agent creation, partial approval, denial, stop ----
{
  const pend = async (kind, ms = 6000) => { let f; await until(() => (f = engine.approvals().find((a) => a.status === 'pending' && a.kind === kind)), ms); return f; };
  const a1 = (await call('/api/agents', 'POST', { provider: 'mock', goal: 'please delegate to a team' })).body;   // approvals default ON
  assert.equal(a1.approvals, true);
  const ap = await pend('spawn');
  assert.equal(ap.items.length, 2);
  assert.equal(Object.values(engine.agents).filter((a) => a.parentId === a1.id).length, 0, 'nothing created before approval');
  assert.equal(engine.agents[a1.id].status, 'waiting');
  assert.equal((await call(`/api/approvals/${ap.id}/decide`, 'POST', { decision: 'maybe' })).status, 400);
  assert.equal((await call(`/api/approvals/${ap.id}/decide`, 'POST', { decision: 'approve', only: [5] })).status, 400);
  assert.equal((await call(`/api/approvals/${ap.id}/decide`, 'POST', { decision: 'approve', only: [0], note: 'just one' })).status, 200);
  assert.equal((await call(`/api/approvals/${ap.id}/decide`, 'POST', { decision: 'deny' })).status, 409, 'cannot answer twice');
  await until(() => engine.agents[a1.id].status === 'idle');
  assert.deepEqual(Object.values(engine.agents).filter((a) => a.parentId === a1.id).map((a) => a.name), ['Researcher']);
  assert.ok(engine.messages(a1.id).some((m) => m.role === 'report' && /only some sub-agents/.test(m.text) && /just one/.test(m.text)));

  // deny
  const a2 = (await call('/api/agents', 'POST', { provider: 'mock', goal: 'delegate again' })).body;
  const ap2 = await pend('spawn');
  await call(`/api/approvals/${ap2.id}/decide`, 'POST', { decision: 'deny', note: 'too much' });
  await until(() => engine.agents[a2.id].status === 'idle');
  assert.equal(Object.values(engine.agents).filter((a) => a.parentId === a2.id).length, 0, 'denied: no sub-agents');
  assert.ok(engine.messages(a2.id).some((m) => /declined/.test(m.text || '') && /too much/.test(m.text)));

  // stop while waiting for approval cancels it
  const a3 = (await call('/api/agents', 'POST', { provider: 'mock', goal: 'delegate and wait' })).body;
  const ap3 = await pend('spawn');
  await call(`/api/agents/${a3.id}/stop`, 'POST', {});
  await until(() => engine.agents[a3.id].status === 'idle');
  assert.equal(engine.store.data.approvals[ap3.id].status, 'cancelled');
}

// ---- agents talk to each other ----
{
  // Researcher asks Writer (a sibling) and waits for the reply
  const l = (await call('/api/agents', 'POST', { provider: 'mock', approvals: false, goal: 'collab please' })).body;
  await until(() => engine.agents[l.id].status === 'idle' && engine.messages(l.id).some((m) => m.role === 'report'), 8000);
  const [res, wri] = ['Researcher', 'Writer'].map((n) => Object.values(engine.agents).find((a) => a.parentId === l.id && a.name === n));
  assert.ok(engine.messages(wri.id).some((m) => m.from?.name === 'Researcher' && /Need your input/.test(m.text)), 'Writer received the message with its sender');
  const rr = engine.messages(res.id).filter((m) => m.role === 'agent').map((m) => m.text).join('\n');
  assert.match(rr, /Teammate replied\. ### Writer \| ok/, 'Researcher got Writer\'s reply: ' + rr);
  // deadlock: child asks its waiting parent with wait=true -> refused, with advice
  const l2 = (await call('/api/agents', 'POST', { provider: 'mock', approvals: false, goal: 'collab-lead please' })).body;
  await until(() => engine.agents[l2.id].status === 'idle' && engine.messages(l2.id).some((m) => m.role === 'report'), 8000);
  const r2 = Object.values(engine.agents).find((a) => a.parentId === l2.id && a.name === 'Researcher');
  assert.match(engine.messages(r2.id).filter((m) => m.role === 'agent').map((m) => m.text).join('\n'), /blocked/, 'waiting on a waiting parent is refused');
  assert.ok(engine.messages(r2.id).some((m) => /wait forever/.test(m.text || '')), 'told how to fix it');
  // unknown teammate
  const l3 = (await call('/api/agents', 'POST', { provider: 'mock', approvals: false, goal: 'collab-ghost please' })).body;
  await until(() => engine.agents[l3.id].status === 'idle' && engine.messages(l3.id).some((m) => m.role === 'report'), 8000);
  const r3 = Object.values(engine.agents).find((a) => a.parentId === l3.id && a.name === 'Researcher');
  assert.ok(engine.messages(r3.id).some((m) => /No teammate called "Ghost"/.test(m.text || '')));
  // project-wide cap
  assert.equal((await call('/api/settings', 'PUT', { limits: { maxPeerMessages: 0 } })).body.limits.maxPeerMessages, 0);
  await call('/api/settings', 'PUT', { limits: { maxPeerMessages: 30 } });
}

// ---- approvals in a git project: review the diff before a merge; review endpoint ----
{
  const repo = path.join(tmp, 'proj2');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  sh(repo, 'config', 'user.email', 't@t'); sh(repo, 'config', 'user.name', 't');
  execFileSync('sh', ['-c', 'echo hi > README.md'], { cwd: repo }); sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'init');
  const gl = (await call('/api/agents', 'POST', { provider: 'mock', goal: 'delegate in a repo', source: repo, name: 'Reviewed job' })).body;
  const pend = async (kind) => { let f; await until(() => (f = engine.approvals().find((a) => a.status === 'pending' && a.kind === kind && a.projectId === gl.id)), 8000); return f; };
  await call(`/api/approvals/${(await pend('spawn')).id}/decide`, 'POST', { decision: 'approve' });
  const m1 = await pend('merge');
  assert.match(m1.diff.stat, /\.txt/, 'merge request carries the diff');
  assert.match(m1.diff.patch, /\+Work by/, 'and the patch');
  const first = m1.title;
  await call(`/api/approvals/${m1.id}/decide`, 'POST', { decision: 'approve' });
  let m2; await until(() => (m2 = engine.approvals().find((a) => a.status === 'pending' && a.kind === 'merge' && a.projectId === gl.id)), 8000);
  assert.notEqual(m2.title, first);
  await call(`/api/approvals/${m2.id}/decide`, 'POST', { decision: 'deny', note: 'not this one' });
  await until(() => engine.agents[gl.id].status === 'idle', 8000);
  const files = (await import('node:fs')).readdirSync(gl.cwd).filter((f) => f.endsWith('.txt'));
  assert.ok(files.includes('researcher.txt') !== files.includes('writer.txt'), 'exactly one child merged: ' + files);
  assert.ok(engine.messages(gl.id).some((m) => /did NOT approve merging/.test(m.text || '') && /not this one/.test(m.text)));
  assert.match(sh(repo, 'branch', '--list', 'apiary/*'), /apiary/, 'declined branch kept');
  const d = (await call(`/api/agents/${gl.id}/diff`)).body;
  assert.equal(d.to, gl.git.branch); assert.match(d.stat, /txt/);
  assert.equal((await call(`/api/agents/${Object.values(engine.agents).find((a) => a.parentId === gl.id).id}/diff`)).status, 200);
  assert.equal((await call(`/api/agents/${lead2.id}/diff`)).status, 409, 'plain folder has no diff');
}

const before = Object.keys(engine.agents).length;
assert.equal((await call(`/api/agents/${lead.id}`, 'DELETE')).status, 200);
assert.equal(Object.keys(engine.agents).length, before - 3);
assert.equal((await call(`/api/agents/${lead.id}/messages`)).status, 404);

// persistence survives restart
store.flush();
const engine2 = new Engine(new Store(path.join(tmp, 'state.json')));
assert.ok(engine2.agents[lead2.id]);

// ---- onboarding backend: service install, model lists, defaults ----
{
  const fs = await import('node:fs');
  const http = await import('node:http');
  // fake systemctl (never touch the real one) and a private config dir
  const bin = path.join(tmp, 'fakebin'); fs.mkdirSync(bin);
  const logf = path.join(tmp, 'systemctl.log');
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$@" >> ${logf}\ncase "$2" in\n is-enabled) [ -f ${logf}.enabled ] && echo enabled || echo disabled;;\n is-active) echo inactive;;\n enable) touch ${logf}.enabled;;\n disable) rm -f ${logf}.enabled;;\nesac\nexit 0\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`; process.env.XDG_CONFIG_HOME = path.join(tmp, 'xdg'); process.env.APIARY_NO_LINGER = '1'; process.env.APIARY_NO_EXIT = '1';
  let st = (await call('/api/service')).body;
  assert.equal(st.supported, true); assert.equal(st.enabled, false);
  st = (await call('/api/service', 'POST', { enabled: true })).body;
  assert.equal(st.enabled, true); assert.equal(st.installed, true);
  const unit = fs.readFileSync(path.join(tmp, 'xdg/systemd/user/apiary.service'), 'utf8');
  assert.match(unit, /ExecStart="[^"]*node[^"]*" "[^"]*bin\/apiary\.js" start\n/); assert.match(unit, /Environment="PATH=/); assert.match(unit, /WantedBy=default\.target/);
  assert.match(fs.readFileSync(logf, 'utf8'), /--user enable apiary/);
  st = (await call('/api/service', 'POST', { enabled: false })).body;
  assert.equal(st.enabled, false); assert.equal(fs.existsSync(path.join(tmp, 'xdg/systemd/user/apiary.service')), false);
  process.env.PATH = oldPath;
  assert.equal((await call('/api/service')).status, 200, 'status answers honestly even without systemd');

  // model list: from the provider when a key is saved, suggestions otherwise
  const fake = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.headers['x-api-key'] === 'good-key' ? { data: [{ id: 'claude-x-1', display_name: 'Claude X' }, { id: 'claude-a-2' }] } : { error: 'no' })); });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.APIARY_ANTHROPIC_URL = `http://127.0.0.1:${fake.address().port}`;
  assert.equal((await call('/api/connections/claude/models')).body.source, 'suggestions');
  await call('/api/connections/claude', 'PUT', { method: 'api', apiKey: 'good-key' });
  const ml = (await call('/api/connections/claude/models')).body;
  assert.equal(ml.source, 'provider'); assert.deepEqual(ml.models.map((m) => m.id), ['claude-a-2', 'claude-x-1']);
  await call('/api/connections/claude', 'PUT', { apiKey: 'bad-key' });
  assert.equal((await call('/api/connections/claude/models')).body.source, 'suggestions', 'falls back when the provider refuses');
  assert.equal((await call('/api/connections/github/models')).status, 404);
  await call('/api/connections/claude', 'PUT', { method: 'cli', apiKey: '', model: 'claude-opus-5-5' });
  assert.equal(engine.defaultModel('claude'), 'claude-opus-5-5', 'new agents start with the chosen default model');
  fake.close(); delete process.env.APIARY_ANTHROPIC_URL;
  // chosen default model is used by new projects; defaults and first-run state persist
  assert.equal((await call('/api/state')).body.onboardingDone, false);
  assert.equal((await call('/api/settings', 'PUT', { defaultProvider: 'bogus' })).status, 400);
  const s2 = (await call('/api/settings', 'PUT', { defaultProvider: 'claude', onboardingDone: true })).body;
  assert.equal(s2.onboardingDone, true);
  assert.equal((await call('/api/state')).body.onboardingDone, true);
  await call('/api/connections/claude', 'PUT', { model: '' });
}

// ---- LAN mode: reachable by IP with a token, still locked down ----
{
  const { spawn } = await import('node:child_process');
  const http = await import('node:http');
  const ip = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  const port = 7800 + Math.floor(Math.random() * 150);
  const home = path.join(tmp, 'lan');
  const child = spawn(process.execPath, [path.join(process.cwd(), 'bin/apiary.js'), 'start', '--lan', '--port', String(port)], { env: { ...process.env, APIARY_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  await until(() => /running at/.test(out), 6000);
  const token = (await import('node:fs')).readFileSync(path.join(home, 'token'), 'utf8').trim();
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.equal(((await import('node:fs')).statSync(path.join(home, 'token')).mode & 0o777), 0o600, 'token file is private');
  const get = (host, p, headers = {}) => new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: p, headers: { host, ...headers } }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => resolve({ status: r.statusCode, body: b })); }));
  const target = ip || '127.0.0.1';
  assert.equal((await get(`${target}:${port}`, '/api/state')).status, 401, 'token required');
  const page = await get(`${target}:${port}`, '/', { accept: 'text/html' });
  assert.equal(page.status, 401); assert.match(page.body, /access link/, 'friendly page, not JSON');
  assert.equal((await get(`${target}:${port}`, '/api/state', { 'x-apiary-token': token })).status, 200, 'IP address + token works');
  assert.equal((await get(`${target}:${port}`, `/?token=${token}`)).status, 200);
  assert.equal((await get(`evil.example:${port}`, '/api/state', { 'x-apiary-token': token })).status, 403, 'unknown host names still blocked');
  if (ip) assert.ok(out.includes(`http://${ip}:${port}/?token=${token}`), 'prints the link for this machine');
  child.kill('SIGTERM');
  // default mode: not reachable by other host names or IPs
  assert.equal((await new Promise((resolve) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/state', headers: { host: '192.168.1.50:7777' } }, (r) => { r.resume(); resolve(r.statusCode); }))), 403);
}

console.log('all e2e checks passed');
server.close(); process.exit(0);
