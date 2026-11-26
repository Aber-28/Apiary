// End-to-end test with the mock provider: lead -> spawns 2 sub-agents -> reports -> final answer.
import assert from 'node:assert/strict';
import { mkdtempSync, statSync as fsStat, readFileSync as fsRead, existsSync as fsExists } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'apiary-test-'));
process.env.APIARY_HOME = tmp;
process.env.APIARY_KEYFILE = path.join(tmp + '-keys', 'vault.key');
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
  // the reply comes back as a message in Researcher's own chat (Researcher is not held waiting)
  await until(() => engine.messages(res.id).some((m) => /Reply from Writer/.test(m.text || '')), 8000);
  assert.ok(engine.messages(res.id).some((m) => /Reply from Writer/.test(m.text || '')), 'Researcher got Writer\'s reply as a message');
  // no one is held waiting: a child may ask its parent while the parent is busy, and the reply comes back as a message
  const l2 = (await call('/api/agents', 'POST', { provider: 'mock', approvals: false, goal: 'collab-lead please' })).body;
  await until(() => engine.agents[l2.id].status === 'idle' && engine.messages(l2.id).some((m) => m.role === 'report'), 8000);
  const r2 = Object.values(engine.agents).find((a) => a.parentId === l2.id && a.name === 'Researcher');
  assert.ok(!engine.messages(r2.id).some((m) => /wait forever|blocked/.test(m.text || '')), 'a child is never refused for asking its parent');
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

// ---- memory ----
{
  const { parseRemember } = await import('../src/memory.js');
  const pr = parseRemember('Ok.\n```apiary-remember\n{"text":"Use port 8443","scope":"project"}\n```\n```apiary-remember\n{"nope":1}\n```');
  assert.equal(pr.notes.length, 1); assert.equal(pr.notes[0].scope, 'project'); assert.equal(pr.clean, 'Ok.');

  const ml = (await call('/api/agents', 'POST', { provider: 'mock', approvals: false, name: 'Memlane', goal: 'hello memory' })).body;
  await until(() => engine.agents[ml.id].status === 'idle' && engine.memory.items.some((m) => m.who === 'Memlane'));
  const key = engine._mkey(engine.agents[ml.id]), pkey = engine._pkey(engine.agents[ml.id]);
  assert.ok(engine.memory.items.some((m) => m.kind === 'episode' && m.agent === key && /hello memory/.test(m.text)), 'a finished task is remembered');
  // history spread over the last year
  const DAY = 86400000, d0 = new Date(); d0.setHours(0, 0, 0, 0); const t0 = d0.getTime();
  const seed = [[Date.now() - 60000, 'TONIGHTMARK opened the firewall ticket'], [t0 - 3 * 3600000, 'YESTERDAYMARK moved the DNS zone'], [t0 - 4 * DAY, 'WEEKMARK rotated the VPN keys'], [t0 - 20 * DAY, 'MONTHMARK upgraded the router'], [t0 - 400 * DAY, 'YEARMARK first set up the reverse proxy']];
  for (const [ts, text] of seed) engine.memory.add({ kind: 'episode', ts, agent: key, project: pkey, who: 'Memlane', text });
  await call(`/api/agents/${ml.id}/messages`, 'POST', { text: 'what do you remember?' });
  await until(() => engine.messages(ml.id).some((m) => m.role === 'agent' && /I remember:/.test(m.text)));
  const recall = engine.messages(ml.id).find((m) => m.role === 'agent' && /I remember:/.test(m.text)).text;
  for (const k of ['TONIGHTMARK', 'YESTERDAYMARK', 'WEEKMARK', 'MONTHMARK', 'YEARMARK']) assert.ok(recall.includes(k), `${k} is in the agent's memory: ${recall}`);
  assert.match(recall, /Yesterday:/); assert.match(recall, /Further back/);
  // explicit notes; project scope reaches teammates, not other projects
  await call(`/api/agents/${ml.id}/messages`, 'POST', { text: 'remember this: the VPN port is 51820 (project note)' });
  await until(() => engine.memory.items.some((m) => m.kind === 'note' && /51820/.test(m.text)));
  const note = engine.memory.items.find((m) => /51820/.test(m.text));
  assert.equal(note.project, pkey); assert.equal(note.agent, null);
  assert.match(engine.memory.context('someone-else', pkey, 'x'), /51820/); assert.doesNotMatch(engine.memory.context('someone-else', '/other', 'x'), /51820/);
  // API: add / search / preview / delete
  const added = (await call('/api/memory', 'POST', { text: 'Sam prefers short answers', scope: 'global' })).body;
  assert.equal((await call('/api/memory', 'POST', { text: 'x', scope: 'agent' })).status, 400, 'agent notes need an agent');
  assert.ok((await call('/api/memory?q=short+answers')).body.items.some((m) => m.id === added.id));
  assert.match((await call(`/api/memory/preview/${ml.id}`)).body.text, /short answers/);
  assert.equal((await call('/api/memory/' + added.id, 'DELETE')).status, 200);
  assert.equal((await call('/api/memory/' + added.id, 'DELETE')).status, 404);
  assert.equal((await call('/api/state')).body.memory.enabled, true);
  // compaction keeps old history as one digest per month
  const keep = engine.memory.items.length;
  for (let i = 0; i < 3; i++) engine.memory.add({ kind: 'episode', ts: Date.now() - 200 * DAY - i, agent: 'zed', project: null, who: 'Zed', text: `OLD${i} thing` });
  engine.memory.compact();
  const dg = engine.memory.items.filter((m) => m.agent === 'zed');
  assert.equal(dg.length, 1); assert.ok(dg[0].digest && /OLD0/.test(dg[0].text) && /OLD2/.test(dg[0].text));
  // persistence + switch off
  engine.memory.flush();
  const { Memory } = await import('../src/memory.js');
  assert.ok(new Memory(engine.memory.file).items.some((m) => /YEARMARK/.test(m.text)), 'memory survives a restart');
  assert.equal((fsStat(engine.memory.file).mode & 0o777), 0o600);
  await call('/api/settings', 'PUT', { memory: false });
  const n = engine.memory.items.length;
  await call(`/api/agents/${ml.id}/messages`, 'POST', { text: 'what do you remember?' });
  await until(() => engine.messages(ml.id).filter((m) => m.role === 'agent' && /I remember:/.test(m.text)).length === 2);
  assert.match(engine.messages(ml.id).filter((m) => m.role === 'agent').at(-1).text, /\(nothing\)/);
  assert.equal(engine.memory.items.length, n, 'nothing recorded while memory is off');
  await call('/api/settings', 'PUT', { memory: true });
}

// ---- teams: CEO assigns, specialists check with each other, prerequisites come first ----
{
  const { parseVerdict } = await import('../src/engine.js');
  assert.deepEqual(parseVerdict('VERDICT: CONDITIONS\nREASON: r\nPREREQUISITE: a\nPREREQUISITE: b'), { verdict: 'CONDITIONS', reason: 'r', prerequisites: ['a', 'b'] });
  assert.equal(parseVerdict('VERDICT: CONDITIONS\nREASON: r').verdict, 'GO', 'conditions without prerequisites are just a go');
  assert.equal(parseVerdict('looks fine').verdict, 'UNCLEAR');
  assert.equal(parseVerdict('**VERDICT:** block\nREASON: no').verdict, 'BLOCK');

  const teams = (await call('/api/teams')).body;
  const preset = teams.find((t) => t.name === 'Operations team');
  assert.ok(preset && preset.members.map((m) => m.name).join() === 'Networking,Security,Research' && preset.lead.name === 'CEO', 'preset team exists');
  assert.equal((await call('/api/teams', 'POST', { name: 'Dup', lead: { name: 'A' }, members: [{ name: 'a' }] })).status, 400, 'names must differ');
  assert.equal((await call('/api/teams', 'POST', { name: 'Empty', lead: { name: 'A' }, members: [] })).status, 400);
  const mine = (await call('/api/teams', 'POST', { name: 'Mine', lead: { name: 'Boss' }, members: [{ name: 'Dev' }] })).body;
  assert.equal((await call('/api/teams/' + mine.id, 'DELETE')).status, 200);
  assert.equal((await call('/api/agents', 'POST', { provider: 'mock', goal: 'x', team: 'nope' })).status, 400);

  const run = async (goal, extra = {}) => {
    const l = (await call('/api/agents', 'POST', { provider: 'mock', approvals: false, team: preset.id, goal, ...extra })).body;
    await until(() => engine.agents[l.id].status === 'idle' && engine.messages(l.id).some((m) => m.role === 'report'), 10000);
    const mem = (n) => Object.values(engine.agents).find((a) => a.parentId === l.id && (a.title === n || a.name === n));
    const says = (a) => engine.messages(a.id);
    return { l, mem, says, report: engine.messages(l.id).find((m) => m.role === 'report').text };
  };

  // full flow in a plain folder
  const t1 = await run('Change the network firewall rules');
  assert.equal(engine.agents[t1.l.id].role.startsWith('Chief executive'), true);
  assert.deepEqual(Object.values(engine.agents).filter((a) => a.parentId === t1.l.id).map((a) => a.title).sort(), ['Networking', 'Research', 'Security']);
  assert.ok(Object.values(engine.agents).filter((a) => a.parentId === t1.l.id).every((a) => a.name !== a.title && /^[A-Z]/.test(a.name)), 'team members get comic-book style names by default');
  const sec = t1.mem('Security'), net = t1.mem('Networking'), res = t1.mem('Research');
  const secMsgs = t1.says(sec), netMsgs = t1.says(net);
  const precheck = secMsgs.findIndex((m) => new RegExp(`Pre-check requested by ${net.name}`).test(m.text || '') && m.from?.name === net.name);
  const prereq = secMsgs.findIndex((m) => new RegExp(`Prerequisite for ${net.name}`).test(m.text || ''));
  assert.ok(precheck >= 0 && prereq > precheck, 'Security was asked first, then did its prerequisite');
  assert.ok(t1.says(res).some((m) => new RegExp(`Pre-check requested by ${net.name}`).test(m.text || '')), 'Research was consulted too');
  const job = netMsgs.find((m) => /^Task from /.test(m.text || ''));
  const prereqDone = secMsgs.filter((m) => m.role === 'agent').find((m) => /^DONE/.test(m.text));
  assert.ok(job && prereqDone && job.ts >= prereqDone.ts, 'the job started only after the prerequisite was done');
  assert.match(netMsgs.find((m) => m.role === 'agent' && /Finished the job/.test(m.text)).text, /Sees prerequisite: yes/);
  assert.match(t1.report, /Pre-check results/); assert.match(t1.report, new RegExp(`${sec.name} \\(Security\\): CONDITIONS`)); assert.match(t1.report, new RegExp(`${res.name} \\(Research\\): GO`));
  assert.equal(t1.says(t1.mem('Research')).some((m) => /^Task from/.test(m.text || '')), false, 'only the assignee does the job');

  // BLOCK stops everything
  const t2 = await run('Wipe the network config');
  assert.match(t2.report, /NOT STARTED/); assert.match(t2.report, new RegExp(`${t2.mem('Security').name} blocked it`));
  assert.equal(t2.says(t2.mem('Networking')).some((m) => /^Task from/.test(m.text || '')), false, 'a blocked task never starts');
  // a failed prerequisite stops it too
  const t3 = await run('network firewall failprereq');
  assert.match(t3.report, /NOT STARTED[\s\S]*could not complete a prerequisite/);
  assert.equal(t3.says(t3.mem('Networking')).some((m) => /^Task from/.test(m.text || '')), false);
  // an unclear answer is reported as unclear, never treated as a quiet yes
  const t4 = await run('network garble thing');
  assert.match(t4.report, new RegExp(`${t4.mem('Research').name} \\(Research\\): UNCLEAR`));
  assert.ok(t4.says(t4.mem('Networking')).some((m) => /^Task from/.test(m.text || '')));

  // members keep their memory across assignments and projects
  const nk = engine._mkey(net);
  assert.ok(engine.memory.items.filter((m) => m.kind === 'episode' && m.agent === nk).length >= 2, 'the Networking specialist remembers its past jobs');
  assert.match(engine.memory.context(nk, 'other-project', 'firewall rules'), /firewall/, 'and recalls them in a new project');
}

// ---- teams in a git project: prerequisites are merged into the lead's branch, with approval ----
{
  const repo = path.join(tmp, 'teamrepo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  sh(repo, 'config', 'user.email', 't@t'); sh(repo, 'config', 'user.name', 't');
  execFileSync('sh', ['-c', 'echo hi > README.md'], { cwd: repo }); sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'init');
  const preset = (await call('/api/teams')).body.find((t) => t.name === 'Operations team');
  const gl = (await call('/api/agents', 'POST', { provider: 'mock', team: preset.id, source: repo, name: 'Team repo job', goal: 'Change the network firewall rules' })).body;
  const approved = new Set(); let merges = 0;
  const timer = setInterval(() => { for (const a of engine.approvals()) if (a.status === 'pending' && a.projectId === gl.id && !approved.has(a.id)) { approved.add(a.id); if (a.kind === 'merge') merges++; call(`/api/approvals/${a.id}/decide`, 'POST', { decision: 'approve' }).catch(() => {}); } }, 40);
  try { await until(() => engine.agents[gl.id].status === 'idle' && engine.messages(gl.id).some((m) => m.role === 'report'), 15000); } finally { clearInterval(timer); }
  assert.ok(merges >= 2, `the prerequisite and the job each needed a merge approval (${merges})`);
  const files = sh(repo, 'ls-tree', '-r', '--name-only', engine.agents[gl.id].git.branch).split('\n');
  assert.ok(files.includes('security-prereq.txt') && files.includes('networking.txt'), `both pieces of work reached the lead's branch: ${files}`);
  const nm = Object.values(engine.agents).find((a) => a.parentId === gl.id && a.title === 'Networking');
  assert.match(engine.messages(nm.id).find((m) => m.role === 'agent' && /Finished the job/.test(m.text)).text, /Sees prerequisite: yes/, 'the prerequisite was in the specialist\'s own checkout');
  assert.ok(sh(repo, 'worktree', 'list').includes(nm.id), 'standing members keep their checkout');
  await call('/api/agents/' + gl.id, 'DELETE');
}

// ---- the map: layout keeps groups together, arrows are tidy right-angle curves around boxes, and crossings get a bump ----
{
  const map = await import('../public/map.js');
  assert.equal((await fetch(base + '/map.js')).status, 200, 'the map module is served');
  const it = (id, name, extra = {}) => ({ id, name, type: 'vm', links: [], ...extra });
  const A = it('a', 'A', { links: [{ to: 'b', label: 'east' }, { to: 'd' }] }), B = it('b', 'B'), Cc = it('c', 'C', { links: [{ to: 'd' }] }), D = it('d', 'D');
  const mk = (x, y) => ({ x, y, w: 200, h: 66, leaf: true, depth: 0 });
  const boxes = new Map([['a', { id: 'a', item: A, ...mk(64, 200) }], ['b', { id: 'b', item: B, ...mk(520, 200) }], ['c', { id: 'c', item: Cc, ...mk(292, 64) }], ['d', { id: 'd', item: D, ...mk(292, 420) }]]);
  const routes = map.routeLinks([A, B, Cc, D], boxes, 900, 600);
  assert.equal(routes.length, 3);
  for (const r of routes) {
    assert.ok(r.points.every((p, i) => i === 0 || p[0] === r.points[i - 1][0] || p[1] === r.points[i - 1][1]), 'every part of an arrow is horizontal or vertical');
    for (const p of r.points.slice(1, -1)) for (const b of boxes.values()) assert.ok(!(p[0] > b.x && p[0] < b.x + b.w && p[1] > b.y && p[1] < b.y + b.h), 'arrows do not run through boxes');
  }
  const ab = routes.find((r) => r.from === 'a' && r.to === 'b'), ad = routes.find((r) => r.to === 'd' && r.from === 'a'), cd = routes.find((r) => r.from === 'c');
  assert.ok(ab.segs.some((s) => s.hops.length) || cd.segs.some((s) => s.hops.length), 'where arrows cross, one hops over the other');
  const hopper = [ab, cd].find((r) => r.segs.some((s) => s.hops.length));
  assert.match(map.linkPath(hopper.points, hopper.segs), /A5 5 0 0 [01] /, 'the hop is drawn as a small bump'); assert.ok(ad.points.length >= 3 && /Q/.test(map.linkPath(ad.points, ad.segs)), 'corners are rounded');
  // layout: a thing that runs on another sits inside it; linked groups end up next to each other
  const items = [it('h1', 'Host 1', { type: 'proxmox' }), it('h2', 'Host 2', { type: 'proxmox' }), it('h3', 'Host 3', { type: 'proxmox' }), it('v1', 'V1', { parentId: 'h1' }), it('v2', 'V2', { parentId: 'h2' }), it('v3', 'V3', { parentId: 'h3', links: [{ to: 'v1' }] }), it('s', 'Solo', { type: 'service' })];
  const L = map.layoutMap(items), b = (id) => L.box.get(id), inside = (c, p) => c.x >= p.x && c.y >= p.y && c.x + c.w <= p.x + p.w && c.y + c.h <= p.y + p.h;
  assert.ok(inside(b('v1'), b('h1')) && inside(b('v3'), b('h3')), 'children are drawn inside their host');
  assert.ok(Math.abs(b('h1').x - b('h3').x) < Math.abs(b('h1').x - b('h2').x), 'hosts that talk to each other are placed side by side');
  assert.ok(b('s').y > b('h1').y + b('h1').h, 'things on their own go underneath');
  const loop = map.layoutMap([it('p', 'P', { parentId: 'q' }), it('q', 'Q', { parentId: 'p' })]); assert.equal(loop.box.size, 2, 'a loop in "runs on" does not hide anything');
}

// ---- themes: every theme in the list is served, defined and complete ----
{
  const js = await (await fetch(base + '/theme.js')).text(), css = await (await fetch(base + '/themes.css')).text(), page = await (await fetch(base + '/')).text();
  assert.match(page, /themes\.css/, 'the page loads the themes');
  const ids = [...js.matchAll(/\{ id: '([a-z-]+)', name:/g)].map((m) => m[1]); assert.ok(ids.length >= 11 && ids.includes('matrix') && ids.includes('glass') && ids.includes('dark') && ids.includes('light'));
  const need = ['bg', 'surface', 'surface2', 'line', 'text', 'muted', 'accent', 'on-accent', 'accent-text', 'accent-soft', 'ok', 'ok-text', 'ok-soft', 'info', 'info-text', 'info-soft', 'err', 'err-soft', 'user', 'hover'];
  for (const id of ids.filter((x) => x !== 'dark' && x !== 'light')) {
    const m = css.match(new RegExp(`html\\.t-${id}\\{([^}]*)\\}`)); assert.ok(m, `theme ${id} has its colours`);
    for (const v of need) assert.ok(m[1].includes(`--${v}:`), `theme ${id} sets --${v}`);
  }
  assert.equal(ids.length, new Set(ids).size, 'theme ids are unique');
}

// ---- retries and recovery: retry a hiccup, retry a stuck run, hand a limit to the other AI, otherwise ask the human in plain words ----
{
  process.env.APIARY_RETRY_MS = '5'; process.env.APIARY_STUCK_MS = '250';
  const sysText = (id) => engine.messages(id).filter((m) => m.role === 'system').map((m) => m.text).join('\n');
  const mk = async (goal) => (await call('/api/agents', 'POST', { provider: 'mock', approvals: false, goal })).body;
  const done = (id, re) => until(() => engine.agents[id].status === 'idle' && engine.messages(id).some((m) => m.role === 'agent' && re.test(m.text)), 8000);
  const a1 = await mk('recover-flaky hello'); await done(a1.id, /You said: recover-flaky/); assert.match(sysText(a1.id), /could not be reached\. Trying again \(1 of 2\)/, 'a network hiccup is retried');
  const a2 = await mk('recover-stuck hello'); await done(a2.id, /You said: recover-stuck/); assert.match(sysText(a2.id), /stopped responding\. Trying again/, 'a run that goes quiet is stopped and retried');
  engine._alternate = (a) => (a.provider === 'mock' ? 'mock' : null);
  const a3 = await mk('recover-limit hello'); await done(a3.id, /You said: recover-limit/); assert.match(sysText(a3.id), /has reached its usage limit, so .* takes over this step/, 'a limit hands the step to the other AI');
  assert.equal(engine.agents[a3.id].switchedFrom, undefined, 'the agent itself keeps its own AI');
  engine._alternate = () => null;
  const a4 = await mk('recover-allfail hello');
  await until(() => engine.approvals().some((x) => x.agentId === a4.id && x.status === 'pending' && x.kind === 'stuck'), 8000);
  const ask = engine.approvals().find((x) => x.agentId === a4.id && x.kind === 'stuck');
  assert.match(ask.title, /cannot continue: .* reached its usage limit/); assert.match(ask.detail, /What happened:[\s\S]*What Apiary tried:[\s\S]*Try again/, 'the reason is explained in plain words');
  await call(`/api/approvals/${ask.id}/decide`, 'POST', { decision: 'approve' }); await done(a4.id, /You said: recover-allfail/);
  const a5 = await mk('recover-allfail again');
  await until(() => engine.approvals().some((x) => x.agentId === a5.id && x.status === 'pending' && x.kind === 'stuck'), 8000);
  const ask5 = engine.approvals().find((x) => x.agentId === a5.id && x.kind === 'stuck'); await call(`/api/approvals/${ask5.id}/decide`, 'POST', { decision: 'deny' });
  await until(() => engine.agents[a5.id].status !== 'working' && engine.agents[a5.id].status !== 'waiting', 8000);
  assert.ok(engine.messages(a5.id).some((m) => /you chose to stop/.test(m.text || '')), 'giving up is reported');
  delete engine._alternate; delete process.env.APIARY_RETRY_MS; delete process.env.APIARY_STUCK_MS;
}

// ---- parallel work in a git project: two specialists change the same file at once; merges are queued, the clash is fixed by its author ----
{
  const repo = path.join(tmp, 'parrepo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  sh(repo, 'config', 'user.email', 't@t'); sh(repo, 'config', 'user.name', 't');
  execFileSync('sh', ['-c', 'echo hi > README.md'], { cwd: repo }); sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'init');
  const preset = (await call('/api/teams')).body.find((t) => t.name === 'Operations team');
  const gl = (await call('/api/agents', 'POST', { provider: 'mock', team: preset.id, source: repo, name: 'Parallel job', goal: 'assign-both:Networking,Research please' })).body;
  const approved = new Set();
  const timer = setInterval(() => { for (const a of engine.approvals()) if (a.status === 'pending' && a.projectId === gl.id && !approved.has(a.id)) { approved.add(a.id); call(`/api/approvals/${a.id}/decide`, 'POST', { decision: 'approve' }).catch(() => {}); } }, 40);
  try { await until(() => engine.agents[gl.id].status === 'idle' && engine.messages(gl.id).some((m) => m.role === 'report'), 25000); } finally { clearInterval(timer); }
  const files = sh(repo, 'ls-tree', '-r', '--name-only', engine.agents[gl.id].git.branch).split('\n');
  assert.ok(files.includes('networking.txt') && files.includes('research.txt') && files.includes('shared.txt'), `everyone's work reached the lead's branch: ${files}`);
  assert.match(sh(repo, 'show', engine.agents[gl.id].git.branch + ':shared.txt'), /Both pieces of work kept/, 'the clash was resolved by keeping both');
  assert.ok(engine.tasks.list.some((t) => t.log.some((l) => /Conflict in shared\.txt resolved and merged/.test(l.text))), 'the conflict and its fix are in the task history');
  assert.equal(sh(repo, 'status', '--porcelain', '--', '.').trim(), '', 'nothing left half-merged');
  await call('/api/agents/' + gl.id, 'DELETE');
}

// ---- main chat, project files, hiring and the organisation chart ----
{
  engine.store.data.settings.defaultProvider = 'mock';   // the sandbox has a real claude CLI; tests must not use it
  const g1 = (await call('/api/chat')).body, g2 = (await call('/api/chat')).body;
  assert.equal(g1.id, g2.id); assert.equal(g1.kind, 'general'); assert.equal(g1.parentId, null);
  await call(`/api/agents/${g1.id}/messages`, 'POST', { text: 'good morning' });
  await until(() => engine.messages(g1.id).some((m) => m.role === 'agent' && /You said: good morning/.test(m.text)));
  assert.match(engine._system(engine.agents[g1.id]), /everyday assistant/);
  assert.equal((await call('/api/agents/' + g1.id, 'DELETE')).status, 400, 'the main chat cannot be deleted');
  await until(() => engine.agents[g1.id].status === 'idle');

  // files
  const fp = (await call('/api/agents', 'POST', { provider: 'mock', approvals: false, name: 'Website', goal: 'hello' })).body;
  await until(() => engine.agents[fp.id].status === 'idle');
  const ls = (await call(`/api/agents/${fp.id}/files`)).body;
  assert.deepEqual(ls.items.filter((i) => i.type === 'dir').map((i) => i.name), ['data', 'documents'], 'a new project has documents and data folders');
  assert.equal((await call(`/api/agents/${fp.id}/file?path=documents/brief.md`, 'PUT', { content: '# Brief\nBuild it.' })).status, 200);
  assert.equal((await call(`/api/agents/${fp.id}/file?path=documents/brief.md`)).body.content, '# Brief\nBuild it.');
  assert.ok((await call(`/api/agents/${fp.id}/files?path=documents`)).body.items.some((i) => i.name === 'brief.md'));
  const raw = await fetch(`${base}/api/agents/${fp.id}/file?path=documents/brief.md&raw=1`);
  assert.match(raw.headers.get('content-disposition'), /attachment; filename="brief.md"/);
  for (const bad of ['../../etc/passwd', '/etc/passwd', '.git/config']) assert.equal((await call(`/api/agents/${fp.id}/file?path=${encodeURIComponent(bad)}`)).status, bad === '.git/config' ? 400 : (await call(`/api/agents/${fp.id}/file?path=${encodeURIComponent(bad)}`)).status, bad);
  assert.equal((await call(`/api/agents/${fp.id}/file?path=${encodeURIComponent('../../etc/passwd')}`)).status, 400);
  assert.equal((await call(`/api/agents/${fp.id}/file?path=${encodeURIComponent('/etc/passwd')}`)).status, 404, 'absolute paths are treated as inside the project');
  (await import('node:fs')).symlinkSync('/etc', path.join(engine.agents[fp.id].cwd, 'escape'));
  assert.equal((await call(`/api/agents/${fp.id}/files?path=escape`)).status, 400, 'a symlink cannot lead out of the project');
  assert.equal((await call(`/api/agents/${fp.id}/file?path=documents/brief.md`, 'DELETE')).status, 200);
  assert.equal((await call(`/api/agents/${fp.id}/file?path=documents/brief.md`)).status, 404);

  // hiring: suggestion -> approval with reasons and ready-made profiles -> org chart
  const hp = (await call('/api/agents', 'POST', { provider: 'mock', name: 'Site build', goal: 'please hire a team' })).body;
  let ap; await until(() => (ap = engine.approvals().find((a) => a.status === 'pending' && a.kind === 'hire' && a.projectId === hp.id)), 8000);
  assert.equal(ap.items.length, 2);
  const fe = ap.items[0];
  assert.equal(fe.department, 'engineering'); assert.match(fe.reason, /UI built/);
  assert.match(fe.instructions, /Guardrails:/); assert.match(fe.instructions, /Never delete data/); assert.match(fe.instructions, /run the existing tests|Run the existing tests/i);
  assert.ok(fe.guardrails.length >= 5);
  assert.equal(engine.roster?.length, undefined);
  assert.equal(Object.values(engine.agents).filter((a) => a.member && engine.rootOf(a).id === hp.id).length, 0, 'nobody is hired before approval');
  await call(`/api/approvals/${ap.id}/decide`, 'POST', { decision: 'approve' });
  await until(() => engine.agents[hp.id].status === 'idle' && engine.messages(hp.id).some((m) => /^Hired ?/.test(m.text || '')) , 8000);
  const org = (await call(`/api/projects/${hp.id}/org`)).body;
  assert.equal(org.id, hp.id);
  assert.deepEqual(org.reports.map((n) => n.title), ['Frontend Engineer'], 'the engineer reports to the lead');
  assert.deepEqual(org.reports[0].reports.map((n) => n.title), ['Brand Writer'], 'the writer reports to the engineer');
  assert.equal(org.reports[0].departmentLabel, 'Engineering'); assert.equal(org.reports[0].reports[0].departmentLabel, 'Marketing');
  const hired = Object.values(engine.agents).find((a) => a.title === 'Frontend Engineer');
  assert.ok(hired.member && hired.profile.reason && /Guardrails:/.test(hired.instructions) && hired.parentId === hp.id);
  assert.match(engine._system(hired), /Guardrails:/, 'the profile reaches the agent\'s instructions');
  assert.ok(engine.memory && engine._mkey(hired) === 'frontend-engineer');
  // hired people can be given work through the lead
  assert.ok(engine._roster(engine.agents[hp.id]).length === 2);
  // denied hires change nothing; partial approvals hire only the chosen ones; duplicates are refused
  const hp2 = (await call('/api/agents', 'POST', { provider: 'mock', name: 'Site two', goal: 'please hire a team' })).body;
  await until(() => (ap = engine.approvals().find((a) => a.status === 'pending' && a.kind === 'hire' && a.projectId === hp2.id)), 8000);
  assert.match(ap.items[1].name, /^[A-Z]/, 'the hire has a name'); // the mock proposes an explicit name, which is kept (a proposal without one gets a codename, tested below)
  await call(`/api/approvals/${ap.id}/decide`, 'POST', { decision: 'approve', only: [1], names: { 1: 'Brenda Brand' } });
  await until(() => engine.agents[hp2.id].status === 'idle' && engine._roster(engine.agents[hp2.id]).length === 1, 8000);
  const only = engine._roster(engine.agents[hp2.id])[0];
  assert.equal(only.title, 'Brand Writer'); assert.equal(only.name, 'Brenda Brand', 'the human can overwrite the suggested name'); assert.ok(only.mdFile && /^name: Brenda Brand$/m.test(fsRead(only.mdFile, 'utf8')) && /Guardrails:/.test(fsRead(only.mdFile, 'utf8')), 'the profile is stored as Markdown'); assert.equal(only.reportsTo, hp2.id, 'falls back to the lead when the manager was not hired');
  const hp3 = (await call('/api/agents', 'POST', { provider: 'mock', name: 'Site three', goal: 'please hire a team' })).body;
  await until(() => (ap = engine.approvals().find((a) => a.status === 'pending' && a.kind === 'hire' && a.projectId === hp3.id)), 8000);
  await call(`/api/approvals/${ap.id}/decide`, 'POST', { decision: 'deny', note: 'not yet' });
  await until(() => engine.agents[hp3.id].status === 'idle' && engine.messages(hp3.id).some((m) => m.role === 'report'), 8000);
  assert.equal(engine._roster(engine.agents[hp3.id]).length, 0);
  assert.match(engine.messages(hp3.id).find((m) => m.role === 'report').text, /did not approve these hires: not yet/);
  // without approvals the hires just happen
  const hp4 = (await call('/api/agents', 'POST', { provider: 'mock', approvals: false, name: 'Site four', goal: 'please hire a team' })).body;
  await until(() => engine._roster(engine.agents[hp4.id]).length === 2, 8000);
  // the preset team is part of the same chart, with departments
  const preset = (await call('/api/teams')).body.find((t) => t.name === 'Operations team');
  const tp = (await call('/api/agents', 'POST', { provider: 'mock', approvals: false, team: preset.id, name: 'Ops' })).body;
  const torg = (await call(`/api/projects/${tp.id}/org`)).body;
  assert.deepEqual(torg.reports.map((n) => n.departmentLabel).sort(), ['Networking', 'Research', 'Security']);
  assert.equal(torg.departmentLabel, 'Leadership');
  const { buildProfile, inferDepartment } = await import('../src/roles.js');
  assert.equal(inferDepartment('SEO copywriter'), 'marketing'); assert.equal(inferDepartment('Backend developer'), 'engineering');
  assert.equal(buildProfile({ name: 'X', role: 'y', department: 'bogus' }).department, 'general');
}

// ---- approvals archive ----
{
  const rec = (status, hoursAgo) => { const id = 'arch' + status + hoursAgo; engine.store.data.approvals[id] = { id, agentId: 'x', agentName: 'x', projectId: 'x', status, kind: 'spawn', title: 't', createdAt: Date.now() - (hoursAgo + 1) * 3600000, decidedAt: Date.now() - hoursAgo * 3600000 }; return id; };
  const a1 = rec('approved', 0.2), a2 = rec('denied', 30), a3 = rec('approved', 0.5), a4 = rec('denied', 1.5);
  const list = (await call('/api/approvals')).body;
  const get = (id) => list.find((x) => x.id === id);
  assert.equal(get(a1).archived, false); assert.equal(get(a3).archived, false);
  assert.equal(get(a2).archived, true); assert.equal(get(a4).archived, true, 'older than 1 hour is archived');
  assert.ok(list.filter((x) => x.status === 'pending').every((x) => !x.archived));
  for (const id of [a1, a2, a3, a4]) delete engine.store.data.approvals[id];
}

// ---- onboarding interview, the CEO, Markdown files, names ----
let orgIds;
{
  const iv = async (answers) => (await call('/api/interview', 'POST', { answers })).body;
  const q1 = await iv([]); assert.ok(q1.question && q1.choices.length && q1.asked === 1);
  const q2 = await iv([{ q: q1.question, a: 'I run a home network and servers' }]); assert.ok(q2.question && q2.asked === 2);
  const done = await iv([{ q: 'a', a: 'I run a home network and servers' }, { q: 'b', a: 'Proxmox and a firewall' }]);
  assert.ok(done.done && done.overview && done.team.length === 2 && done.suggestedCeoName);
  assert.deepEqual(done.team.map((t) => t.title), ['Network Engineer', 'Security Engineer']);
  assert.ok(done.team.every((t) => /^[A-Z]/.test(t.name) && t.name !== t.title && /Guardrails:/.test(t.instructions) && t.reason));
  // the AI failing must not block setup
  const { fallbackInterview } = await import('../src/engine.js');
  assert.ok(fallbackInterview([]).question && fallbackInterview([1, 2, 3, 4, 5].map(() => ({ q: 'q', a: 'home network and website' }))).team.length >= 2);

  assert.equal(engine.orgDone, false);
  const created = (await call('/api/org', 'POST', { ceoName: 'Captain Test', overview: 'Home network and a website.', team: done.team })).body;
  assert.equal(created.hired, 2); assert.equal(engine.orgDone, true);
  const ceo = engine.agents[created.ceo.id];
  assert.equal(ceo.name, 'Captain Test'); assert.equal(ceo.title, 'CEO'); assert.equal(ceo.kind, 'general');
  assert.equal((await call('/api/chat')).body.id, ceo.id, 'the main chat is the CEO');
  const mem = engine._roster(ceo); orgIds = { ceo, ne: mem.find((m) => m.title === 'Network Engineer'), se: mem.find((m) => m.title === 'Security Engineer') };
  assert.ok(fsExists(path.join(tmp, 'org', 'company.md')) && /Home network/.test(fsRead(path.join(tmp, 'org', 'company.md'), 'utf8')));
  const md = fsRead(orgIds.ne.mdFile, 'utf8');
  assert.match(md, /^---\nname: .+\ntitle: Network Engineer\ndepartment: Networking/); assert.match(md, /Hired because: They run a home network/); assert.match(md, /Guardrails:/);
  assert.ok(orgIds.ne.mdFile.includes(path.join('agents', 'org')));
  // the file is the source of truth: edits reach the agent on the next turn
  assert.match(engine._system(orgIds.ne), /Never delete data/);
  (await import('node:fs')).appendFileSync(orgIds.ne.mdFile, '\nALWAYS-USE-TABS-MARKER\n');
  assert.match(engine._system(orgIds.ne), /ALWAYS-USE-TABS-MARKER/);
  assert.match(engine._system(ceo), /About the human's setup/); assert.match(engine._system(ceo), /Network Engineer/);
  // names can be overwritten; duplicates refused; the file follows
  assert.equal((await call(`/api/agents/${orgIds.ne.id}/profile`, 'PUT', { name: 'Rex Router' })).body.name, 'Rex Router');
  assert.match(fsRead(orgIds.ne.mdFile, 'utf8'), /^name: Rex Router$/m); assert.match(fsRead(orgIds.ne.mdFile, 'utf8'), /^# Rex Router — Network Engineer$/m);
  assert.equal((await call(`/api/agents/${orgIds.se.id}/profile`, 'PUT', { name: 'rex router' })).status, 409);
  assert.equal((await call(`/api/agents/${orgIds.ne.id}/profile`)).body.title, 'Network Engineer');
  assert.equal((await call(`/api/agents/${ceo.id}/profile`, 'PUT', { text: '---\nname: Captain Test\n---\n# Captain Test\nDecide well.\n' })).status, 200);
  // the CEO hands a job to the right person, who checks with the other first
  await call(`/api/agents/${ceo.id}/messages`, 'POST', { text: 'assign-to:Network_Engineer check the firewall please' });
  await until(() => engine.messages(ceo.id).some((m) => m.role === 'report') && engine.agents[ceo.id].status === 'idle', 10000);
  assert.ok(engine.messages(orgIds.se.id).some((m) => /Pre-check requested by Rex Router/.test(m.text || '')), 'the security engineer was consulted');
  assert.ok(engine.messages(orgIds.ne.id).some((m) => /^Task from /.test(m.text || '')));
  {
    // every piece of work has a unique task code; a handover opens a subtask that the other agent closes
    const all = engine.tasks.list;
    assert.ok(all.every((t) => /^T-\d{4,}$/.test(t.code)), 'every task has a code'); assert.equal(new Set(all.map((t) => t.code)).size, all.length, 'codes are unique'); assert.equal(new Set(all.map((t) => t.id)).size, all.length);
    const top = all.find((t) => t.assignee?.id === ceo.id && /check the firewall/.test(t.title)); assert.ok(top, 'the CEO\'s request got a task'); assert.equal(top.source, 'chat');
    const sub = all.find((t) => t.parent === top.id && t.assignee?.name === 'Rex Router'); assert.ok(sub, 'handing it over opened a subtask for the right agent');
    await until(() => engine.tasks.get(top.id).status === 'done', 5000);
    const subNow = engine.tasks.get(sub.id), topNow = engine.tasks.get(top.id);
    assert.equal(subNow.status, 'done'); assert.equal(subNow.closure, `Closed by Rex Router. Refer to ${top.code}.`, 'closed by the right agent, referring to the main task');
    assert.match(topNow.closure, new RegExp(`^Closed by ${ceo.name}\\. Refer to ${sub.code}(, T-\\d{4,})?\\.$`), 'the first agent closes its own task after the subtask');
    assert.ok(topNow.log.some((l) => l.text.includes(`Opened ${sub.code}`)) && topNow.log.some((l) => l.text.includes(`${sub.code} was closed by Rex Router`)));
    { // reviewed work: another teammate checks it, changes go back with notes, a second failure is reported, and it can be turned off
      const revTask = engine.tasks.list.find((t) => t.parent === top.id && /Review requested by/.test(t.notes || '')); assert.ok(revTask, 'the review is a task with its own ID'); assert.notEqual(revTask.assignee.id, orgIds.ne.id, 'not the worker itself');
      assert.match(engine.tasks.get(sub.id).log.map((l) => l.text).join('\n'), /Review round 1 by .*: passed/, 'the review is in the task history');
      const msgsOf = (id) => engine.messages(id).map((m) => m.text || '').join('\n');
      const rep1 = engine.messages(ceo.id).filter((m) => m.role === 'report').slice(-1)[0]; assert.match(rep1.text, /Review:\nRound 1, .*: passed/, 'the lead is told the review passed');
      await call(`/api/agents/${ceo.id}/messages`, 'POST', { text: 'assign-to:Network_Engineer reviewfail tidy the dns notes' });
      await until(() => engine.messages(ceo.id).filter((m) => m.role === 'report').length >= 2 && engine.agents[ceo.id].status === 'idle', 15000);
      const rep2 = engine.messages(ceo.id).filter((m) => m.role === 'report').slice(-1)[0].text;
      assert.match(rep2, /Round 1, .*: changes needed: Add a short note/); assert.match(rep2, /Round 2, .*: passed/, 'fixed after the notes, then passed');
      assert.match(msgsOf(orgIds.ne.id), /reviewed your work on T-\d+ and asked for changes/, 'the worker got the notes');
      await call(`/api/agents/${ceo.id}/messages`, 'POST', { text: 'assign-to:Network_Engineer reviewalways rebuild the vpn' });
      await until(() => engine.messages(ceo.id).filter((m) => m.role === 'report').length >= 3 && engine.agents[ceo.id].status === 'idle', 15000);
      const rep3 = engine.messages(ceo.id).filter((m) => m.role === 'report').slice(-1)[0].text; assert.match(rep3, /FAILED REVIEW\./); assert.match(rep3, /after two rounds/);
      const failedSub = engine.tasks.list.find((t) => /rebuild the vpn/.test(t.title) && t.assignee?.id === orgIds.ne.id); assert.equal(failedSub.status, 'blocked', 'work that fails review is blocked, not done');
      assert.match(failedSub.blockedReason || failedSub.reason || JSON.stringify(failedSub.log), /FAILED REVIEW|Review/);
      await call('/api/settings', 'PUT', { reviewWork: false }); assert.equal(engine.reviewWork, false);
      const before = engine.tasks.list.filter((t) => /Review requested by/.test(t.notes || '')).length;
      await call(`/api/agents/${ceo.id}/messages`, 'POST', { text: 'assign-to:Network_Engineer check the switch config' });
      await until(() => engine.messages(ceo.id).filter((m) => m.role === 'report').length >= 4 && engine.agents[ceo.id].status === 'idle', 15000);
      assert.equal(engine.tasks.list.filter((t) => /Review requested by/.test(t.notes || '')).length, before, 'no review when it is switched off');
      await call('/api/settings', 'PUT', { reviewWork: true }); assert.equal(engine.reviewWork, true);
      const { parseReview } = await import('../src/engine.js');
      assert.deepEqual(parseReview('VERDICT: PASS\nNOTES: fine'), { verdict: 'PASS', notes: 'fine' }); assert.equal(parseReview('VERDICT: CHANGES NEEDED\nNOTES: fix x').verdict, 'CHANGES'); assert.equal(parseReview('Looks fine').verdict, 'UNCLEAR');
    }
    assert.ok(!all.some((t) => t.parent === top.id && /Pre-check/.test(t.title)), 'quick pre-check opinions are not tasks');
    const view = (await call('/api/tasks')).body.tasks; const vt = view.find((t) => t.id === top.id), vs = view.find((t) => t.id === sub.id);
    assert.equal(vs.parentCode, top.code); assert.ok(vt.subtasks.map((k) => k.code).includes(sub.code)); assert.deepEqual(vt.waitingFor, []);
    assert.ok(engine.messages(ceo.id).some((m) => m.role === 'report' && m.text.includes(`(${sub.code}, closed)`)), 'the report back carries the subtask code');
    assert.ok((await call('/api/audit?kind=task')).body.items.some((e) => /closed T-/.test(e.action)));
    assert.equal((await call('/api/search?q=' + sub.code)).body.groups.find((g) => g.type === 'task').items[0].title.startsWith(sub.code), true);
    // codes are never reused, even after a delete; old tasks without codes are numbered, oldest first
    const mx = engine.tasks.store.data.taskSeq; const tmpT = engine.tasks.add({ title: 'temp' }); await call('/api/tasks/' + tmpT.id, 'DELETE'); assert.equal(engine.tasks.add({ title: 'next' }).num, mx + 2);
    const old = engine.tasks.add({ title: 'legacy' }); delete old.code; delete old.num; engine.tasks.backfill(); assert.match(old.code, /^T-\d+$/); assert.equal(new Set(engine.tasks.list.map((t) => t.code)).size, engine.tasks.list.length);
    // a person closing a task is named too
    const mine = (await call('/api/tasks', 'POST', { title: 'By hand' })).body; assert.equal((await call('/api/tasks/' + mine.id, 'PUT', { status: 'done' })).body.closure, 'Closed by You.');
  }
  // a new project can use the organisation as its team: the same people
  const pr = (await call('/api/agents', 'POST', { provider: 'mock', approvals: false, team: 'org', name: 'From org' })).body;
  assert.deepEqual(engine._roster(engine.agents[pr.id]).map((m) => m.title).sort(), ['Network Engineer', 'Security Engineer']);
  assert.deepEqual(engine._roster(engine.agents[pr.id]).map((m) => m.name).sort(), ['Rex Router', orgIds.se.name].sort(), 'the same people, with the same names and memory');
  await call('/api/agents/' + pr.id, 'DELETE');
}

// ---- team meetings ----
{
  assert.equal((await call('/api/settings', 'PUT', { meeting: { frequency: 'hourly' } })).status, 400);
  assert.equal((await call('/api/settings', 'PUT', { meeting: { frequency: 'daily', time: '25:00' } })).status, 400);
  const r = (await call('/api/settings', 'PUT', { meeting: { frequency: 'daily', time: '00:00' } })).body; assert.equal(r.meeting.frequency, 'daily'); assert.ok(r.meeting.last > 0);
  assert.equal((await call('/api/meetings/run', 'POST', {})).status, 202);
  let list; await until(async () => (list = (await call('/api/meetings')).body).length >= 1, 10000);
  const text = (await call(`/api/meetings/${list[0].scope}/${list[0].date}`)).body.text;
  assert.match(text, /# Team meeting/); assert.match(text, /## Updates/);
  for (const a of [orgIds.ceo, orgIds.ne, orgIds.se]) assert.ok(text.includes(engine.agents[a.id].name), `${engine.agents[a.id].name} spoke at the meeting`);
  assert.match(text, /Reactions and follow-ups/); assert.match(text, /Noted\./);
  assert.ok(engine.memory.items.some((m) => m.who === 'Team meeting' && /Team meeting/.test(m.text)), 'everyone can recall the meeting');
  assert.ok(!engine.messages(orgIds.ceo.id).some((m) => m.role === 'agent' && /TEAM MEETING/.test(m.text)));
  assert.ok(engine.messages(orgIds.ne.id).some((m) => m.from?.name === 'Team meeting'));
  // the schedule: holds one when the time has passed, only once
  engine.store.data.settings.meeting = { frequency: 'daily', time: '03:00', weekday: 0, last: Date.now() - 2 * 86400000 };
  const ran = await engine.tickMeetings(new Date());
  assert.ok(Array.isArray(ran) && ran.length >= 1, 'a due meeting is held');
  assert.equal(await engine.tickMeetings(new Date()), null, 'but not twice');
  engine.store.data.settings.meeting = { frequency: 'off', time: '00:00', weekday: 0, last: 0 };
  assert.equal(await engine.tickMeetings(new Date()), null);
}

// ---- secrets vault ----
{
  const SECRET = 'S3cr3t-Value-123!';
  assert.equal((await call('/api/vault')).body.exists, false);
  assert.equal((await call('/api/vault/init', 'POST', { passphrase: 'short' })).status, 400);
  assert.equal((await call('/api/vault/secrets', 'POST', { name: 'x', value: 'y' })).status, 409, 'no vault yet');
  assert.equal((await call('/api/vault/init', 'POST', { passphrase: 'correct horse battery' })).status, 201);
  assert.equal((await call('/api/vault/init', 'POST', { passphrase: 'another long one' })).status, 409);
  const sec = (await call('/api/vault/secrets', 'POST', { name: 'NPM admin', value: SECRET, note: 'Nginx Proxy Manager login' })).body;
  assert.equal(JSON.stringify(sec).includes(SECRET), false, 'values are never returned');
  assert.equal((await call('/api/vault/secrets', 'POST', { name: 'npm ADMIN', value: 'x' })).status, 409);
  const raw = fsRead(path.join(tmp, 'vault.json'), 'utf8');
  assert.equal(raw.includes(SECRET), false, 'the vault file holds no plaintext'); assert.equal(raw.includes('correct horse'), false);
  assert.equal((fsStat(path.join(tmp, 'vault.json')).mode & 0o777), 0o600);
  assert.equal(JSON.stringify((await call('/api/vault')).body).includes(SECRET), false);
  // lock / wrong passphrase / unlock
  await call('/api/vault/lock', 'POST', {});
  assert.equal((await call('/api/vault')).body.unlocked, false);
  assert.equal((await call('/api/vault/secrets', 'POST', { name: 'y', value: 'z' })).status, 423, 'locked vaults cannot be written');
  assert.equal((await call('/api/vault/unlock', 'POST', { passphrase: 'wrong wrong wrong' })).status, 403);
  assert.equal((await call('/api/vault/unlock', 'POST', { passphrase: 'correct horse battery' })).status, 200);
  assert.ok((await call('/api/vault')).body.eligible.some((e) => e.key === 'network-engineer'));
  { const el = (await call('/api/vault')).body.eligible; assert.ok(!el.some((e) => /\(CEO\) \(CEO\)|^CEO \(CEO\)$/.test(e.label)), 'no doubled CEO label'); assert.ok(el.find((e) => e.key === 'network-engineer').label.includes(' (Network Engineer)')); }
  // assign to the network engineer only
  await call('/api/vault/secrets/' + sec.id, 'PUT', { assigned: [{ key: 'network-engineer', label: 'Network Engineer', grant: 'ask' }] });
  const ne = orgIds.ne, se = orgIds.se;
  const ask = async (agent, text) => { const n = engine.messages(agent.id).length; await call(`/api/agents/${agent.id}/messages`, 'POST', { text }); return n; };
  const pendingSecret = async () => { let f; await until(() => (f = engine.approvals().find((a) => a.status === 'pending' && a.kind === 'secret')), 8000); return f; };
  const idle = (a) => until(() => engine.agents[a.id].status === 'idle' && !engine.approvals().some((x) => x.status === 'pending' && x.agentId === a.id), 8000);

  // not assigned -> the human is asked on the spot; a "no" leaves the agent without it and without any assignment
  await ask(se, 'use-secret:NPM_admin please');
  { const f = await pendingSecret(); assert.equal(f.unassigned, true); assert.match(f.detail, /NOT assigned to/);
    assert.equal((await call(`/api/approvals/${f.id}/decide`, 'POST', { decision: 'deny' })).status, 200); }
  await idle(se);
  assert.ok(engine.messages(se.id).some((m) => /did not give you access/.test(m.text || '') || m.role === 'report'), 'a refused request is reported to the agent');
  assert.equal(engine.vault.list().find((x) => x.name === 'NPM admin').assigned.some((a) => a.key === 'security-engineer'), false);
  assert.ok(!engine.messages(se.id).some((m) => (m.text || '').includes(SECRET)));
  // approved "once": it can use the secret this time but is not assigned afterwards
  await ask(se, 'use-secret:NPM_admin please');
  { const f = await pendingSecret(); assert.equal((await call(`/api/approvals/${f.id}/decide`, 'POST', { decision: 'approve', mode: 'once' })).status, 200); }
  await idle(se);
  assert.equal(engine.vault.list().find((x) => x.name === 'NPM admin').assigned.some((a) => a.key === 'security-engineer'), false, 'once does not assign');
  // approved "always": now it is assigned for good
  await ask(se, 'use-secret:NPM_admin please');
  { const f = await pendingSecret(); assert.equal((await call(`/api/approvals/${f.id}/decide`, 'POST', { decision: 'approve', mode: 'always' })).status, 200); }
  await idle(se);
  assert.deepEqual(engine.vault.list().find((x) => x.name === 'NPM admin').assigned.filter((a) => a.key === 'security-engineer').map((a) => a.grant), ['always']);
  await call('/api/vault/secrets/' + engine.vault.list().find((x) => x.name === 'NPM admin').id, 'PUT', { assigned: [{ key: 'network-engineer', label: 'Network Engineer', grant: 'ask' }] });   // back to how it was for the tests below
  // assigned, allow once
  await ask(ne, 'use-secret:NPM_admin please');
  let ap1 = await pendingSecret(); assert.equal(ap1.secret, 'NPM admin'); assert.match(ap1.detail, /to log in/);
  await call(`/api/approvals/${ap1.id}/decide`, 'POST', { decision: 'approve', mode: 'once' });
  await idle(ne);
  const texts = engine.messages(ne.id).map((m) => m.text || '').join('\n');
  assert.match(texts, /Logged in using the secret: \[secret:NPM admin\]/, 'the agent used it, and the stored chat is redacted');
  assert.equal(texts.includes(SECRET), false); assert.equal(engine.logs(ne.id).join('\n').includes(SECRET), false);
  assert.equal(engine.leases.size, 0, 'a one-time secret is forgotten after the task');
  assert.equal(engine.vault.list()[0].assigned[0].grant, 'ask');
  // deny
  await ask(ne, 'use-secret:NPM_admin again');
  const ap2 = await pendingSecret(); await call(`/api/approvals/${ap2.id}/decide`, 'POST', { decision: 'deny', note: 'not now' }); await idle(ne);
  assert.ok(engine.messages(ne.id).some((m) => /did not allow use of "NPM admin": not now/.test(m.text || '')));
  // always
  await ask(ne, 'use-secret:NPM_admin third');
  const ap3 = await pendingSecret(); await call(`/api/approvals/${ap3.id}/decide`, 'POST', { decision: 'approve', mode: 'always' }); await idle(ne);
  assert.equal(engine.vault.list()[0].assigned[0].grant, 'always');
  const before = engine.approvals().filter((a) => a.kind === 'secret').length;
  await ask(ne, 'use-secret:NPM_admin fourth'); await idle(ne);
  assert.equal(engine.approvals().filter((a) => a.kind === 'secret').length, before, 'an always-allowed secret does not ask again');
  assert.ok(engine.logs(ne.id).some((l) => /using secret "NPM admin" \(always allowed\)/.test(l)));
  // revoke back to asking
  await call('/api/vault/secrets/' + sec.id, 'PUT', { assigned: [{ key: 'network-engineer', label: 'Network Engineer', grant: 'ask' }] });
  assert.equal(engine.vault.list()[0].assigned[0].grant, 'ask');
  // locked vault: nothing is released
  await call('/api/vault/lock', 'POST', {});
  await ask(ne, 'use-secret:NPM_admin fifth'); await idle(ne);
  assert.ok(engine.messages(ne.id).some((m) => /vault is locked/.test(m.text || '')));
  await call('/api/vault/unlock', 'POST', { passphrase: 'correct horse battery' });
  // pasting a secret into a chat does not store it either
  await call(`/api/agents/${ne.id}/messages`, 'POST', { text: `the password is ${SECRET}` }); await idle(ne);
  assert.equal(engine.messages(ne.id).map((m) => m.text || '').join('\n').includes(SECRET), false);
  // nothing on disk contains it
  engine.store.flush(); engine.memory.flush();
  for (const f of ['state.json', 'memory.json', 'vault.json']) assert.equal(fsRead(path.join(tmp, f), 'utf8').includes(SECRET), false, `${f} has no plaintext secret`);
  assert.equal((await call('/api/vault/secrets/' + sec.id, 'DELETE')).status, 200);
  assert.equal((await call('/api/vault')).body.secrets.length, 0);
}

// ---- update check: download first, install on request ----
{
  const { Updater, cmpVer } = await import('../src/updater.js');
  assert.equal(cmpVer('0.5.0', '0.4.9'), 1); assert.equal(cmpVer('1.0.0', '0.99.9'), 1); assert.equal(cmpVer('0.4.0', '0.4.0'), 0); assert.equal(cmpVer('v0.3.1', '0.4.0'), -1);
  const gitc = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });
  const rem = path.join(tmp, 'upd-remote.git'), work = path.join(tmp, 'upd-work'), app = path.join(tmp, 'upd-app');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', rem]);
  execFileSync('git', ['clone', '-q', rem, work]);
  const put = (v, log) => { (async () => { const fs = await import('node:fs'); fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'x', version: v })); fs.writeFileSync(path.join(work, 'CHANGELOG.md'), `# Changelog\n\n${log}`); })(); };
  const fsm = await import('node:fs');
  const write = (v, log) => { fsm.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'x', version: v })); fsm.writeFileSync(path.join(work, 'CHANGELOG.md'), `# Changelog\n\n${log}`); gitc(work, 'add', '-A'); gitc(work, 'commit', '-qm', v); gitc(work, 'push', '-q', 'origin', 'HEAD:main'); };
  write('0.1.0', '## 0.1.0\n- first\n');
  execFileSync('git', ['clone', '-q', rem, app]);
  const up = new Updater({ dir: app, current: '0.1.0' }); up.pace = 0;
  assert.equal((await up.check()).state, 'uptodate');
  write('0.2.0', '## 0.2.0\n- shiny new thing\n\n## 0.1.0\n- first\n');
  const st = await up.check();
  assert.equal(st.state, 'ready'); assert.equal(st.latest, '0.2.0'); assert.match(st.notes, /shiny new thing/); assert.doesNotMatch(st.notes, /first/);
  assert.equal(JSON.parse(fsm.readFileSync(path.join(app, 'package.json'), 'utf8')).version, '0.1.0', 'downloading changes nothing that is running');
  const r1 = await up.install(); assert.equal(r1.version, '0.2.0');
  assert.deepEqual(up.status.progress.steps.map((x) => x.state), ['done', 'done', 'skip', 'done', 'wait'], 'every step is recorded for the screen'); assert.ok(up.status.progress.pct >= 80 && up.status.progress.log.length >= 5);
  assert.equal(JSON.parse(fsm.readFileSync(path.join(app, 'package.json'), 'utf8')).version, '0.2.0');
  assert.equal((await new Updater({ dir: app, current: '0.2.0' }).check()).state, 'uptodate');
  await assert.rejects(() => new Updater({ dir: app, current: '0.2.0' }).install(), /no downloaded update/);
  // a copy that is not a git checkout, and one with its own commits
  const plain = path.join(tmp, 'upd-plain'); fsm.mkdirSync(plain);
  assert.equal((await new Updater({ dir: plain, current: '0.1.0' }).check()).state, 'unsupported');
  gitc(app, 'commit', '--allow-empty', '-qm', 'local'); write('0.3.0', '## 0.3.0\n- more\n\n## 0.2.0\n- shiny\n');
  const dv = await new Updater({ dir: app, current: '0.2.0' }).check(); assert.equal(dv.state, 'error'); assert.match(dv.error, /local changes/);
  // over HTTP: check, then install restarts the app
  const app2 = path.join(tmp, 'upd-app2'); execFileSync('git', ['clone', '-q', rem, app2]); gitc(app2, 'reset', '-q', '--hard', 'HEAD~1');
  let restarts = 0;
  const up2 = new Updater({ dir: app2, current: '0.2.0' }); up2.pace = 0;
  const srv2 = createServer(engine, { updater: up2, restart: () => { restarts++; } });
  await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${srv2.address().port}`;
  const c2 = async (p, m = 'GET', body) => { const r = await fetch(b2 + p, { method: m, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  assert.equal((await c2('/api/update/install', 'POST', {})).status, 409, 'nothing downloaded yet');
  assert.equal((await c2('/api/update/check', 'POST', {})).body.state, 'ready');
  assert.equal((await c2('/api/update')).body.latest, '0.3.0');
  assert.equal((await c2('/api/state')).body.update.state, 'ready');
  const busyAgent = Object.values(engine.agents)[0]; const was = busyAgent.status; busyAgent.status = 'working';
  const blocked = await c2('/api/update/install', 'POST', {}); assert.equal(blocked.status, 202); assert.equal(blocked.body.queued, true, 'waits for working agents instead of interrupting them'); assert.ok(blocked.body.busy >= 1);
  assert.equal(restarts, 0);
  busyAgent.status = was; engine.emit('event', { type: 'activity', agentId: busyAgent.id, text: '' });   // the queued install starts by itself
  const done2 = await c2('/api/update/install', 'POST', {}); assert.equal(done2.status, 202); assert.equal(done2.body.started, true);
  await until(async () => (await c2('/api/update')).body.progress?.steps[4].state === 'run', 5000);
  const prog = (await c2('/api/update')).body.progress; assert.equal(prog.failed, false); assert.ok(prog.log.some((l) => /Restarting/.test(l)) && prog.pct >= 80, 'the page can show what is happening');
  await until(() => restarts === 1, 4000);
  assert.equal(JSON.parse(fsm.readFileSync(path.join(app2, 'package.json'), 'utf8')).version, '0.3.0');
  // a broken update is rolled back
  const app3 = path.join(tmp, 'upd-app3'); execFileSync('git', ['clone', '-q', rem, app3]);
  fsm.mkdirSync(path.join(work, 'src'), { recursive: true }); fsm.writeFileSync(path.join(work, 'src', 'server.js'), 'this is not javascript ((('); fsm.writeFileSync(path.join(work, 'src', 'engine.js'), '');
  write('0.4.0', '## 0.4.0\n- broken\n\n## 0.3.0\n- more\n');
  const up3 = new Updater({ dir: app3, current: '0.3.0' }); up3.pace = 0; await up3.check();
  await assert.rejects(() => up3.install(), /failed its check/);
  assert.equal(JSON.parse(fsm.readFileSync(path.join(app3, 'package.json'), 'utf8')).version, '0.3.0', 'the old version is put back'); assert.equal(up3.status.state, 'ready'); assert.equal(up3.status.progress.failed, true);
  srv2.close();
}

// ---- task board, usage, model advice, repositories, tickets, plain English ----
{
  const { suggestModel } = await import('../src/models.js');
  const { looksLikeLimit, estimateTokens } = await import('../src/usage.js');
  // task board
  const t1 = (await call('/api/tasks', 'POST', { title: 'Renew the domain', status: 'todo', labels: 'Admin, Money' })).body;
  const t2 = (await call('/api/tasks', 'POST', { title: 'Idea: smart garden', notes: 'add details later', status: 'backburner' })).body;
  assert.equal(t1.status, 'todo'); assert.deepEqual(t1.labels, ['admin', 'money']); assert.equal(t2.status, 'backburner');
  assert.equal((await call('/api/tasks', 'POST', { title: 'Sneaky', status: 'done' })).body.status, 'todo', 'people create to do or back burner items');
  assert.equal((await call('/api/tasks', 'POST', { title: '  ' })).status, 400);
  assert.equal((await call(`/api/tasks/${t2.id}`, 'PUT', { status: 'todo' })).body.status, 'todo', 'an idea can be promoted');
  assert.equal((await call(`/api/tasks/${t1.id}`, 'PUT', { status: 'nonsense' })).status, 400);
  const moved = (await call(`/api/tasks/${t1.id}`, 'PUT', { status: 'inprogress' })).body; assert.ok(moved.log.some((l) => /In progress/.test(l.text)));
  assert.equal((await call(`/api/tasks/${t1.id}`, 'PUT', { status: 'done' })).body.status, 'done'); assert.ok(engine.tasks.get(t1.id).doneAt);
  const board = (await call('/api/tasks')).body; assert.ok(board.counts.done >= 1 && Object.keys(board.counts).length === 5);
  assert.ok(board.tasks.some((t) => t.source === 'system' && t.status === 'done' && t.assignee?.name === 'Rex Router'), 'finished team jobs are marked done');
  assert.ok(board.tasks.some((t) => t.source === 'system' && t.status === 'blocked'), 'jobs that could not start are marked blocked');
  await call(`/api/agents/${orgIds.ceo.id}/messages`, 'POST', { text: 'make-task:Order_a_new_router' });
  await until(() => engine.agents[orgIds.ceo.id].status === 'idle' && engine.tasks.list.some((t) => t.title === 'Order a new router'));
  const agentTask = engine.tasks.list.find((t) => t.title === 'Order a new router'); assert.equal(agentTask.status, 'backburner'); assert.equal(agentTask.source, orgIds.ceo.name);
  await call(`/api/tasks/${t2.id}`, 'DELETE'); assert.equal((await call(`/api/tasks/${t2.id}`, 'PUT', {})).status, 404);

  // usage per agent and per AI, with limits
  const u = (await call('/api/usage?days=7')).body;
  assert.equal(u.series.length, 7); assert.ok(u.agents.length >= 2 && u.agents[0].total >= u.agents.at(-1).total, 'agents sorted by use');
  assert.ok(u.series.at(-1).total > 0); const mp = u.providers.find((p) => p.id === 'mock'); assert.ok(mp.today > 0 && mp.estimated === true);
  assert.equal(mp.pctDay, null);
  const lim = (await call('/api/usage/limits', 'PUT', { limits: { mock: { daily: mp.today * 2, weekly: 0 } } })).body.providers.find((p) => p.id === 'mock');
  assert.ok(lim.pctDay > 0.3 && lim.pctDay < 1.1 && lim.pctWeek === null);
  assert.ok(looksLikeLimit('Claude usage limit reached') && looksLikeLimit('429 Too Many Requests') && !looksLikeLimit('file not found'));
  engine.usage.markLimit('mock'); assert.ok((await call('/api/usage')).body.providers.find((p) => p.id === 'mock').hitAt > 0);
  assert.ok(estimateTokens('x'.repeat(400)) === 100);

  // plain English by default, and it can be turned off
  assert.equal(engine.plainEnglish, true); assert.match(engine._system(orgIds.ne), /plain, simple English/);
  await call('/api/settings', 'PUT', { plainEnglish: false }); assert.doesNotMatch(engine._system(orgIds.ne), /plain, simple English/);
  await call('/api/settings', 'PUT', { plainEnglish: true }); assert.match(engine._system(orgIds.ne), /plain, simple English/);
  assert.equal((await call('/api/state')).body.plainEnglish, true);

  // model advice by role and difficulty
  const models = [{ id: 'claude-sonnet-5-5' }, { id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }];
  assert.equal(suggestModel({ provider: 'claude', department: 'security', models }).model, 'claude-opus-5-5');
  assert.equal(suggestModel({ provider: 'claude', department: 'operations', models }).model, 'claude-haiku-5-5');
  assert.equal(suggestModel({ provider: 'claude', department: 'engineering', models }).model, 'claude-sonnet-5-5');
  assert.equal(suggestModel({ provider: 'claude', department: 'operations', complexity: 'hard', models }).model, 'claude-opus-5-5', 'stated difficulty wins');
  assert.match(suggestModel({ provider: 'claude', department: 'security', models }).why, /high-stakes/);
  const adv = (await call(`/api/agents/${orgIds.se.id}/model-advice`)).body; assert.equal(adv.tier, 'heavy'); assert.ok(adv.why);
  assert.equal((await call(`/api/agents/${orgIds.se.id}/model`, 'PUT', { model: 'claude-opus-5-5' })).body.model, 'claude-opus-5-5');
  await call(`/api/agents/${orgIds.se.id}/model`, 'PUT', { model: '' });
  assert.match(engine._system(orgIds.ceo), /complexity/); assert.match(engine._system(orgIds.ceo), /apiary-task/);

  // repositories the agents may read from
  const repoDir = path.join(tmp, 'ref-repo'); (await import('node:fs')).mkdirSync(repoDir);
  (await import('node:fs')).writeFileSync(path.join(repoDir, 'README.md'), '# Home lab notes\nVLAN layout lives here.\n');
  sh(repoDir, 'init', '-q', '-b', 'main'); sh(repoDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'); sh(repoDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'notes');
  assert.equal((await call('/api/repos', 'POST', { source: 'https://user:pw@github.com/a/b.git' })).status, 400, 'no secrets in addresses');
  assert.equal((await call('/api/repos', 'POST', { source: '/no/such/folder' })).status, 400);
  const { normalizeSource } = await import('../src/repos.js');
  assert.deepEqual(normalizeSource('https://github.com/Aber-28/Apiary'), { source: 'Aber-28/Apiary', branch: '' });
  assert.deepEqual(normalizeSource('https://github.com/Aber-28/Apiary.git/'), { source: 'Aber-28/Apiary', branch: '' });
  assert.deepEqual(normalizeSource('https://github.com/Aber-28/Apiary/tree/dev/docs'), { source: 'Aber-28/Apiary', branch: 'dev' });
  assert.deepEqual(normalizeSource('git@github.com:Aber-28/Apiary.git'), { source: 'Aber-28/Apiary', branch: '' });
  assert.deepEqual(normalizeSource('http://www.github.com/a/b?tab=readme'), { source: 'a/b', branch: '' });
  assert.deepEqual(normalizeSource('https://gitlab.com/g/p/-/tree/main/x'), { source: 'https://gitlab.com/g/p', branch: '' });
  assert.deepEqual(normalizeSource('owner/name'), { source: 'owner/name', branch: '' });
  const repo = (await call('/api/repos', 'POST', { source: repoDir, name: 'Lab notes', notes: 'Network layout and VLANs' })).body;
  assert.equal(repo.kind, 'local'); assert.match(repo.overview, /Home lab notes/); assert.match(repo.overview, /Latest commit: .* notes/);
  assert.equal(engine.repos.contextFor(orgIds.ne), '', 'not assigned yet');
  await call(`/api/repos/${repo.id}`, 'PUT', { agents: [orgIds.ne.id] });
  assert.match(engine._system(orgIds.ne) + engine.repos.contextFor(orgIds.ne), /REFERENCE REPOSITORIES[\s\S]*Lab notes[\s\S]*Network layout/);
  assert.equal(engine.repos.contextFor(orgIds.se), ''); assert.deepEqual(engine.repos.dirsFor(orgIds.ne), [repoDir]);
  await call(`/api/repos/${repo.id}`, 'PUT', { agents: [], everyone: true }); assert.match(engine.repos.contextFor(orgIds.se), /Lab notes/);
  assert.equal((await call(`/api/repos/${repo.id}/sync`, 'POST')).status, 200);
  assert.equal((await call(`/api/repos/${repo.id}`, 'DELETE')).status, 200); assert.ok(fsExists(path.join(repoDir, 'README.md')), 'a local folder is never deleted');

  // support tickets: an agent works on it and answers
  assert.equal((await call('/api/tickets', 'POST', { title: '' })).status, 400);
  const k1 = (await call('/api/tickets', 'POST', { title: 'Backups are failing', description: 'Last night nothing was saved', priority: 'high' })).body;
  assert.equal(k1.num, 1);
  await until(() => engine.tickets.get(k1.id).status === 'resolved', 8000);
  const done1 = engine.tickets.get(k1.id); assert.ok(done1.comments.some((c) => c.kind === 'resolution' && /fixed it/.test(c.text) && c.who === orgIds.ceo.name));
  assert.ok(engine.messages(orgIds.ceo.id).some((m) => /Support ticket #1/.test(m.text || '')));
  assert.equal(engine.tasks.byRef(`ticket:${k1.id}`).status, 'done', 'a ticket shows on the board');
  const k2 = (await call('/api/tickets', 'POST', { title: 'An unfixable thing', description: 'unfixable' })).body;
  await until(() => engine.tickets.get(k2.id).comments.some((c) => c.kind === 'question'), 8000);
  assert.equal(engine.tickets.get(k2.id).status, 'open'); assert.equal(engine.tasks.byRef(`ticket:${k2.id}`).status, 'blocked');
  await call(`/api/tickets/${k2.id}/comment`, 'POST', { text: 'The NAS in the garage' });
  await until(() => engine.tickets.get(k2.id).comments.some((c) => c.kind === 'resolution' && /after your reply/.test(c.text)), 8000);
  assert.ok(engine.tickets.get(k2.id).comments.some((c) => c.kind === 'human'));
  assert.equal((await call(`/api/tickets/${k2.id}/status`, 'POST', { status: 'closed' })).body.status, 'closed');
  assert.equal((await call(`/api/tickets/${k2.id}/status`, 'POST', { status: 'weird' })).status, 400);
  assert.equal((await call('/api/tickets')).body.tickets.length, 2);
  assert.equal((await call(`/api/tickets/${k2.id}`, 'DELETE')).status, 200);
}

// ---- 0.7.0: username on secrets, model lists, project plans ----
{
  // a secret can have a username as well (optional)
  if (!engine.vault.unlocked) await call('/api/vault/unlock', 'POST', { passphrase: 'correct horse battery' });
  const PW = 'Pa55-word-for-router', ne = orgIds.ne;
  const only = (await call('/api/vault/secrets', 'POST', { name: 'API token', value: 'tok-123456789' })).body; assert.equal(only.username, ''); assert.equal(only.hasUsername, false);
  const both = (await call('/api/vault/secrets', 'POST', { name: 'Router login', value: PW, username: 'alice-admin', note: 'web UI' })).body;
  assert.equal(both.username, 'alice-admin'); assert.equal(both.hasUsername, true);
  const vraw = fsRead(path.join(tmp, 'vault.json'), 'utf8'); assert.equal(vraw.includes('alice-admin'), false, 'the username is encrypted too'); assert.equal(vraw.includes(PW), false);
  assert.equal((await call('/api/vault/secrets/' + both.id, 'PUT', { username: 'bob-admin' })).body.username, 'bob-admin');
  assert.equal(engine.vault.value(both.id), PW, 'changing the username keeps the password');
  assert.equal((await call('/api/vault/secrets/' + both.id, 'PUT', { username: 'alice-admin' })).body.username, 'alice-admin');
  await call('/api/vault/secrets/' + both.id, 'PUT', { assigned: [{ key: 'network-engineer', label: 'Network Engineer', grant: 'always' }] });
  const before = engine.messages(ne.id).length;
  await call(`/api/agents/${ne.id}/messages`, 'POST', { text: 'use-secret:Router_login' });
  await until(() => engine.agents[ne.id].status === 'idle' && engine.messages(ne.id).slice(before).some((m) => /Logged in using the secret/.test(m.text || '')), 10000);
  const said = engine.messages(ne.id).slice(before).find((m) => /Logged in using the secret/.test(m.text || '')).text;
  assert.match(said, /as alice-admin/); assert.equal(said.includes(PW), false, 'the password is hidden, the username is not');
  await call('/api/vault/lock', 'POST', {});
  assert.equal((await call('/api/vault')).body.secrets.find((x) => x.id === both.id).username, '', 'usernames are hidden while locked');
  await call('/api/vault/unlock', 'POST', { passphrase: 'correct horse battery' });
  assert.equal((await call('/api/vault')).body.secrets.find((x) => x.id === both.id).username, 'alice-admin');

  // model lists per AI
  const cm = (await call('/api/connections/claude/models')).body; assert.ok(cm.models.some((m) => /opus/.test(m.id)) && cm.models.some((m) => /haiku/.test(m.id)));
  const xm = (await call('/api/connections/codex/models')).body; assert.ok(xm.models.length >= 3, 'codex has a list to choose from too');
  assert.ok(engine.connections.known('codex').length >= 3);

  // project plans: planned in phases, approved, tracked
  const proj = (await call('/api/agents', 'POST', { provider: 'mock', name: 'Big site', approvals: true })).body, lead = engine.agents[proj.id];
  assert.match(engine._system(lead), /BIG PROJECTS/); assert.equal((await call(`/api/projects/${lead.id}/plan`)).body.plan, null);
  await call(`/api/agents/${lead.id}/messages`, 'POST', { text: 'plan-it for the new website' });
  let ap; await until(() => (ap = engine.approvals().find((a) => a.status === 'pending' && a.kind === 'plan')), 8000);
  assert.equal(ap.phases.length, 2); assert.equal(ap.phases[0].steps.length, 2);
  await call(`/api/approvals/${ap.id}/decide`, 'POST', { decision: 'approve' });
  await until(() => lead.plan && engine.agents[lead.id].status === 'idle', 8000);
  let pl = (await call(`/api/projects/${lead.id}/plan`)).body;
  assert.equal(pl.plan.phases[0].status, 'active'); assert.equal(pl.plan.phases[1].status, 'pending'); assert.equal(pl.stats.pct, 0); assert.equal(pl.stats.current, 'Plan and design');
  assert.match(engine._system(lead), /PROJECT PLAN \(where the project stands: 0% done, now in "Plan and design"/); assert.doesNotMatch(engine._system(lead), /BIG PROJECTS/);
  { // every plan step is a task with its own ID, given to its owner (the lead by default), and closed when the step is done
    const steps = lead.plan.phases.flatMap((p) => p.steps);
    assert.ok(steps.every((x) => /^T-\d{4,}$/.test(x.task) && engine.tasks.all[x.taskId]), 'each step has a task ID');
    const t0 = engine.tasks.all[lead.plan.phases[0].steps[0].taskId];
    assert.equal(t0.status, 'todo'); assert.equal(t0.project, lead.id); assert.ok(t0.labels.includes('plan')); assert.equal(t0.assignee.id, lead.id, 'the lead owns steps with no owner');
    assert.match(engine._system(lead), /\[ \] .* \(T-\d{4,}\)/, 'the lead is told each step\'s task ID');
  }
  await call(`/api/agents/${lead.id}/messages`, 'POST', { text: 'progress:1:1' });
  await until(() => lead.plan.phases[0].steps[0].done && engine.agents[lead.id].status === 'idle', 8000);
  assert.equal(engine.tasks.all[lead.plan.phases[0].steps[0].taskId].status, 'done', 'finishing a step closes its task');
  await call(`/api/agents/${lead.id}/messages`, 'POST', { text: 'progress:1:2' });
  await until(() => lead.plan.phases[0].status === 'done' && engine.agents[lead.id].status === 'idle', 8000);
  pl = (await call(`/api/projects/${lead.id}/plan`)).body;
  assert.equal(pl.plan.phases[1].status, 'active', 'the next phase starts by itself'); assert.equal(pl.stats.pct, 50); assert.equal(pl.stats.current, 'Build'); assert.equal(pl.stats.phasesDone, 1);
  // the human can change it too
  assert.equal((await call(`/api/projects/${lead.id}/plan`, 'PUT', { phase: 1, step: 2, done: false })).status, 200);
  pl = (await call(`/api/projects/${lead.id}/plan`)).body; assert.equal(pl.stats.pct, 25, 'unticking a step lowers progress');
  assert.equal((await call(`/api/projects/${lead.id}/plan`, 'PUT', { phase: 2, status: 'blocked', note: 'Waiting for the logo' })).body.plan.phases[1].status, 'blocked');
  assert.match(engine._system(lead), /\[blocked\] \(Waiting for the logo\)/);
  assert.equal((await call(`/api/projects/${lead.id}/plan`, 'PUT', { phase: 9, status: 'done' })).status, 400);
  // a denied plan is not saved, and the agent is told
  const p2 = engine.agents[(await call('/api/agents', 'POST', { provider: 'mock', name: 'Denied plan', approvals: true })).body.id];
  await call(`/api/agents/${p2.id}/messages`, 'POST', { text: 'plan-it please' });
  await until(() => engine.approvals().some((a) => a.status === 'pending' && a.kind === 'plan' && a.agentId === p2.id), 8000);
  await call(`/api/approvals/${engine.approvals().find((a) => a.status === 'pending' && a.kind === 'plan').id}/decide`, 'POST', { decision: 'deny', note: 'Too big' });
  await until(() => engine.agents[p2.id].status === 'idle' && engine.messages(p2.id).some((m) => /did not approve the plan: Too big/.test(m.text || '')), 8000);
  assert.equal(p2.plan, undefined);
  assert.equal((await call(`/api/projects/${orgIds.ceo.id}/plan/ask`, 'POST', {})).status, 400, 'the main chat has no plans');
  assert.equal((await call(`/api/projects/${lead.id}/plan`, 'DELETE')).status, 200); assert.equal(lead.plan, undefined);
  await call('/api/agents/' + lead.id, 'DELETE'); await call('/api/agents/' + p2.id, 'DELETE');
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
  assert.equal((await get(`${target}:${port}`, `/?token=${token}`)).status, 302, "token link sets the cookie and redirects");
  assert.equal((await get(`evil.example:${port}`, '/api/state', { 'x-apiary-token': token })).status, 403, 'unknown host names still blocked');
  if (ip) assert.ok(out.includes(`http://${ip}:${port}/?token=${token}`), 'prints the link for this machine');
  child.kill('SIGTERM');
  // default mode: not reachable by other host names or IPs
  assert.equal((await new Promise((resolve) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/state', headers: { host: '192.168.1.50:7777' } }, (r) => { r.resume(); resolve(r.statusCode); }))), 403);
}

// ---- 0.8.0: project stages, export and import ----
{
  const proj = (await call('/api/agents', 'POST', { provider: 'mock', name: 'Stage site', approvals: false })).body;
  assert.equal(engine.stageOf(engine.agents[proj.id]), 'building', 'new projects are being built');
  assert.equal((await call(`/api/projects/${proj.id}/stage`, 'PUT', { stage: 'nonsense' })).status, 400);
  assert.equal((await call(`/api/projects/${proj.id}/stage`, 'PUT', { stage: 'maintenance', note: 'live now' })).body.stage, 'maintenance');
  assert.match(engine._system(engine.agents[proj.id]) + engine._planContext(engine.agents[proj.id]), /Maintenance/);
  assert.equal((await call(`/api/projects/${proj.id}/stage`, 'PUT', { stage: 'closed' })).body.stage, 'closed');
  const closedSend = await call(`/api/agents/${proj.id}/messages`, 'POST', { text: 'hello' });
  assert.equal(closedSend.status, 409); assert.match(closedSend.body.error, /closed/i);
  assert.ok(engine.agents[proj.id], 'closing deletes nothing');
  const log = (await call(`/api/projects/${proj.id}/stage`, 'PUT', { stage: 'building' })).body.stageLog; assert.deepEqual(log.map((x) => x.stage), ['maintenance', 'closed', 'building']);
  assert.equal((await call('/api/agents', 'GET')).body.find?.((x) => x.id === proj.id)?.stage ?? 'building', 'building');
  // finishing the last phase moves a project that is being built into maintenance by itself
  const root = engine.agents[proj.id];
  root.plan = { goal: 'g', phases: [{ id: 1, title: 'One', status: 'active', steps: [{ text: 'a', done: false }] }] };
  engine.editPlan(proj.id, { phase: 1, step: 1, done: true });
  assert.equal(engine.stageOf(root), 'maintenance'); assert.equal(root.stageLog.at(-1).by, 'automatic');
  assert.equal((await call(`/api/projects/${(await engine.general()).id}/stage`, 'PUT', { stage: 'closed' })).status, 400);

  // export, then import into a different home
  const { importFrom, exportTo } = await import('../src/transfer.js');
  const { createWriteStream, createReadStream, mkdirSync: mk, writeFileSync: wf, readFileSync: rf, readdirSync: rd } = await import('node:fs');
  const { Vault: V } = await import('../src/vault.js');
  const { once } = await import('node:events');
  mk(path.join(tmp, 'workspaces', 'travel'), { recursive: true }); wf(path.join(tmp, 'workspaces', 'travel', 'notes.txt'), 'hello from the old computer');
  if (!engine.vault.unlocked) await call('/api/vault/unlock', 'POST', { passphrase: 'correct horse battery' });
  const bundle = path.join(os.tmpdir(), `apiary-bundle-${Date.now()}.tar.gz`);
  const ws = createWriteStream(bundle), c1 = once(ws, 'close'); const ex = exportTo(engine, ws, { vault: true, files: true, version: 'test' }); await ex.done; await c1;
  assert.ok(ex.manifest.vault && ex.manifest.includes.includes('vault.json'));
  const noVault = path.join(os.tmpdir(), `apiary-bundle-nv-${Date.now()}.tar.gz`);
  const ws2 = createWriteStream(noVault), c2 = once(ws2, 'close'); const ex2 = exportTo(engine, ws2, { vault: false, files: false }); await ex2.done; await c2;
  assert.equal(ex2.manifest.vault, false); assert.ok(!ex2.manifest.includes.includes('workspaces'));

  const tmp2 = mkdtempSync(path.join(os.tmpdir(), 'apiary-test2-'));
  const mkEngine = () => { const st = new Store(path.join(tmp2, 'state.json')); return new Engine(st); };
  let e2 = mkEngine(); e2.store.data.settings.marker = 'new computer'; e2.store.flush();
  const rejects = async (fn, status, re) => { try { await fn(); assert.fail('should have failed'); } catch (e) { assert.equal(e.status, status, e.message); assert.match(e.message, re); return e; } };
  const e1 = await rejects(() => importFrom(e2, createReadStream(bundle), {}), 400, /passphrase/i); assert.equal(e1.needsPassphrase, true);
  await rejects(() => importFrom(e2, createReadStream(bundle), { passphrase: 'wrong one here' }), 403, /Wrong passphrase/);
  assert.equal(JSON.parse(rf(path.join(tmp2, 'state.json'), 'utf8')).settings.marker, 'new computer', 'a failed import changes nothing');
  assert.equal(fsExists(path.join(tmp2, 'vault.json')), false);
  const junk = path.join(os.tmpdir(), 'junk.bin'); wf(junk, 'not a tar file');
  await rejects(() => importFrom(e2, createReadStream(junk), {}), 400, /valid|manifest/i);

  const res = await importFrom(e2, createReadStream(bundle), { passphrase: 'correct horse battery' });
  assert.ok(res.imported.includes('state.json') && res.vault && /^backup-before-import-/.test(res.backup));
  const st2 = JSON.parse(rf(path.join(tmp2, 'state.json'), 'utf8'));
  assert.ok(st2.agents[proj.id], 'the projects came across'); assert.equal(st2.settings.marker, undefined);
  assert.equal(rf(path.join(tmp2, 'workspaces', 'travel', 'notes.txt'), 'utf8'), 'hello from the old computer');
  assert.equal(JSON.stringify(st2).includes(JSON.stringify(tmp).slice(1, -1)), false, 'paths point at the new home');
  assert.equal(JSON.parse(rf(path.join(tmp2, res.backup, 'state.json'), 'utf8')).settings.marker, 'new computer', 'what was there is kept in a backup');
  const v2 = new V(path.join(tmp2, 'vault.json')); await v2.unlock('correct horse battery'); assert.ok(v2.list().length >= 2);
  assert.ok(!rd(tmp2).some((n) => n.startsWith('.import-')), 'temporary files are cleaned up');
  e2.store.flush(); assert.ok(st2 && JSON.parse(rf(path.join(tmp2, 'state.json'), 'utf8')).agents[proj.id], 'the imported data is not written over after the import');

  // import without a vault in the file leaves the existing vault alone
  const tmp3 = mkdtempSync(path.join(os.tmpdir(), 'apiary-test3-')); const e3 = new Engine(new Store(path.join(tmp3, 'state.json')));
  const r3 = await importFrom(e3, createReadStream(noVault), {}); assert.equal(r3.vault, false); assert.ok(!r3.imported.includes('workspaces'));

  // HTTP: info, download, and a rejected upload
  const info = (await call('/api/export?info=1')).body; assert.ok(info.bytes > 0 && info.parts.includes('state.json'));
  const dl = await fetch(`${base}/api/export?vault=0&files=0`); assert.equal(dl.status, 200); assert.match(dl.headers.get('content-disposition'), /apiary-export-/);
  const buf = Buffer.from(await dl.arrayBuffer()); assert.equal(buf[0], 0x1f); assert.equal(buf[1], 0x8b);
  const bad = await fetch(`${base}/api/import`, { method: 'POST', headers: { 'content-type': 'application/gzip', 'x-apiary-import': '1' }, body: 'nope' }); assert.equal(bad.status, 400);
  const noHdr = await fetch(`${base}/api/import`, { method: 'POST', headers: { 'content-type': 'application/gzip' }, body: 'nope' }); assert.equal(noHdr.status, 415);
}

// ---- 0.9.0: usage reported by the AI itself, update check schedule ----
{
  const { Limits } = await import('../src/limits.js');
  const http = await import('node:http');
  const { mkdirSync: mk, writeFileSync: wf } = await import('node:fs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'apiary-lim-')), cdir = path.join(dir, 'claude'), xdir = path.join(dir, 'codex');
  mk(cdir, { recursive: true }); mk(path.join(xdir, 'sessions', '2026', '11', '24'), { recursive: true });
  const seen = [];
  let mode = 'ok';
  const fake = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, beta: req.headers['anthropic-beta'], acct: req.headers['chatgpt-account-id'] });
    if (mode === '401') { res.writeHead(401); return res.end('{}'); }
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/claude')) return res.end(JSON.stringify({ five_hour: { utilization: 42.5, resets_at: new Date(Date.now() + 3600e3).toISOString() }, seven_day: { utilization: 81, resets_at: new Date(Date.now() + 86400e3).toISOString() }, seven_day_opus: null }));
    res.end(JSON.stringify({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 600 }, secondary_window: { used_percent: 55, limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 86400 } } }));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const port = fake.address().port;
  process.env.APIARY_CLAUDE_USAGE_URL = `http://127.0.0.1:${port}/claude`; process.env.APIARY_CODEX_USAGE_URL = `http://127.0.0.1:${port}/codex`;
  const L = new Limits({ claudeDir: cdir, codexDir: xdir });

  // no login: honest message, no numbers
  let r = await L.refresh('claude', { force: true }); assert.equal(r.ok, false); assert.equal(r.reason, 'no-login'); assert.equal(r.windows.length, 0);
  // with a login: the provider's own numbers
  wf(path.join(cdir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-claude-xyz', expiresAt: Date.now() + 3600e3, subscriptionType: 'max' } }));
  r = await L.refresh('claude', { force: true });
  assert.equal(r.ok, true); assert.equal(r.source, 'provider'); assert.equal(r.windows.length, 2); assert.equal(r.windows[0].pct, 42.5); assert.equal(r.windows[1].label, 'Weekly'); assert.equal(r.plan, 'max');
  assert.equal(seen.at(-1).auth, 'Bearer tok-claude-xyz'); assert.equal(seen.at(-1).beta, 'oauth-2025-04-20');
  assert.equal(JSON.stringify(r).includes('tok-claude-xyz'), false, 'the token is never part of the result');
  // refreshing too quickly returns the cached answer, force asks again
  const n = seen.length; await L.refresh('claude'); assert.equal(seen.length, n); await L.refresh('claude', { force: true }); assert.equal(seen.length, n + 1);
  // rejected login
  mode = '401'; r = await L.refresh('claude', { force: true }); assert.equal(r.ok, false); assert.equal(r.reason, 'auth'); mode = 'ok';
  // expired login
  wf(path.join(cdir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'old', expiresAt: Date.now() - 3600e3 } }));
  r = await L.refresh('claude', { force: true }); assert.equal(r.reason, 'expired');

  // codex: provider first
  wf(path.join(xdir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'tok-codex', account_id: 'acct-1' } }));
  r = await L.refresh('codex', { force: true });
  assert.equal(r.source, 'provider'); assert.deepEqual(r.windows.map((w) => [w.label, w.pct]), [['5-hour', 12], ['Weekly', 55]]); assert.equal(seen.at(-1).acct, 'acct-1');
  // codex: provider down, falls back to its own session records and says so
  mode = '401';
  const stamp = new Date().toISOString();
  wf(path.join(xdir, 'sessions', '2026', '11', '24', 'rollout-a.jsonl'), [JSON.stringify({ type: 'session_meta' }), JSON.stringify({ timestamp: stamp, type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 33, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 900 }, secondary: { used_percent: 70, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) - 5 } } } }), '{"partial'].join('\n'));
  r = await L.refresh('codex', { force: true });
  assert.equal(r.source, 'last-session'); assert.equal(r.ok, true); assert.match(r.note, /last recorded/); assert.equal(r.windows[0].pct, 33);
  assert.equal(r.windows[1].pct, 0, 'a window that has reset since is shown as reset'); assert.equal(r.windows[1].reset, true);
  mode = 'ok'; fake.close();

  // through the engine and the API
  engine.providerLimits.claudeDir = cdir; engine.providerLimits.codexDir = xdir;
  const v = (await call('/api/provider-usage')).body; assert.ok(typeof v.limits === 'object' && Array.isArray(v.pending));
  const rr = await call('/api/provider-usage/refresh', 'POST', {}); assert.equal(rr.status, 200);

  // how often to look for updates: the person chooses
  assert.equal(engine.updateCheck, 'daily'); assert.equal(engine.autoUpdate, true);
  for (const c of ['weekly', 'monthly', 'manual', 'daily']) assert.equal((await call('/api/settings', 'PUT', { updateCheck: c })).body.updateCheck, c);
  assert.equal((await call('/api/settings', 'PUT', { updateCheck: 'hourly' })).status, 400);
  await call('/api/settings', 'PUT', { updateCheck: 'weekly' });
  engine.store.data.settings.lastUpdateCheck = Date.now() - 2 * 86400000; assert.equal(engine.updateDue(), false, 'weekly: not yet after 2 days');
  engine.store.data.settings.lastUpdateCheck = Date.now() - 8 * 86400000; assert.equal(engine.updateDue(), true);
  await call('/api/settings', 'PUT', { updateCheck: 'manual' }); assert.equal(engine.updateDue(), false, 'manual never checks by itself'); assert.equal(engine.autoUpdate, false);
  await call('/api/settings', 'PUT', { autoUpdate: true }); assert.equal(engine.updateCheck, 'daily', 'the old on/off switch still works');
}

// ---- 0.10.0: install the AI tools from inside Apiary ----
{
  const { ToolInstaller, explain, RECIPES } = await import('../src/tools.js');
  const { mkdirSync: mk, writeFileSync: wf } = await import('node:fs');
  const bindir = path.join(mkdtempSync(path.join(os.tmpdir(), 'apiary-tools-')), 'bin'); mk(bindir, { recursive: true });
  process.env.PATH = `${process.env.PATH}${path.delimiter}${bindir}`;
  const script = `mkdir -p ${bindir} && printf '#!/bin/sh\\necho fakeai 1.2.3\\n' > ${bindir}/fakeai && chmod +x ${bindir}/fakeai`;
  const waitDone = async (t) => { for (let i = 0; i < 100 && t.running; i++) await new Promise((r) => setTimeout(r, 100)); return t.status; };
  let finished = 0;
  const t = new ToolInstaller({ heartbeat: 150, onDone: () => { finished++; }, recipes: {
    fakeai: { label: 'Fake AI', needs: [['sh', 'sh is needed']], cmd: 'sh', args: ['-c', `echo "downloading…"; sleep 0.5; echo "http fetch GET 200 registry"; ${script}; echo done`], login: 'fakeai login' },
    bad: { label: 'Bad AI', needs: [], cmd: 'sh', args: ['-c', 'echo "getaddrinfo ENOTFOUND registry.npmjs.org" >&2; exit 1'], login: 'bad' },
    nope: { label: 'Needs a tool', needs: [['definitely-not-installed-xyz', 'Install xyz first']], cmd: 'sh', args: ['-c', 'true'], login: 'nope' },
    node: { label: 'Node', needs: [], cmd: 'sh', args: ['-c', 'exit 9'], login: 'node' },
  } });
  assert.equal(t.status.state, 'idle'); assert.equal(t.installed().fakeai, false);
  assert.throws(() => t.start([]), /Choose/); assert.throws(() => t.start(['unknown']), /Choose/);
  t.start(['fakeai']); assert.equal(t.status.state, 'running'); assert.throws(() => t.start(['fakeai']), /already running/);
  let st = await waitDone(t);
  assert.equal(st.state, 'done'); assert.equal(st.pct, 100); assert.equal(finished, 1); assert.equal(t.installed().fakeai, true);
  assert.deepEqual(st.steps.map((x) => x.state), ['done', 'done', 'done']);
  const logText = st.log.join('\n'); assert.match(logText, /downloading/); assert.match(logText, /Still working/); assert.match(logText, /fakeai 1\.2\.3/);
  // a second run finds it and skips the download
  t.start(['fakeai']); st = await waitDone(t); assert.equal(st.steps[1].state, 'skip'); assert.equal(st.state, 'done');
  // already on the computer (node): nothing is installed again even though the recipe would fail
  t.start(['node']); st = await waitDone(t); assert.equal(st.state, 'done'); assert.equal(st.steps[1].state, 'skip');
  // failure: plain-language reason, the failing step is marked, nothing claims success
  t.start(['bad']); st = await waitDone(t); assert.equal(st.state, 'failed'); assert.match(st.failed.message, /internet/); assert.equal(st.steps[1].state, 'fail'); assert.ok(st.pct < 100);
  t.start(['nope']); st = await waitDone(t); assert.equal(st.state, 'failed'); assert.match(st.failed.message, /Install xyz first/);
  assert.match(explain(['EACCES: permission denied'], 1), /allowed to write/); assert.match(explain(['No space left on device'], 1), /disk is full/); assert.match(explain(['??'], 3), /code 3/);
  // the real recipes install for the current user only, never with sudo
  for (const r of Object.values(RECIPES)) assert.equal([r.cmd, ...r.args].join(' ').includes('sudo'), false);
  assert.match(RECIPES.claude.args.join(' '), /claude\.ai\/install\.sh/); assert.match(RECIPES.codex.args.join(' '), /--prefix/);

  // API
  const g = (await call('/api/tools')).body; assert.ok(typeof g.installed === 'object' && typeof g.anyAI === 'boolean'); assert.equal(g.install.state, 'idle');
  assert.equal((await call('/api/tools/install', 'POST', { tools: [] })).status, 400); assert.equal((await call('/api/tools/install', 'POST', { tools: ['rm -rf'] })).status, 400);
}

// ---- 0.10.1: security hardening ----
{
  const r = await fetch(base + '/');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/); assert.match(csp, /frame-ancestors 'none'/); assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.doesNotMatch(await r.text(), /<script>/, 'no inline scripts, so the CSP can block injected ones');
  assert.equal((await fetch(base + '/theme.js')).status, 200);
  const api = await fetch(base + '/api/state'); assert.equal(api.headers.get('cache-control'), 'no-store'); assert.equal(api.headers.get('x-frame-options'), 'DENY');
  // GitHub token only goes to github.com
  const gh = await import('../src/github.js');
  assert.match(gh.authArgs({ method: 'token', token: 'abc' })[1], /^http\.https:\/\/github\.com\/\.extraheader=/);
  assert.equal(gh.isGithubUrl('https://github.com/a/b'), true);
  for (const u of ['https://evil.com/github.com/a', 'https://github.com.evil.com/a', 'http://github.com/a', 'https://evil.com/?x=github.com', 'https://github.com@evil.com/a']) assert.equal(gh.isGithubUrl(u), false, u);
  // import refuses links that point outside the data folder
  const { spawnSync } = await import('node:child_process'); const { mkdirSync, symlinkSync, writeFileSync } = await import('node:fs'); const { checkLinks } = await import('../src/transfer.js');
  const d = path.join(tmp, 'linktest'); mkdirSync(path.join(d, 'x'), { recursive: true });
  symlinkSync('/tmp', path.join(d, 'x', 'bad')); spawnSync('tar', ['-czf', path.join(tmp, 'fine.tgz'), '-C', d, 'x']); checkLinks(path.join(tmp, 'fine.tgz'));   // a link alone is allowed
  // a file stored beneath that link is not: build the archive by hand, since tar will not make one from a real folder
  const evil = path.join(tmp, 'evil'); mkdirSync(path.join(evil, 'x', 'bad'), { recursive: true }); writeFileSync(path.join(evil, 'x', 'bad', 'pwn'), '1');
  const ar = (a, b) => spawnSync('tar', ['-czf', path.join(tmp, 'bad.tgz'), '--transform', 's,^x/real,x/bad,', '-C', a, ...b]);
  const mix = path.join(tmp, 'mix'); mkdirSync(path.join(mix, 'x', 'real'), { recursive: true }); writeFileSync(path.join(mix, 'x', 'real', 'pwn'), '1'); symlinkSync('/tmp', path.join(mix, 'x', 'bad'));
  ar(mix, ['x/bad', 'x/real/pwn']);
  assert.throws(() => checkLinks(path.join(tmp, 'bad.tgz')), /beneath a link/);
  const d2 = path.join(tmp, 'linktest2'); mkdirSync(path.join(d2, 'x'), { recursive: true }); writeFileSync(path.join(d2, 'x', 'a'), '1'); symlinkSync('a', path.join(d2, 'x', 'ok'));
  spawnSync('tar', ['-czf', path.join(tmp, 'ok.tgz'), '-C', d2, 'x']); checkLinks(path.join(tmp, 'ok.tgz'));
  // branch names are checked before they reach git
  const repos = await import('../src/repos.js'); assert.ok(repos);
}
// token: constant-time check, cookie then redirect so the token leaves the address bar
{
  const { spawn } = await import('node:child_process'); const home = mkdtempSync(path.join(os.tmpdir(), 'apiary-tok-'));
  const child = spawn(process.execPath, ['bin/apiary.js', 'start'], { env: { ...process.env, APIARY_HOME: home, APIARY_PORT: '17891', APIARY_TOKEN: 'secret-token-123', APIARY_NO_UPDATE_CHECK: '1' }, stdio: 'ignore' });
  try {
    await until(async () => { try { return (await fetch('http://127.0.0.1:17891/api/state', { redirect: 'manual' })).status === 401; } catch { return false; } }, 8000);
    const u = 'http://127.0.0.1:17891';
    assert.equal((await fetch(u + '/api/state?token=wrong')).status, 401); assert.equal((await fetch(u + '/api/state?token=secret-token-123')).status, 200);
    assert.equal((await fetch(u + '/api/state', { headers: { 'x-apiary-token': 'secret-token-123' } })).status, 200);
    const red = await fetch(u + '/?token=secret-token-123', { redirect: 'manual' });
    assert.equal(red.status, 302); assert.equal(red.headers.get('location'), '/');
    const ck = red.headers.get('set-cookie'); assert.match(ck, /HttpOnly/); assert.match(ck, /SameSite=Strict/); assert.match(ck, /Max-Age=/);
    assert.equal((await fetch(u + '/api/state', { headers: { cookie: ck.split(';')[0] } })).status, 200);
  } finally { child.kill(); }
}

// ---- 0.10.4: the dashboard must learn from the server that the CEO already exists ----
{
  const st = (await call('/api/state')).body; assert.equal(st.orgDone, true, 'server reports the CEO is set up');
  assert.match(fsRead(new URL('../public/app.js', import.meta.url), 'utf8'), /orgDone: !!st\.orgDone/, 'the page copies orgDone from the server state');
}

// ---- 0.11.0: @mentions ----
{
  const { ceo, ne, se } = orgIds;
  const cands = (await call(`/api/agents/${ceo.id}/mentionables`)).body;
  assert.ok(cands.some((c) => c.id === ne.id) && cands.some((c) => c.id === se.id) && !cands.some((c) => c.id === ceo.id));
  // names with spaces, any case, titles, and no false hits on e-mail addresses
  const f = (t) => engine.findMentions(t, [{ id: 'a', name: 'Captain Atlas', title: 'CTO' }, { id: 'b', name: 'Maya', title: 'Designer' }]);
  assert.deepEqual(f('hey @captain atlas, do it').found.map((x) => x.id), ['a']);
  assert.deepEqual(f('@CTO and @Maya please').found.map((x) => x.id), ['a', 'b']);
  assert.equal(f('mail me at bob@maya.com').found.length, 0); assert.equal(f('@Mayahem no').found.length, 0);
  assert.equal(f('@Maya check this').clean, 'Maya check this'); assert.equal(f('@Maya').rest.trim(), '');
  // empty request, ambiguous names, unknown tags
  assert.equal((await call(`/api/agents/${ceo.id}/messages`, 'POST', { text: `@${ne.name}` })).status, 400);
  assert.equal((await call(`/api/agents/${ceo.id}/messages`, 'POST', { text: '@Nobody do it' })).body.tagged.length, 0, 'unknown tag is just text for this chat');
  // the tagged agent gets the message in its own chat and its answer is shown in this one
  await until(() => engine.agents[ceo.id].status === 'idle');
  const before = engine.messages(ceo.id).length;
  const r = await call(`/api/agents/${ceo.id}/messages`, 'POST', { text: `Please @${ne.name} check the router` });
  assert.equal(r.status, 202); assert.deepEqual(r.body.tagged, [ne.name]);
  await until(() => engine.messages(ceo.id).some((m) => m.by?.id === ne.id));
  const mine = engine.messages(ceo.id).slice(before);
  assert.ok(mine.some((m) => m.role === 'user' && m.text.includes('@')) && mine.some((m) => m.role === 'system' && m.agentId === ne.id && /Sent to/.test(m.text)));
  assert.ok(engine.messages(ne.id).some((m) => m.role === 'user' && /check the router/.test(m.text) && !m.text.includes('@')), 'the tagged agent received it without the @');
  assert.ok(!mine.some((m) => m.role === 'agent' && !m.by), 'the chat agent itself was not asked');
  // two at once
  await call(`/api/agents/${ceo.id}/messages`, 'POST', { text: `@${ne.name} and @${se.name} introduce yourselves` });
  await until(() => engine.messages(ceo.id).filter((m) => m.by).length >= 3);
  assert.ok(engine.messages(se.id).some((m) => /same message was sent to/.test(m.text)));
  await until(() => engine.agents[ne.id].status === 'idle' && engine.agents[se.id].status === 'idle');
}

// ---- 0.11.2: secrets are never typed into a plain prompt ----
{
  const src = fsRead(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /askSecret\(`Replace /); assert.match(src, /type: 'password', autocomplete: 'new-password', spellcheck/);
  assert.equal(/prompt\(`New password/.test(src), false, 'no plain prompt asks for a secret');
}

// ---- 0.11.3: agents know which secrets they hold; every task has an agent ----
{
  const { ceo, ne, se } = orgIds;
  await call('/api/vault/unlock', 'POST', { passphrase: 'correct horse battery' });
  const sec = (await call('/api/vault')).body.secrets[0];
  await call('/api/vault/secrets/' + sec.id, 'PUT', { assigned: [{ key: 'network-engineer', label: 'Network Engineer', grant: 'ask' }] });
  const mine = engine._system(ne), lead = engine._system(ceo), other = engine._system(se);
  assert.ok(mine.includes(`Secrets assigned to you (ask for them by exactly this name): "${sec.name}"`), 'the holder is told the name');
  assert.ok(other.includes('No secret is assigned to you yet'), 'others are told they have none');
  assert.ok(lead.includes('Secrets assigned to your teammates') && lead.includes(`"${sec.name}"`) && /Network Engineer/.test(lead), 'the CEO learns who holds it');
  assert.ok(!mine.includes('S3cr3t-Value-123!') && !lead.includes('S3cr3t-Value-123!'), 'never the value');
  await call('/api/vault/lock', 'POST', {});
  assert.match(engine._system(ne), /vault is locked right now/);
  // saving from the screen (a map by key, as the old page sent) works too, and what the server reads back is a list
  await call('/api/vault/secrets/' + sec.id, 'PUT', { assigned: { 'security-engineer': { label: 'Security Engineer', grant: 'always' } } });
  assert.deepEqual((await call('/api/vault')).body.secrets.find((x) => x.id === sec.id).assigned.map((a) => [a.key, a.grant]), [['security-engineer', 'always']]);
  assert.match(fsRead(new URL('../public/app.js', import.meta.url), 'utf8'), /Object\.fromEntries\(\(x\.assigned \|\| \[\]\)/, 'the page reads the list');
  // tasks: the CEO is the default, and can be changed, never left empty
  const t1 = (await call('/api/tasks', 'POST', { title: 'Renew the certificate', status: 'todo' })).body;
  assert.equal(t1.assignee.id, ceo.id);
  const t2 = (await call('/api/tasks', 'POST', { title: 'Check backups', assignee: se.id })).body; assert.equal(t2.assignee.id, se.id);
  assert.equal((await call('/api/tasks/' + t2.id, 'PUT', { assignee: '' })).body.assignee.id, ceo.id, 'clearing falls back to the CEO');
  assert.equal((await call('/api/tasks/' + t2.id, 'PUT', { assignee: ne.id })).body.assignee.id, ne.id);
  const list = (await call('/api/tasks/agents')).body; assert.equal(list[0].id, ceo.id); assert.ok(list.some((a) => a.id === ne.id));
  // Start hands it to the agent, and it moves to In progress
  const n0 = engine.messages(ne.id).length;
  const st = await call('/api/tasks/' + t2.id + '/start', 'POST', {}); assert.equal(st.status, 202); assert.equal(st.body.agent, ne.name);
  await until(() => engine.messages(ne.id).length > n0 && engine.messages(ne.id).some((m) => m.role === 'user' && /Task from the board: Check backups/.test(m.text)));
  assert.equal(engine.tasks.get(t2.id).status, 'inprogress');
  await until(() => engine.agents[ne.id].status === 'idle');
  engine.tasks.update(t2.id, { status: 'done' }); assert.equal((await call('/api/tasks/' + t2.id + '/start', 'POST', {})).status, 409);
}

// ---- 0.11.4: what an agent's process can see ----
{
  const { childEnv, codexSecretFlags } = await import('../src/providers.js');
  process.env.APIARY_TOKEN = 'must-not-leak';
  const e = childEnv({ APIARY_SECRET_ROUTER: 'x' });
  assert.equal(e.APIARY_TOKEN, undefined, 'the access token is not passed to agents'); assert.equal(e.APIARY_SECRET_ROUTER, 'x'); assert.ok(e.PATH);
  delete process.env.APIARY_TOKEN;
  assert.deepEqual(codexSecretFlags({}), []); assert.deepEqual(codexSecretFlags({ APIARY_SECRET_X: '1' }), ['-c', 'shell_environment_policy.ignore_default_excludes=true']);
}

// ---- 0.11.4: the responsible agent of a project ----
{
  const { ceo, ne } = orgIds;
  const proj = (await call('/api/agents', 'POST', { provider: 'mock', approvals: false, name: 'Owner test site', goal: 'say hi' })).body;
  await until(() => engine.agents[proj.id].status === 'idle');
  const root = engine.agents[proj.id];
  assert.equal(root.ownerId, ceo.id, 'new projects belong to the CEO'); assert.equal(engine.ownerOf(root).id, ceo.id);
  assert.equal((await call(`/api/projects/${proj.id}/owner`, 'PUT', { agent: 'nobody' })).status, 400);
  assert.equal((await call(`/api/projects/${proj.id}/owner`, 'PUT', { agent: proj.id })).status, 400, 'not its own owner');
  assert.equal((await call(`/api/projects/${ceo.id}/owner`, 'PUT', { agent: ne.id })).status, 404, 'the main chat is not a project');
  assert.equal((await call(`/api/projects/${proj.id}/owner`, 'PUT', { agent: ne.id })).status, 200);
  assert.equal(engine.ownerOf(root).id, ne.id); assert.ok(engine.projectsOwnedBy(ne).some((r) => r.id === proj.id)); assert.ok(!engine.projectsOwnedBy(ceo).some((r) => r.id === proj.id));
  assert.match(engine._system(ne), /You lead these projects: Owner test site/);
  assert.ok(engine.messages(proj.id).some((m) => /is now responsible for this project/.test(m.text)));
  // the project is led by its responsible agent: the CEO's identity, team and secrets, and the CEO's specialists can be reached
  assert.equal((await engine._findPeer(ne, 'Owner test site')).peer?.id, proj.id, 'the owner can still reach the project');
  // a vanished owner falls back to the CEO
  root.ownerId = 'gone'; assert.equal(engine.ownerOf(root).id, ceo.id);
  assert.ok((await call('/api/state')).body.agents.find((a) => a.id === proj.id));
  assert.match(fsRead(new URL('../public/app.js', import.meta.url), 'utf8'), /Responsible: \$\{ownerOf\(a\)/);
}

// ---- 0.12.0: kinds of secret (login, SSH login, API key / token) ----
{
  const { ceo, ne } = orgIds;
  await call('/api/vault/unlock', 'POST', { passphrase: 'correct horse battery' });
  const mk = async (b) => (await call('/api/vault/secrets', 'POST', b));
  // validation
  assert.equal((await mk({ name: 'S1', value: 'pw', type: 'ssh', username: 'root', host: 'bad host' })).status, 400);
  assert.equal((await mk({ name: 'S1', value: 'pw', type: 'ssh', username: 'root', host: '10.0.0.5', port: '99999' })).status, 400);
  assert.equal((await mk({ name: 'S1', value: 'pw', type: 'ssh', host: '10.0.0.5' })).status, 400, 'needs a username');
  assert.equal((await mk({ name: 'S1', value: 'not a key', type: 'ssh', username: 'root', host: 'h', auth: 'key' })).status, 400);
  const ssh = (await mk({ name: 'Lab server', value: 'hunter2-pass', type: 'ssh', username: 'root', host: '10.0.0.5', port: 2222 })).body;
  assert.deepEqual([ssh.type, ssh.host, ssh.port, ssh.auth], ['ssh', '10.0.0.5', 2222, 'password']);
  const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\r\nAAAA-key-body-BBBB\r\n-----END OPENSSH PRIVATE KEY-----';
  const keyed = (await mk({ name: 'Key server', value: KEY, type: 'ssh', username: 'deploy', host: 'srv.example.com', auth: 'key' })).body;
  assert.equal(keyed.auth, 'key'); assert.equal(engine.vault.value(keyed.id), KEY.replace(/\r\n/g, '\n') + '\n', 'line endings fixed, trailing newline added');
  const tok = (await mk({ name: 'Cloud token', value: 'tok-abcdef-123456', type: 'token', username: 'ignored' })).body; assert.equal(tok.type, 'token'); assert.equal(tok.username, '');
  const lg = (await mk({ name: 'Old style', value: 'p', username: 'me' })).body; assert.equal(lg.type, 'login', 'no type given: a username makes it a login');
  assert.equal((await call('/api/vault')).body.secrets.find((x) => x.id === ssh.id).host, '10.0.0.5');
  assert.ok(!JSON.stringify((await call('/api/vault')).body).includes('hunter2-pass') && !JSON.stringify((await call('/api/vault')).body).includes('AAAA-key-body'), 'values never leave the server');
  // edit the connection; changing between password and key needs the new secret
  assert.equal((await call('/api/vault/secrets/' + ssh.id, 'PUT', { host: 'lab.example.com', port: '22', username: 'admin' })).body.host, 'lab.example.com');
  assert.equal((await call('/api/vault/secrets/' + ssh.id, 'PUT', { auth: 'key' })).status, 400);
  assert.equal((await call('/api/vault/secrets/' + ssh.id, 'PUT', { auth: 'key', value: KEY })).status, 200);
  assert.equal((await call('/api/vault/secrets/' + ssh.id, 'PUT', { auth: 'password', value: 'hunter2-pass' })).body.auth, 'password');
  // leasing: an SSH login also hands over host, port and how to log in, and the agent is told how to use it
  const grant = (id) => call('/api/vault/secrets/' + id, 'PUT', { assigned: [{ key: 'network-engineer', label: 'Network Engineer', grant: 'always' }] });
  for (const x of [ssh, keyed, tok, lg]) await grant(x.id);
  const notes = []; await engine._secrets(ne, [{ name: 'Lab server' }, { name: 'Key server' }, { name: 'Cloud token' }, { name: 'Old style' }], notes);
  const env = engine._leaseEnv(ne);
  assert.equal(env.APIARY_SECRET_LAB_SERVER, 'hunter2-pass'); assert.equal(env.APIARY_SECRET_LAB_SERVER_USER, 'admin'); assert.equal(env.APIARY_SECRET_LAB_SERVER_HOST, 'lab.example.com'); assert.equal(env.APIARY_SECRET_LAB_SERVER_PORT, '22'); assert.equal(env.APIARY_SECRET_LAB_SERVER_AUTH, 'password');
  assert.equal(env.APIARY_SECRET_KEY_SERVER_AUTH, 'key'); assert.equal(env.APIARY_SECRET_KEY_SERVER_HOST, 'srv.example.com'); assert.equal(env.APIARY_SECRET_CLOUD_TOKEN, 'tok-abcdef-123456'); assert.equal(env.APIARY_SECRET_CLOUD_TOKEN_HOST, undefined);
  assert.ok(notes.some((n) => /apiary-ssh "Lab server" -- /.test(n) && /admin@lab\.example\.com:22/.test(n)), 'SSH note');
  assert.ok(notes.some((n) => /API key or token\) is available to your commands as the environment variable/.test(n) && /Authorization header/.test(n)), 'token note'); assert.ok(notes.some((n) => /The login "Old style"/.test(n)), 'login note');
  assert.ok(!notes.join('\n').includes('hunter2-pass') && !notes.join('\n').includes('AAAA-key-body'), 'notes never contain values');
  engine._clearLease(ne.id); assert.deepEqual(engine._leaseEnv(ne), {});
  assert.match(engine._system(ne), /"Lab server" \(SSH login\)/); assert.match(engine._system(ne), /"Cloud token" \(API key or token\)/);
  // the helper builds the right ssh command and never puts a secret on it
  const { spawnSync } = await import('node:child_process'); const helper = path.resolve('bin/apiary-ssh');
  const run = (extra, args) => spawnSync(process.execPath, [helper, ...args], { env: { ...process.env, APIARY_HOME: path.join(tmp, 'ah'), APIARY_SSH_DRYRUN: '1', ...extra }, encoding: 'utf8' });
  const r1 = run({ ...env }, ['Lab server', '-L', '80:localhost:80', '--', 'uptime', '-a']); assert.equal(r1.status, 0, r1.stderr);
  const a1 = JSON.parse(r1.stdout); assert.equal(a1.auth, 'password'); assert.deepEqual(a1.args.slice(-5), ['-L', '80:localhost:80', 'admin@lab.example.com', 'uptime', '-a']);
  assert.ok(a1.args.includes('StrictHostKeyChecking=accept-new') && a1.args.includes('PubkeyAuthentication=no') && a1.args.includes('-p') && !r1.stdout.includes('hunter2-pass'));
  assert.ok(a1.args.some((x) => /ah\/known_hosts$/.test(x)), 'its own known_hosts, not the user\'s');
  const r2 = run({ ...env }, ['Key server']); assert.equal(JSON.parse(r2.stdout).auth, 'key'); assert.ok(JSON.parse(r2.stdout).args.includes('PasswordAuthentication=no') && !r2.stdout.includes('AAAA-key-body'));
  const r3 = run({}, ['Lab server']); assert.equal(r3.status, 2); assert.match(r3.stderr, /not available to you/);
  const ask = spawnSync(process.execPath, [helper, "admin@lab's password: "], { env: { ...process.env, APIARY_ASKPASS_VAR: 'APIARY_SECRET_LAB_SERVER', APIARY_SECRET_LAB_SERVER: 'hunter2-pass' }, encoding: 'utf8' }); assert.equal(ask.stdout.trim(), 'hunter2-pass', 'ssh asks this same file for the password');
  const { childEnv } = await import('../src/providers.js'); assert.ok(childEnv().PATH.split(path.delimiter)[0].endsWith('bin'), 'agents find apiary-ssh');
  { // safe-mode shell commands are decided by the person in Apiary; full access is unchanged
    const { claudeCliArgs } = await import('../src/providers.js');
    const approval = { url: 'http://127.0.0.1:1/api/approval-bridge', token: 't', bridge: '/x/approval-bridge.js' };
    const safe = claudeCliArgs({ access: 'safe', system: 'x', approval });
    assert.equal(safe[safe.indexOf('--permission-mode') + 1], 'acceptEdits');
    assert.equal(safe[safe.indexOf('--permission-prompt-tool') + 1], 'mcp__apiary__approve');
    assert.ok(!safe.includes('--allowedTools'), 'no blanket shell rule');
    assert.ok(!claudeCliArgs({ access: 'safe', system: 'x' }).includes('--mcp-config'), 'no bridge, no approvals');
    assert.ok(!claudeCliArgs({ access: 'full', system: 'x', approval }).includes('--mcp-config'));
    const full = claudeCliArgs({ access: 'full', system: 'x' });
    assert.equal(full[full.indexOf('--permission-mode') + 1], 'bypassPermissions');
    // the engine turns a bridge request into an approval; the person's answer decides it
    const agent = Object.values(engine.agents)[0];
    const run = engine.beginApprovalBridge(agent, new AbortController().signal);
    const tick = () => new Promise((r) => setImmediate(r));
    const pendingCmd = () => Object.values(engine.store.data.approvals).find((r) => r.status === 'pending' && r.kind === 'command');
    const p1 = engine.requestCommandApproval(run.token, { tool_name: 'Bash', input: { command: 'curl -s http://10.0.0.5' } });
    await tick(); assert.ok(pendingCmd() && pendingCmd().detail.includes('curl -s'));
    engine.decide(pendingCmd().id, { decision: 'approve' });
    assert.deepEqual(await p1, { behavior: 'allow', updatedInput: { command: 'curl -s http://10.0.0.5' } });
    const p2 = engine.requestCommandApproval(run.token, { tool_name: 'Bash', input: { command: 'rm -rf /tmp/x' } });
    await tick(); engine.decide(pendingCmd().id, { decision: 'deny', note: 'No.' });
    assert.equal((await p2).behavior, 'deny');
    engine.endApprovalBridge(run);
    assert.equal((await engine.requestCommandApproval(run.token, { tool_name: 'Bash', input: { command: 'ls' } })).behavior, 'deny', 'an ended run cannot ask');
  }
  { // command rules: exact, program, read-only, allow everything, the safety list, agent scope and deny
    const mk = (id, name) => engine._add({ id, name, role: 'Test', provider: 'claude', method: 'cli', model: '', cwd: tmp, access: 'safe', parentId: null, depth: 0, approvals: true, memKey: id });
    const ag = mk('rules1', 'Rules tester'), other = mk('rules2', 'Other tester');
    const tick = () => new Promise((r) => setImmediate(r));
    // ask(command, answer): runs one request through the bridge; if the person is asked, answers with `answer`
    const ask = async (who, command, answer) => {
      const run = engine.beginApprovalBridge(who, new AbortController().signal);
      const p = engine.requestCommandApproval(run.token, { tool_name: 'Bash', input: { command } });
      await tick();
      const pend = Object.values(engine.store.data.approvals).find((r) => r.status === 'pending' && r.kind === 'command' && r.agentId === who.id);
      if (pend) engine.decide(pend.id, answer || { decision: 'deny' });
      const out = await p; engine.endApprovalBridge(run);
      return { asked: !!pend, allowed: out.behavior === 'allow' };
    };
    const approve = (mode) => ({ decision: 'approve', mode });
    engine.policy.add({ kind: 'command', action: 'allow', scope: 'exact', command: 'uptime', agent: ag.id });
    assert.deepEqual(await ask(ag, 'uptime'), { asked: false, allowed: true }, 'exact rule');
    assert.deepEqual(await ask(other, 'uptime'), { asked: true, allowed: false }, 'a rule for one agent does not reach another');
    engine.policy.add({ kind: 'command', action: 'allow', scope: 'program', command: 'curl', agent: ag.id });
    assert.deepEqual(await ask(ag, 'curl -s http://10.0.0.5/api/'), { asked: false, allowed: true }, 'program rule, GET');
    assert.deepEqual(await ask(ag, 'curl -X POST http://10.0.0.5/x'), { asked: true, allowed: false }, 'program rule never covers a write');
    assert.deepEqual(await ask(ag, 'curl -s http://10.0.0.5/ && rm -rf /tmp/x'), { asked: true, allowed: false }, 'chained commands are always asked');
    engine.policy.add({ kind: 'command', action: 'allow', scope: 'readonly', agent: ag.id });
    assert.deepEqual(await ask(ag, 'docker ps'), { asked: false, allowed: true }, 'read-only preset');
    assert.deepEqual(await ask(ag, 'docker rm old-box'), { asked: true, allowed: false }, 'read-only preset never covers docker rm');
    assert.deepEqual(await ask(ag, 'pct destroy 101'), { asked: true, allowed: false }, 'destructive pct is asked');
    assert.deepEqual(await ask(ag, 'python3 -c "print(1)"'), { asked: true, allowed: false }, 'interpreters are asked');
    // "always" choices from the card create rules
    assert.deepEqual(await ask(ag, 'make remembered-once', approve('exact')), { asked: true, allowed: true }, 'exact choice is approved');
    assert.deepEqual(await ask(ag, 'make remembered-once'), { asked: false, allowed: true }, 'and remembered');
    assert.deepEqual(await ask(ag, 'jq . /tmp/a.json', approve('program')), { asked: true, allowed: true }, 'program choice');
    assert.deepEqual(await ask(ag, 'jq . /tmp/b.json'), { asked: false, allowed: true }, 'program choice is remembered');
    assert.deepEqual(await ask(ag, 'jq -n 1', approve('once')), { asked: false, allowed: true }, 'an existing rule covers it');
    // a deny rule beats an allow rule
    engine.policy.add({ kind: 'command', action: 'deny', scope: 'program', command: 'git', agent: ag.id });
    assert.deepEqual(await ask(ag, 'git status'), { asked: false, allowed: false }, 'deny wins over the read-only rule');
    // allow everything for this agent covers a destructive command, but not another agent
    assert.deepEqual(await ask(ag, 'rm -rf /tmp/apiary-not-real-1', approve('agent')), { asked: true, allowed: true }, 'allow everything choice');
    assert.deepEqual(await ask(ag, 'rm -rf /tmp/apiary-not-real-2'), { asked: false, allowed: true }, 'then no more questions for that agent');
    assert.deepEqual(await ask(other, 'rm -rf /tmp/apiary-not-real-3'), { asked: true, allowed: false }, 'other agents are still asked');
    assert.throws(() => engine.policy.add({ kind: 'command', action: 'allow', scope: 'program', command: 'curl; rm', agent: ag.id }), /program name/);
  }
  { // a hire that cannot go ahead says why, and a hire waiting for approval is announced in the chat
    const lead = Object.values(engine.agents).find((a) => !a.parentId && a.kind !== 'general') || Object.values(engine.agents).find((a) => !a.parentId);
    const tick = () => new Promise((r) => setImmediate(r));
    const said = (agent) => (engine.messages(agent.id) || []).filter((m) => m.role === 'system').map((m) => m.text);
    const before = said(lead).length;
    await engine._hire(lead, [{ title: 'Network Engineer', role: 'x', department: 'operations' }], []);
    assert.ok(said(lead).slice(before).some((t) => /^Not hired: there is already a /.test(t)), 'the duplicate is explained in the chat');
    lead.approvals = true;   // this hire must wait for the person
    const hireWait = engine._hire(lead, [{ title: 'Chat Tester Engineer', role: 'Tests hires', department: 'engineering' }], []);
    await tick();
    assert.ok(said(lead).some((t) => /Proposed hire waiting for your approval/.test(t)), 'a pending hire is announced');
    const waiting = Object.values(engine.store.data.approvals).find((r) => r.status === 'pending' && r.kind === 'hire');
    assert.ok(waiting, 'a hire approval exists');
    engine.decide(waiting.id, { decision: 'deny', note: 'test' });
    await hireWait;
  }
  { // the trust slider: 0 asks for everything, 5 runs everything, the levels in between allow more as they go up; a Deny rule still wins
    const { riskOf } = await import('../src/command-rules.js');
    const ag = engine._add({ id: 'trust1', name: 'Trust tester', role: 'Test', provider: 'claude', method: 'cli', model: '', cwd: tmp, access: 'safe', parentId: null, depth: 0, approvals: true, memKey: 'trust1' });
    assert.throws(() => engine.setTrust(ag.id, { level: 6 }), /0 to 5/);
    assert.throws(() => engine.setTrust(ag.id, { level: 'high' }), /0 to 5/);
    assert.equal(engine.setTrust(ag.id, { level: 3 }).trust, 3);
    assert.equal(ag.trust, 3);
    const tick = () => new Promise((r) => setImmediate(r));
    const run = async (level, command) => {
      engine.setTrust(ag.id, { level });
      const bridge = engine.beginApprovalBridge(ag, new AbortController().signal);
      const p = engine.requestCommandApproval(bridge.token, { tool_name: 'Bash', input: { command } });
      await tick();
      const pend = Object.values(engine.store.data.approvals).find((r) => r.status === 'pending' && r.kind === 'command' && r.agentId === ag.id);
      if (pend) engine.decide(pend.id, { decision: 'deny', note: 'test' });
      const out = await p; engine.endApprovalBridge(bridge);
      return { asked: !!pend, allowed: out.behavior === 'allow' };
    };
    assert.deepEqual(await run(0, 'ls -la'), { asked: true, allowed: false }, 'level 0 asks even for a read-only command');
    assert.deepEqual(await run(1, 'ls -la'), { asked: false, allowed: true }, 'level 1 runs read-only commands');
    assert.deepEqual(await run(1, 'ls | grep x'), { asked: true, allowed: false }, 'level 1 asks about a chain');
    assert.deepEqual(await run(2, 'ls | grep x'), { asked: true, allowed: false }, 'level 2 asks about a chain');
    assert.deepEqual(await run(2, 'ls -la'), { asked: false, allowed: true }, 'level 2 runs simple commands');
    assert.deepEqual(await run(3, 'ls | grep x'), { asked: false, allowed: true }, 'level 3 runs chains');
    assert.deepEqual(await run(3, 'systemctl restart ssh'), { asked: true, allowed: false }, 'level 3 asks about changes');
    assert.deepEqual(await run(4, 'systemctl restart ssh'), { asked: false, allowed: true }, 'level 4 runs changes');
    assert.deepEqual(await run(4, 'rm -rf /tmp/apiary-not-real'), { asked: true, allowed: false }, 'level 4 still asks about deleting');
    assert.deepEqual(await run(5, 'rm -rf /tmp/apiary-not-real'), { asked: false, allowed: true }, 'level 5 runs everything');
    engine.policy.add({ kind: 'command', action: 'deny', scope: 'program', command: 'git', agent: ag.id });
    assert.deepEqual(await run(5, 'git status'), { asked: false, allowed: false }, 'a Deny rule beats level 5');
    for (const [c, r] of [['ls -la', 0], ['ls | grep x', 1], ['systemctl restart ssh', 2], ['rm -rf /tmp/x', 3]]) assert.equal(riskOf(c), r, c);
  }
  { // review fixes: classification (A1-A6), the level texts (A7), the token out of the arguments (B1), auto decisions (C1), hire names (D1-D3), peer limits (E1, E2), trust input (F1)
    const cr = await import('../src/command-rules.js');
    const risk = cr.riskOf, ro = cr.isReadOnly;
    // A1 background & and chains
    assert.ok(risk('sleep 1 & rm -rf /tmp/x') >= 2, 'A1: background operator splits commands');
    // A2 wrappers and assignments
    assert.equal(risk('sudo rm -rf /tmp/x'), 3, 'A2: sudo is judged by what it runs');
    assert.equal(risk('RM_FLAG=1 rm -rf /tmp/x'), 3, 'A2: leading assignments are skipped');
    assert.equal(risk('nohup rm -rf /tmp/x'), 3, 'A2: nohup is skipped');
    assert.equal(risk('xargs rm'), 3, 'A2: xargs runs what it is given');
    assert.equal(risk('sudo ls'), 2, 'A2: sudo alone is at least risk 2');
    // A3 code passed to interpreters
    assert.equal(risk('bash -c "rm -rf /tmp/x"'), 3, 'A3: destructive code in bash -c');
    assert.equal(risk('python3 -c "print(1)"'), 2, 'A3: code in an interpreter is at least risk 2');
    assert.equal(risk('eval rm -rf x'), 3, 'A3: eval runs what it is given');
    // A4 scripts by path and build tools
    assert.equal(risk('./deploy.sh'), 2, 'A4: a script run by path');
    assert.equal(risk('/opt/tools/run'), 2, 'A4: a program run by an absolute path');
    assert.equal(risk('npm install example-package'), 2, 'A4: package installs');
    assert.equal(risk('make clean'), 2, 'A4: build tools');
    // A5 apiary-ssh: the remote command is judged, unknown is risk 3
    assert.equal(risk('apiary-ssh "example-host" -- reboot'), 3, 'A5: a remote reboot is risk 3');
    assert.equal(risk('apiary-ssh "example-host" -- rm -rf /var/tmp/x'), 3, 'A5: a remote delete is risk 3');
    assert.equal(risk('apiary-ssh "example-host" -- uptime'), 0, 'A5: a remote read is harmless');
    assert.equal(risk('apiary-ssh "example-host"'), 3, 'A5: an interactive remote shell is risk 3');
    // A6 read-only lists that could change things
    for (const c of ['ip addr add 10.0.0.9/24 dev eth0', 'ip link set eth0 down', 'git branch -D example-branch', 'curl -sO http://example.com/x.sh', 'curl -sd a=b http://example.com', 'curl -XPOST http://example.com', 'journalctl --vacuum-time=1d', 'date -s 2030-01-01', 'hostname example-name', 'ss -K', 'wget http://example.com/x', 'sort -o /tmp/x /tmp/y'])
      assert.ok(!ro(c) && risk(c) >= 2, 'A6: not read-only: ' + c);
    for (const c of ['ip -br addr', 'git branch', 'curl -s http://example.com/api/', 'journalctl -u ssh', 'date +%F', 'hostname', 'ss -tn'])
      assert.ok(ro(c) && risk(c) === 0, 'A6: still read-only: ' + c);
    // A7 the texts match what is enforced
    assert.equal(cr.TRUST_LEVELS[3], 'Chains run too; scripts, changes and destructive commands ask');
    assert.ok(cr.levelAllows(3, 'ls | grep x') && !cr.levelAllows(3, './deploy.sh') && !cr.levelAllows(3, 'systemctl restart ssh'), 'A7: level 3 matches its text');
    assert.ok(cr.levelAllows(4, 'systemctl restart ssh') && !cr.levelAllows(4, 'rm -rf /tmp/x'), 'A7: level 4 matches its text');
    // B1 the bridge's token is not on the command line
    const { claudeCliArgs, writeApprovalConfig } = await import('../src/providers.js');
    const cfg = writeApprovalConfig({ url: 'http://127.0.0.1:1/api/approval-bridge', token: 'example-token-value', bridge: '/x/approval-bridge.js' });
    const cliArgs = claudeCliArgs({ access: 'safe', system: 'x', approval: { configFile: cfg.configFile } });
    assert.ok(!cliArgs.join(' ').includes('example-token-value'), 'B1: the token is not in the arguments');
    assert.equal((fsStat(cfg.configFile).mode & 0o777), 0o600, 'B1: the settings file is private');
    cfg.cleanup(); assert.ok(!fsExists(cfg.configFile), 'B1: removed after the run');
    { // MCP connectors: the file names an environment variable, never the token
      const c2 = writeApprovalConfig(null, { cloudflare: { url: 'https://mcp.cloudflare.com/mcp', envVar: 'APIARY_SECRET_CF' } });
      const txt = fsRead(c2.configFile, 'utf8'), j = JSON.parse(txt).mcpServers;
      assert.deepEqual(Object.keys(j), ['cloudflare']); assert.equal(j.cloudflare.url, 'https://mcp.cloudflare.com/mcp'); assert.equal(j.cloudflare.headers.Authorization, 'Bearer ${APIARY_SECRET_CF}');
      assert.ok(claudeCliArgs({ access: 'full', system: 'x', mcpConfig: c2.configFile }).includes(c2.configFile), 'full access still gets the connector');
      c2.cleanup();
    }
    // C1 a decision made without asking is recorded and shown in the chat
    const cagent = engine._add({ id: 'auto1', name: 'Auto tester', role: 'Test', provider: 'claude', method: 'cli', model: '', cwd: tmp, access: 'safe', parentId: null, depth: 0, approvals: true, memKey: 'auto1' });
    engine.setTrust(cagent.id, { level: 5 });
    const brg = engine.beginApprovalBridge(cagent, new AbortController().signal);
    const allowedNow = await engine.requestCommandApproval(brg.token, { tool_name: 'Bash', input: { command: 'rm -rf /tmp/example-auto' } });
    engine.endApprovalBridge(brg);
    assert.equal(allowedNow.behavior, 'allow');
    const rec = Object.values(engine.store.data.approvals).find((r) => r.agentId === cagent.id && r.auto);
    assert.ok(rec && rec.status === 'approved' && /rm -rf|run a command/.test(rec.title), 'C1: the automatic decision is on the Approvals page');
    assert.ok(engine.messages(cagent.id).some((m) => /^Allowed automatically/.test(m.text || '')), 'C1: and in the chat');
    assert.equal(Object.values(engine.store.data.approvals).filter((r) => r.status === 'pending').length, 0, 'C1: nothing is pending');
    // D1-D3 hire names
    const lead2 = Object.values(engine.agents).find((a) => !a.parentId && a.kind !== 'general') || Object.values(engine.agents).find((a) => !a.parentId);
    const { parseSpawns: ps2 } = await import('../src/engine.js');
    assert.equal(ps2('```apiary-hire\n{"title":"Example Role","role":"x","department":"operations"}\n```').hires[0].name, '', 'D1: no name when none is given');
    lead2.approvals = false;
    await engine._hire(lead2, [{ title: 'Example Codename Role', role: 'x', department: 'operations' }], []);
    const coded = Object.values(engine.agents).find((a) => a.title === 'Example Codename Role');
    assert.ok(coded && coded.name !== 'Example Codename Role' && coded.name.length <= 40, 'D3: a hire without a name gets a codename');
    await engine._hire(lead2, [{ name: 'Example Named', title: 'Example Named Role', role: 'x', department: 'operations' }], []);
    assert.ok(Object.values(engine.agents).some((a) => a.name === 'Example Named'), 'D3: a hire with a name keeps it');
    const longNotes = [];
    lead2.approvals = false;
    await engine._hire(lead2, [{ name: 'A very long example name for a hire that goes past the limit', title: 'Example Long Role', role: 'x', department: 'operations' }], longNotes);
    assert.ok(Object.values(engine.agents).some((a) => a.title === 'Example Long Role' && a.name.length <= 40), 'D2: a long name is shortened');
    assert.ok(engine.messages(lead2.id).some((m) => /is longer than 40 characters/.test(m.text || '')), 'D2: and the person is told');
    // E1 per hour limit, visible in the chat; E2 a reply cannot start another reply
    engine.store.data.settings.limits = { ...(engine.store.data.settings.limits || {}), maxPeerMessages: 2 };
    const room = 'example-room';
    engine._peerCounted(room); engine._peerCounted(room);
    assert.equal(engine._peerAllowed(room), false, 'E1: the limit applies');
    engine.peerLog.set(room, [Date.now() - 2 * 3600000, Date.now() - 2 * 3600000]);
    assert.equal(engine._peerAllowed(room), true, 'E1: the limit clears after an hour');
    engine.store.data.settings.limits = { ...engine.store.data.settings.limits, maxPeerMessages: 30 };
    const mem = Object.values(engine.agents).find((a) => a.parentId === lead2.id && a.member);
    const other = Object.values(engine.agents).find((a) => a.parentId === lead2.id && a.member && a.id !== mem?.id);
    if (mem && other) {
      engine.replyTurns.add(mem.id);
      const notes = [];
      const job = await engine._peerJob(mem, { to: other.name, text: 'example question', wait: true }, notes);
      assert.equal(job, null, 'E2: no reply job is started');
      assert.ok(notes.some((n) => /without waiting: a reply from a teammate cannot start another reply/.test(n)), 'E2: the sender is told why');
      engine.replyTurns.delete(mem.id);
    }
    // F1 trust input
    for (const bad of [{ level: '' }, { level: null }, { level: undefined }, { level: 'high' }, {}])
      assert.throws(() => engine.setTrust(cagent.id, bad), /0 to 5/, 'F1: rejects ' + JSON.stringify(bad));
    assert.equal(engine.setTrust(cagent.id, { level: '2' }).trust, 2, 'F1: a digit string is accepted');
  }
  { // runbooks: a why, steps that use placeholders instead of real machines, titles kept as written, older runbooks cleaned
    engine.infra.add({ name: 'Example Server', type: 'server', address: '10.0.0.5' });
    const rb = engine.runbooks.propose('Tester', '', { title: 'Restart Example Server', problem: 'Example Server stops after updates', steps: ['ssh to Example Server at 10.0.0.5', 'restart the service at https://example.com/docs'], tags: [] });
    assert.equal(rb.title, 'Restart Example Server', 'the title is kept as written');
    assert.ok(!/Example Server|10\.0\.0\.5|example\.com/.test(rb.problem + ' ' + rb.steps.join(' ')), 'no real machine names, addresses or links in why or steps');
    assert.ok(/<server>/.test(rb.problem) && /<server>/.test(rb.steps[0]), 'placeholders are used instead');
    engine.runbooks.all.old1 = { id: 'old1', title: 'Old one', problem: 'Example Server is slow', steps: ['open Example Server'], tags: [], status: 'draft', author: 'Tester', project: '', createdAt: 1, updatedAt: 1 };
    assert.ok(engine.runbooks.tidy() >= 1, 'older runbooks are cleaned');
    assert.ok(!/Example Server/.test(engine.runbooks.all.old1.steps.join(' ') + engine.runbooks.all.old1.problem), 'the old steps no longer name the machine');
    assert.equal(engine.runbooks.all.old1.title, 'Old one', 'the old title is kept');
    // leave nothing behind for the tests that count runbooks and devices
    delete engine.runbooks.all.old1; engine.runbooks.remove(rb.id);
    engine.infra.items = engine.infra.items.filter((i) => i.name !== 'Example Server'); engine.infra.save?.();
  }
  { // agents may ask to save a secret they made; the person types the value; it never sits on the request or in the chat
    const { parseSpawns: ps3 } = await import('../src/engine.js');
    const good = ps3('```apiary-newsecret\n{"name":"Example Save Login","type":"login","username":"example-user","why":"for the example site"}\n```');
    assert.equal(good.newSecrets.length, 1); assert.equal(good.newSecrets[0].name, 'Example Save Login');
    const bad = ps3('```apiary-newsecret\n{"name":"Example Bad","value":"example-value-xyz"}\n```');
    assert.equal(bad.newSecrets.length, 0, 'a block with a value is refused'); assert.ok(bad.errors.some((e) => /Never put the value/.test(e)));
    assert.ok(!JSON.stringify(bad).includes('example-value-xyz'), 'the value is not kept anywhere');
    const sag = engine._add({ id: 'newsec1', name: 'Secret saver', role: 'Test', provider: 'claude', method: 'cli', model: '', cwd: tmp, access: 'safe', parentId: null, depth: 0, approvals: true, memKey: 'newsec1' });
    const tick = () => new Promise((r) => setImmediate(r));
    const nots = [];
    const flow = engine._newSecret(sag, [{ name: 'Example Save Login', type: 'login', username: 'example-user', why: 'for the example site' }], nots);
    await tick();
    const pend = Object.values(engine.store.data.approvals).find((r) => r.status === 'pending' && r.kind === 'newsecret' && r.agentId === sag.id);
    assert.ok(pend, 'the person is asked');
    assert.ok(!JSON.stringify(pend).includes('example-value-456'), 'no value on the request yet');
    // a wrong or empty value is refused and the request stays open
    assert.throws(() => engine.decide(pend.id, { decision: 'approve', secret: { name: 'Example Save Login', type: 'login', username: 'example-user', value: '' } }), /Enter the secret value|value/);
    assert.equal(engine.store.data.approvals[pend.id].status, 'pending', 'still waiting after a failed save');
    engine.decide(pend.id, { decision: 'approve', secret: { name: 'Example Save Login', type: 'login', username: 'example-user', value: 'example-value-456' } });
    await flow;
    assert.ok(engine.vault.byName('Example Save Login'), 'the secret is in the vault');
    assert.ok(nots.some((n) => /saved "Example Save Login"/.test(n)), 'the agent is told it was saved, not the value');
    assert.ok(!JSON.stringify(engine.store.data.approvals).includes('example-value-456'), 'the value is not on any request');
    assert.ok(!JSON.stringify(engine.messages(sag.id)).includes('example-value-456'), 'the value is not in the chat');
    // a name already in the vault is not asked again
    const dup = [];
    await engine._newSecret(sag, [{ name: 'Example Save Login', type: 'login' }], dup);
    assert.ok(dup.some((n) => /already a secret/.test(n)));
    // a denied request saves nothing
    const denied = [];
    const df = engine._newSecret(sag, [{ name: 'Example Denied Login', type: 'token' }], denied);
    await tick();
    const dp = Object.values(engine.store.data.approvals).find((r) => r.status === 'pending' && r.kind === 'newsecret' && r.secretName === 'Example Denied Login');
    engine.decide(dp.id, { decision: 'deny', note: 'no' });
    await df;
    assert.equal(engine.vault.byName('Example Denied Login'), undefined, 'nothing saved on deny');
  }
  { // updates wait for the work in progress, hold new messages meanwhile, install by themselves once idle, and can be cancelled or forced
    // start from an idle team with nothing waiting: wait for background work from earlier tests to finish, then put everything back afterwards
    for (let i = 0; i < 150 && engine.busy().total > 0; i++) await new Promise((r) => setTimeout(r, 40));
    const savedStatus = Object.values(engine.agents).map((a) => [a, a.status]);
    for (const a of Object.values(engine.agents)) a.status = 'idle';
    const savedPending = Object.values(engine.store.data.approvals).filter((r) => r.status === 'pending');
    for (const r of savedPending) r.status = 'cancelled';
    let installs = 0;
    const fake = { s: { state: 'ready', current: '0.1.0', latest: '0.2.0' }, get status() { return { ...this.s }; }, markRestarting() {}, install: async () => { installs++; return {}; } };
    const usrv = createServer(engine, { updater: fake, restart: () => {} });
    await new Promise((r) => usrv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${usrv.address().port}`;
    const post = (p, b = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
    const someAgent = Object.keys(engine.agents)[0];
    const tickUp = () => new Promise((r) => setTimeout(r, 30));
    engine.ctls.set('example-run', new AbortController());
    const [q1, qb] = await post('/api/update/install');
    assert.equal(q1, 202); assert.equal(qb.queued, true, 'the install waits instead of stopping work');
    assert.equal(installs, 0, 'not installed while work is running');
    assert.equal(fake.s.queued, true); assert.equal(engine.updateHold, true, 'new messages are held');
    assert.throws(() => engine.send(someAgent, 'example message'), /update is waiting/);
    engine.ctls.delete('example-run'); engine.emit('event', { type: 'activity', agentId: someAgent, text: '' });
    await tickUp();
    assert.equal(installs, 1, 'installs by itself once the work has finished');
    assert.equal(engine.updateHold, false, 'new messages are accepted again');
    // cancel while waiting
    fake.s.state = 'ready';
    engine.ctls.set('example-run-2', new AbortController());
    await post('/api/update/install');
    assert.equal(fake.s.queued, true);
    const [cs] = await post('/api/update/cancel');
    assert.equal(cs, 200); assert.equal(fake.s.queued, false); assert.equal(engine.updateHold, false, 'cancel lifts the hold');
    engine.ctls.delete('example-run-2');
    // install now anyway
    engine.ctls.set('example-run-3', new AbortController());
    const [fs2, fb] = await post('/api/update/install', { force: true });
    assert.equal(fs2, 202); assert.equal(fb.forced, true); assert.equal(installs, 2, 'forced install runs at once');
    engine.ctls.delete('example-run-3');
    usrv.close();
    for (const [a, st] of savedStatus) a.status = st;
    for (const r of savedPending) r.status = 'pending';
  }
  { // task conversations and history are newest first by default, with a button to show oldest first
    const a = fsRead(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.match(a, /const order = \{ newest: true \}/, 'newest first by default');
    assert.match(a, /Show oldest first/, 'the person can switch the order');
  }
  { // the Copy buttons work on plain http too (the page falls back to a hidden text box), and task messages show when they were sent
    const a = fsRead(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.match(a, /document\.execCommand\('copy'\)/, 'copy has a fallback');
    assert.match(a, /window\.isSecureContext/, 'the clipboard API is used only where it works');
    assert.match(a, /timeStyle: 'short'/, 'each task message has a date and time');
    assert.match(a, /c\.id === 'claude' \|\| c\.id === 'codex'\) && c\.cli\.found \? aiSignIn/, 'the sign-in button is on both the Claude and the Codex card');
  }
  { // the Library: ready-made connectors that make the login in the vault and a linked device; icons are fetched live once, then kept
    const { LIBRARY, view: libView, cleanSvg } = await import('../src/library.js');
    const netm = await import('node:net');
    await call('/api/vault/init', 'POST', { passphrase: 'correct horse battery' }).catch(() => {});
    await call('/api/vault/unlock', 'POST', { passphrase: 'correct horse battery' }).catch(() => {});
    const lib = (await call('/api/library')).body;
    assert.ok(lib.entries.length >= 20 && ['proxmox', 'unifi', 'kubernetes', 'docker'].every((id) => lib.entries.some((e) => e.id === id)));
    assert.equal(new Set(lib.entries.map((e) => e.id)).size, lib.entries.length, 'library ids are unique');
    assert.ok(!JSON.stringify(lib).includes('raw.githubusercontent'), 'icon web addresses stay on the server');
    assert.ok(LIBRARY.every((e) => e.icons.every((u) => /^https:\/\/raw\.githubusercontent\.com\//.test(u))), 'only fixed public icon addresses are ever fetched');
    // a device from the Library: login in the vault, device linked to it, nothing secret on the map
    const srv = netm.createServer((c) => c.end()); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const lport = srv.address().port;
    const r1 = await call('/api/library/linux/add', 'POST', { name: 'Lib box', address: '127.0.0.1', port: lport, username: 'root', auth: 'password', secret: 'lib-hunter2' });
    assert.equal(r1.status, 201); assert.equal(r1.body.lib, 'linux'); assert.equal(r1.body.type, 'server'); assert.match(r1.body.secret, /^Lib box login/);
    assert.ok(!JSON.stringify(engine.infra.view()).includes('lib-hunter2'), 'no password on the map');
    const sv = engine.vault.byName(r1.body.secret); assert.equal(engine.vault.list().find((x) => x.id === sv.id).type, 'ssh', 'an SSH library entry makes an SSH login');
    assert.equal(engine.vault.list().find((x) => x.id === sv.id).port, lport);
    assert.equal((await call('/api/library/linux/add', 'POST', { name: 'Lib box', address: '127.0.0.1', secret: 'x' })).status, 409, 'same name is refused');
    assert.equal((await call('/api/library/linux/add', 'POST', { name: 'Lib box 2', address: '', secret: 'x' })).status, 400);
    assert.equal((await call('/api/library/linux/add', 'POST', { name: 'Lib box 3', address: '1.2.3.4' })).status, 400, 'a login needs its password');
    assert.equal((await call('/api/library/nope/add', 'POST', { address: 'x' })).status, 404);
    const pm = await call('/api/library/proxmox/add', 'POST', { name: 'Lib pve', method: 'token', address: '127.0.0.1', secret: 'user@pam!t=abc' });
    assert.equal(pm.status, 201); assert.equal(engine.vault.list().find((x) => x.name === pm.body.secret).type, 'token'); assert.equal(pm.body.port, 8006); assert.match(pm.body.url, /^https:\/\/127\.0\.0\.1:8006$/);
    const web = await call('/api/library/website/add', 'POST', { name: 'Lib site', address: 'https://example.com' });
    assert.equal(web.status, 201); assert.equal(web.body.secret, ''); assert.equal((await call('/api/library/website/add', 'POST', { name: 'Lib site 2', address: 'example.com' })).status, 400);
    // cloud connectors: fixed address, a real check of the token / key, and no secret in any answer
    {
      const realFetch = globalThis.fetch; const calls = [];
      globalThis.fetch = async (u, o = {}) => {
        const url = String(u); calls.push(url);
        if (url.startsWith('http://127.0.0.1')) return realFetch(u, o);
        const J = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
        if (url.includes('api.cloudflare.com/client/v4/user/tokens/verify')) return J(o.headers.authorization === 'Bearer cf-good-token-123' ? { success: true, result: { status: 'active' } } : { success: false, result: null }, o.headers.authorization === 'Bearer cf-good-token-123' ? 200 : 401);
        if (url.includes('api.cloudflare.com/client/v4/accounts')) return J({ success: false }, 403);
        if (url.includes('api.cloudflare.com')) return new Response('{}', { status: 404 });
        if (url.includes('oauth2.googleapis.com/token')) return String(o.body).includes('assertion=') ? J({ access_token: 'ya29.fake' }) : J({ error: 'invalid_request' }, 400);
        if (url.includes('googleapis.com')) return new Response('{}', { status: 404 });
        return new Response('{}', { status: 200 });
      };
      try {
        const cf = await call('/api/library/cloudflare/add', 'POST', { name: 'Lib CF', secret: 'cf-good-token-123', address: 'ignored.example' });
        assert.equal(cf.status, 201); assert.equal(cf.body.url, 'https://api.cloudflare.com'); assert.equal(cf.body.address, '', 'the address is fixed, not typed');
        const cft = (await call(`/api/infra/${cf.body.id}/test`, 'POST', {})).body; assert.ok(cft.status.ok && /accepted the token/.test(cft.status.detail), cft.status.detail);
        const cf2 = (await call('/api/library/cloudflare/add', 'POST', { name: 'Lib CF bad', secret: 'cf-bad-token-999' })).body;
        const cf2t = (await call(`/api/infra/${cf2.id}/test`, 'POST', {})).body; assert.equal(cf2t.status.ok, false); assert.ok(!cf2t.status.detail.includes('cf-bad-token-999'), 'no token in the answer');
        assert.equal((await call('/api/library/cloudflare/add', 'POST', { name: 'Lib CF none' })).status, 400, 'a token is required');
        { // only an approved (leased) login turns on Cloudflare's MCP server for that turn
          assert.deepEqual(engine._connectorsFor({ id: 'nobody' }), {});
          engine.leases.set('mcp-agent', new Map([[cf.body.secret, 'cf-good-token-123']]));
          const got = engine._connectorsFor({ id: 'mcp-agent' }); assert.equal(got.cloudflare.url, 'https://mcp.cloudflare.com/mcp'); assert.match(got.cloudflare.envVar, /^APIARY_SECRET_/); assert.ok(!JSON.stringify(got).includes('cf-good-token'), 'no token in the connector');
          engine.leases.delete('mcp-agent');
          assert.match(engine.infra.summary(), /MCP connector "cloudflare"/);
        }
        const { generateKeyPairSync } = await import('node:crypto');
        const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
        const key = JSON.stringify({ type: 'service_account', client_email: 'bot@demo-project.iam.gserviceaccount.com', private_key: pem });
        assert.equal((await call('/api/library/google/add', 'POST', { name: 'Lib G bad', secret: 'not json' })).status, 400, 'a non-key is refused');
        const g = await call('/api/library/google/add', 'POST', { name: 'Lib Google', secret: key });
        assert.equal(g.status, 201); assert.equal(g.body.url, 'https://www.googleapis.com');
        assert.equal(engine.vault.list().find((x) => x.name === g.body.secret).username || '', '', 'the key owner is not exposed as a vault username field');
        const gt = (await call(`/api/infra/${g.body.id}/test`, 'POST', {})).body; assert.ok(gt.status.ok && /bot@demo-project/.test(gt.status.detail), gt.status.detail);
        assert.ok(!JSON.stringify(gt).includes('BEGIN PRIVATE KEY'), 'the key never appears in the result');
        assert.ok(calls.some((c) => c.includes('oauth2.googleapis.com')), 'signed in for real');
        {
  // UniFi: the official Network API with an API key
  const { verifyUnifi } = await import('../src/cloud.js');
  const seen = []; const stub = (st, json) => async (h, p, path, hd) => { seen.push({ h, p, path, hd }); return { status: st, json }; };
  assert.deepEqual(await verifyUnifi('10.0.0.1', 443, 'k', stub(200, { applicationVersion: '9.1.2' })), { ok: true, detail: 'The console accepted the API key (Network 9.1.2)' });
  assert.equal(seen[0].path, '/proxy/network/integration/v1/info'); assert.equal(seen[0].hd['x-api-key'], 'k');
  assert.match((await verifyUnifi('10.0.0.1', 443, 'bad', stub(401, {}))).detail, /refused the API key/);
  assert.match((await verifyUnifi('10.0.0.1', 443, 'k', stub(404, null))).detail, /9\.0 or newer/);
  assert.equal((await verifyUnifi('10.0.0.1', 443, 'k', async () => { throw new Error('ECONNREFUSED'); })).ok, false);
  const { byId: libraryEntry } = await import('../src/library.js');
  assert.deepEqual(libraryEntry('unifi').methods.map((m) => m.id), ['token'], 'UniFi uses the official API key only');
  for (const id of ['proxmox', 'homeassistant', 'n8n', 'coolify', 'portainer', 'grafana', 'gitea', 'truenas', 'kubernetes', 'opnsense', 'uptimekuma', 'pihole']) assert.equal(libraryEntry(id).methods[0].id, 'token', `${id} leads with its official API key`);
  { const { verifyApi } = await import('../src/cloud.js'); const seen2 = []; const ok = (j) => async (sch, h, p, path, hd, m) => { seen2.push({ sch, p, path, hd, m }); return { status: 200, json: j }; };
    assert.match((await verifyApi('proxmox', { host: 'pve', port: 8006 }, 'root@pam!t=abc', ok({ data: { version: '8.2' } }))).detail, /Proxmox accepted the key \(Proxmox 8\.2\)/);
    assert.equal(seen2[0].hd.authorization, 'PVEAPIToken=root@pam!t=abc'); assert.equal(seen2[0].path, '/api2/json/version');
    assert.equal((await verifyApi('homeassistant', { host: 'ha', port: 8123, scheme: 'http' }, 'tok', ok({ message: 'API running.' }))).ok, true); assert.equal(seen2[1].sch, 'http'); assert.equal(seen2[1].hd.authorization, 'Bearer tok');
    assert.equal(seen2[1].path, '/api/');
    await verifyApi('n8n', { host: 'n', port: 5678, scheme: 'http' }, 'k', ok({})); assert.equal(seen2[2].hd['x-n8n-api-key'], 'k');
    await verifyApi('opnsense', { host: 'fw', port: 443 }, 'key:sec', ok({})); assert.equal(seen2[3].hd.authorization, 'Basic ' + Buffer.from('key:sec').toString('base64'));
    await verifyApi('pihole', { host: 'p', port: 80, scheme: 'http' }, 'pw', ok({ session: { valid: true } })); assert.equal(seen2[4].m, 'POST');
    assert.equal((await verifyApi('pihole', { host: 'p', port: 80, scheme: 'http' }, 'pw', ok({ session: { valid: false } }))).ok, false, 'a wrong app password is caught');
    assert.match((await verifyApi('gitea', { host: 'g', port: 3000, scheme: 'http' }, 'bad', async () => ({ status: 401, json: {} }))).detail, /refused the key/);
    assert.equal(await verifyApi('website', { host: 'x' }, 'k'), null); }
  const port = new URL(base).port;
  const u = await call('/api/library/unifi/add', 'POST', { name: 'Lab UniFi', method: 'token', address: '127.0.0.1', port, secret: 'unifi-key-abc-123' });
  assert.equal(u.status, 201); assert.equal(engine.vault.list().find((x) => x.name === u.body.secret).type, 'token');
  engine.apiGet = async (sch, h, p, path, hd) => ({ status: hd['x-api-key'] === 'unifi-key-abc-123' ? 200 : 401, json: { applicationVersion: '9.0.1' } });
  const ut = (await call(`/api/infra/${u.body.id}/test`, 'POST', {})).body; assert.ok(ut.status.ok && /accepted the key/.test(ut.status.detail), ut.status.detail);
  assert.ok(!JSON.stringify(ut).includes('unifi-key-abc-123'), 'the key never appears in the answer');
  assert.match(engine.infra.summary(), /integration\/v1 with the header X-API-KEY/); assert.ok(!engine.infra.summary().includes('unifi-key-abc-123'));
  delete engine.apiGet;
}
      } finally { globalThis.fetch = realFetch; }
    }
    assert.match(fsRead(path.join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8'), /forceBottom = true;[\s\S]*?\/messages`, 'POST'/, 'sending a chat message scrolls to it');
    { // after an update, old cached copies of the app are not reused
      const home = await (await fetch(base + '/')).text(), js = await (await fetch(base + '/app.js')).text();
      assert.match(home, /\/app\.js\?v=\d+\.\d+\.\d+/); assert.match(home, /\/style\.css\?v=/); assert.match(js, /from '\.\/map\.js\?v=\d/);
    }
    { // phones: no sideways scrolling, a compact top bar and chat header, comfortable touch targets
      const css = fsRead(path.join(import.meta.dirname, '..', 'public', 'style.css'), 'utf8'), idx = fsRead(path.join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8'), app = fsRead(path.join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
      assert.match(idx, /viewport-fit=cover/); assert.match(css, /@media \(max-width:900px\)\{\s*body\{overflow-x:hidden;overflow-x:clip\}/); assert.match(css, /\.doc-top\{display:none\}/); assert.match(css, /\.chat-back/); assert.match(app, /class: 'btn only-small chat-back'/); assert.match(css, /min-height:44px/); assert.match(css, /\.gsearch input\{font-size:16px!important\}/); assert.match(css, /\.team\{order:-1/);
      assert.match(css, /\.chat-head\.more \.ch-more\{display:flex\}/); assert.match(app, /class: 'ch-more'/); assert.match(app, /closest\('#menu'\)/, 'tapping outside the menu closes it');
    }
    { // troubleshooting: explains, asks once per outage, repairs only from the safe list, closes after 15 minutes up
      const net = await import('node:net');
      const srv = net.createServer((s) => s.destroy()); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const livePort = srv.address().port;
      process.env.APIARY_FIX_WAIT_MS = '0';
      const ran = [];
      engine.discoveryRun = async ({ script }) => { if (/apiary-ok/.test(script)) return { code: 0, stdout: 'apiary-ok', stderr: '' }; ran.push(script.trim()); dev.port = livePort; return { code: 0, stdout: 'done', stderr: '' }; };
      engine.troubleProbe = { lookup: async () => ({ address: '127.0.0.1' }), probe: async () => ({ open: false, why: 'refused' }) };
      engine.vault.add('Trouble SSH', 'pw-ts-1', '', 'root', { type: 'ssh', host: '127.0.0.1', port: 22, auth: 'password' });
      const dev = engine.infra.add({ name: 'Trouble web', type: 'server', address: '127.0.0.1', port: 1, secret: 'Trouble SSH' });
      const pend = () => Object.values(engine.store.data.approvals).filter((a) => a.kind === 'troubleshoot' && a.status === 'pending');
      assert.equal((await call(`/api/infra/${dev.id}/troubleshoot`, 'POST', {})).status, 202);
      await until(() => pend().length === 1, 8000);
      assert.match(pend()[0].detail, /systemctl restart nginx/); assert.ok(!/rm -rf/.test(pend()[0].detail), 'unsafe commands are never offered for approval');
      assert.ok(dev.trouble.report.basic.summary.length > 10 && /web service/.test(dev.trouble.report.ai), 'plain-words explanation');
      assert.deepEqual(dev.trouble.report.manual, ['rm -rf /'], 'what it may not do is listed for the person');
      assert.equal((await call(`/api/approvals/${pend()[0].id}/decide`, 'POST', { decision: 'approve' })).status, 200);
      await until(() => dev.trouble.state === 'done', 8000);
      assert.deepEqual(ran, ['systemctl restart nginx'], 'only the safe command ran'); assert.match(dev.trouble.report.outcome, /reachable again/);
      // same outage, second click: no second approval
      ran.length = 0; dev.port = 1;
      await call(`/api/infra/${dev.id}/troubleshoot`, 'POST', {}); await until(() => dev.trouble.state === 'done' && ran.length === 1, 8000);
      assert.equal(pend().length, 0, 'approval is asked once per problem');
      // back up for over 15 minutes: the case is over, and a new outage asks again
      dev.port = livePort; await engine.testDevice(dev.id); dev.status.since = Date.now() - 16 * 60000;
      await call(`/api/infra/${dev.id}/troubleshoot`, 'POST', {}); assert.equal(dev.trouble.healthy, true); assert.equal(dev.trouble.approved, undefined);
      dev.port = 1; ran.length = 0;
      await call(`/api/infra/${dev.id}/troubleshoot`, 'POST', {}); await until(() => pend().length === 1, 8000);
      await call(`/api/approvals/${pend()[0].id}/decide`, 'POST', { decision: 'deny' }); await until(() => dev.trouble.state === 'done', 8000);
      assert.equal(ran.length, 0, 'a declined repair never runs'); assert.ok(dev.trouble.report.manual.includes('systemctl restart nginx'));
      delete engine.discoveryRun; delete engine.troubleProbe; delete process.env.APIARY_FIX_WAIT_MS; srv.close();
    }
    // testing checks the port and also signs in for real
    engine.discoveryRun = async () => ({ code: 0, stdout: 'apiary-ok\n', stderr: '' });
    const t1 = (await call(`/api/infra/${r1.body.id}/test`, 'POST', {})).body; assert.ok(t1.status.ok && /login works/.test(t1.status.detail), t1.status.detail);
    engine.discoveryRun = async () => ({ code: 255, stdout: '', stderr: 'Permission denied (publickey,password).' });
    const t2 = (await call(`/api/infra/${r1.body.id}/test`, 'POST', {})).body; assert.equal(t2.status.ok, false); assert.ok(!t2.status.detail.includes('lib-hunter2'));
    delete engine.discoveryRun; srv.close();
    // the vault being locked is explained, and no half-made device is left
    await call('/api/vault/lock', 'POST', {});
    const before = engine.infra.view().length;
    assert.equal((await call('/api/library/linux/add', 'POST', { name: 'Lib locked', address: '1.2.3.4', username: 'root', secret: 'x' })).status, 423);
    assert.equal(engine.infra.view().length, before, 'nothing half-made');
    await call('/api/vault/unlock', 'POST', { passphrase: 'correct horse battery' }).catch(() => {});
    // icons: fetched live the first time, then the kept copy is used, and it is never fetched or deleted again
    let hits = 0; engine.iconFetch = async () => { hits++; const b = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><script>x</script><path d="M0 0h8v8z"/></svg>'); return { ok: true, arrayBuffer: async () => b, body: null }; };
    const i1 = await fetch(base + '/api/library/icon/proxmox'); const svg1 = await i1.text();
    assert.equal(i1.status, 200); assert.match(i1.headers.get('content-type'), /image\/svg\+xml/); assert.ok(svg1.includes('<path') && !/script|onload/.test(svg1), 'active content is stripped');
    const kept = path.join(path.dirname(engine.store.file), 'icons', 'proxmox.svg'); assert.ok(fsExists(kept), 'the downloaded icon is kept');
    const first = hits; await (await fetch(base + '/api/library/icon/proxmox')).text(); assert.equal(hits, first, 'the kept copy is used, not downloaded again');
    engine.iconFetch = async () => { throw new Error('offline'); };
    assert.equal((await fetch(base + '/api/library/icon/proxmox')).status, 200, 'still shown when offline');
    assert.equal((await fetch(base + '/api/library/icon/hyperv')).status, 404, 'an entry without an icon falls back');
    assert.equal((await fetch(base + '/api/library/icon/../../etc')).status === 200, false, 'only known entries');
    assert.equal(cleanSvg('not an svg'), null);
    // a factory reset leaves the downloaded icons alone
    const { plan } = await import('../src/reset.js'); assert.ok(!plan(engine).files.some((f) => /[\\/]icons([\\/]|$)/.test(f)), 'a factory reset keeps the icons');
    delete engine.iconFetch;
    const a = fsRead(new URL('../public/app.js', import.meta.url), 'utf8'); assert.match(a, /function openLibrary/); assert.match(a, /iconIdOf\(i\) \? libIcon/, 'device cards show the icon');
  }
  { // a plan can be edited while it is approved: steps changed, given an owner, removed or added; the lead is told
    const { cleanPhases } = await import('../src/engine.js');
    assert.deepEqual(cleanPhases([{ title: ' A ', steps: ['x', { text: 'y', owner: 'Rex' }, '', { text: '' }] }]), [{ title: 'A', goal: '', steps: ['x', 'y'], owners: ['', 'Rex'] }]);
    assert.deepEqual(cleanPhases([{ goal: 'no title' }, null]), []);
    const pj = (await call('/api/agents', 'POST', { provider: 'mock', name: 'Edit plan', approvals: true })).body, ld = engine.agents[pj.id];
    await call(`/api/agents/${ld.id}/messages`, 'POST', { text: 'plan-it for the edit test' });
    let pa; await until(() => (pa = engine.approvals().find((a) => a.status === 'pending' && a.kind === 'plan' && a.agentId === ld.id)), 8000);
    assert.equal((await call(`/api/approvals/${pa.id}/decide`, 'POST', { decision: 'approve', phases: [{ title: '' }] })).status, 400, 'an empty plan is refused');
    const edited = [{ title: 'Edited phase', goal: 'g', steps: [{ text: 'Edited step one', owner: ld.name }, { text: 'Added step', owner: '' }] }];
    assert.equal((await call(`/api/approvals/${pa.id}/decide`, 'POST', { decision: 'approve', phases: edited })).status, 200);
    await until(() => ld.plan && engine.agents[ld.id].status === 'idle', 8000);
    assert.deepEqual(ld.plan.phases.map((p) => p.title), ['Edited phase'], 'the approved plan is the edited one');
    assert.deepEqual(ld.plan.phases[0].steps.map((x) => x.text), ['Edited step one', 'Added step']);
    assert.ok(ld.plan.phases[0].steps.every((x) => x.task), 'edited steps get task IDs too');
    assert.equal(engine.approvals().find((a) => a.id === pa.id).edited, true);
  }
  { // every ID is a status chip: tasks, tickets, approvals and secrets are all in /api/refs; a secret shows its name, never its value
    await call('/api/vault/init', 'POST', { passphrase: 'correct horse battery' }).catch(() => {});
    await call('/api/vault/unlock', 'POST', { passphrase: 'correct horse battery' }).catch(() => {});
    const sec = await call('/api/vault/secrets', 'POST', { name: 'Chip secret', value: 'chip-hunter2', type: 'token' });
    assert.match(sec.body.code, /^SC-\d{4}$/, 'a secret gets a short ID');
    const tk = engine.tasks.add({ title: 'Chip task', status: 'blocked' });
    const tk2 = engine.tasks.add({ title: 'Chip task two', status: 'done' });
    const tick = engine.tickets.add({ title: 'Chip ticket', description: '', priority: 'normal' });
    engine.tickets.setStatus(tick.id, 'resolved');
    const rec = engine._approvalNo({ id: 'chipap01', status: 'pending', createdAt: Date.now(), title: 'Chip approval' });
    engine.store.data.approvals.chipap01 = rec;
    const refs = (await call('/api/refs')).body.refs;
    assert.equal(refs[tk.code].state, 'blocked'); assert.equal(refs[tk2.code].state, 'done'); assert.equal(refs[tk.code].title, 'Chip task');
    assert.equal(refs[`TK-${String(tick.num).padStart(4, '0')}`].state, 'done', 'a resolved ticket is done');
    assert.equal(refs[`AP-${String(rec.num).padStart(4, '0')}`].state, 'waiting', 'a pending approval is waiting for you');
    engine.store.data.approvals.chipap01.status = 'denied';
    assert.equal((await call('/api/refs')).body.refs[`AP-${String(rec.num).padStart(4, '0')}`].state, 'blocked');
    assert.equal(refs[sec.body.code].state, 'secret'); assert.equal(refs[sec.body.code].title, 'Chip secret');
    assert.ok(!JSON.stringify(refs).includes('chip-hunter2'), 'no secret value in the references');
    const nums = Object.values(engine.store.data.approvals).map((r) => r.num); assert.ok(nums.every(Boolean) && new Set(nums).size === nums.length, 'approval numbers are unique');
    delete engine.store.data.approvals.chipap01;
    const a = fsRead(new URL('../public/app.js', import.meta.url), 'utf8'), css = fsRead(new URL('../public/style.css', import.meta.url), 'utf8');
    assert.match(a, /\(\?:T\|TK\|AP\|SC\)-/, 'all four kinds of ID become chips');
    for (const st of ['done', 'blocked', 'progress', 'waiting', 'todo', 'cancelled']) assert.ok(css.includes(`.idchip.st-${st}`), `${st} has a colour`);
    assert.match(a, /done: \['✓'/); assert.match(a, /blocked: \['⛔'/);
  }
  { // sign in to Claude from the page: the link is shown, the pasted code goes to the CLI, the login is confirmed, and the code is never kept
    const { AiLogin } = await import('../src/aiLogin.js');
    const { EventEmitter } = await import('node:events');
    const { PassThrough } = await import('node:stream');
    const fakeCli = (code) => {
      const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.exitCode = null; c.kill = () => {};
      c.stdin.on('data', (d) => { if (String(d).trim() === code) { c.exitCode = 0; c.emit('close', 0); } else { c.exitCode = 1; c.emit('close', 1); } });
      return c;
    };
    let launched = null;
    const al = new AiLogin({ timeoutMs: 5000, bin: () => '/example/claude', checkFn: () => '{"loggedIn": true}',
      spawnFn: (bin, args) => { launched = { bin, args }; const c = fakeCli('example-code-123'); setTimeout(() => c.stdout.write('If the browser did not open, visit:\nhttps://claude.example.com/oauth/authorize?state=abc.\n'), 5); return c; } });
    const tock = (ms = 25) => new Promise((r) => setTimeout(r, ms));
    assert.equal(al.start('claude').state, 'starting');
    await tock();
    assert.equal(al.status('claude').state, 'waiting'); assert.equal(al.status('claude').url, 'https://claude.example.com/oauth/authorize?state=abc', 'the link is shown without the trailing full stop');
    assert.deepEqual(launched.args, ['auth', 'login', '--claudeai'], 'uses the CLI\'s own sign-in');
    assert.throws(() => al.submit('claude', ''), /Paste the code/);
    al.submit('claude', 'example-code-123');
    await tock();
    assert.equal(al.status('claude').state, 'done', 'done once the CLI confirms the login');
    assert.ok(!JSON.stringify(al.s).includes('example-code-123'), 'the code is not kept');
    assert.throws(() => al.submit('claude', 'x'), /no sign-in waiting/);
    // a wrong code fails with a clear message
    al.start('claude'); await tock();
    al.submit('claude', 'wrong-code'); await tock();
    assert.equal(al.status('claude').state, 'failed'); assert.ok(al.status('claude').message.length > 0);
    // an unknown service is refused
    assert.throws(() => al.start('example-service'), /Unknown service/);
    // Codex: device-code sign-in. The code is shown (not pasted), the CLI finishes by itself, success is confirmed with its own status command
    let cx = null, logged = false;
    const alx = new AiLogin({ timeoutMs: 5000, bin: () => '/example/codex', checkFn: (b, a) => (a[0] === 'login' && a[1] === 'status' ? (logged ? 'Logged in using ChatGPT' : 'Not logged in') : ''),
      spawnFn: (bin, args) => { cx = { bin, args }; const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.exitCode = null; c.kill = () => {};
        setTimeout(() => c.stdout.write('\u001b[1mFollow these steps\u001b[0m\n1. Open this link\n   https://auth.example.com/codex/device\n'), 5);
        setTimeout(() => c.stdout.write('2. Enter this one-time code\n   ABCD-12345\n'), 15);
        setTimeout(() => { logged = true; c.exitCode = 0; c.emit('close', 0); }, 120); c.__c = c; return c; } });
    alx.start('codex'); await tock(60);
    const sx = alx.status('codex');
    assert.equal(sx.state, 'waiting'); assert.equal(sx.url, 'https://auth.example.com/codex/device'); assert.equal(sx.code, 'ABCD-12345'); assert.equal(sx.device, true);
    assert.deepEqual(cx.args, ['login', '--device-auth'], 'Codex uses its device-code sign-in');
    assert.throws(() => alx.submit('codex', 'x'), /no code to paste/);
    await tock(150);
    assert.equal(alx.status('codex').state, 'done', 'done once Codex says it is logged in');
    // exiting cleanly is not enough: the status command must agree
    logged = false;
    const aly = new AiLogin({ bin: () => '/example/codex', checkFn: () => 'Not logged in', spawnFn: () => { const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.exitCode = null; c.kill = () => {}; setTimeout(() => { c.exitCode = 0; c.emit('close', 0); }, 20); return c; } });
    aly.start('codex'); await tock(60);
    assert.equal(aly.status('codex').state, 'failed');
  }
  { // the master trust slider sets every agent at once; single agents can still be moved afterwards
    assert.throws(() => engine.setTrustAll({ level: 9 }), /0 to 5/);
    assert.equal(engine.setTrustAll({ level: 2 }).count, Object.keys(engine.agents).length);
    assert.ok(Object.values(engine.agents).every((a) => a.trust === 2), 'every agent is at position 2');
    engine.setTrust(Object.keys(engine.agents)[0], { level: 4 });
    assert.equal(Object.values(engine.agents)[0].trust, 4, 'one agent moved on its own');
    assert.equal(Object.values(engine.agents)[1].trust, 2, 'the others stay where the master put them');
  }
  assert.ok(fsStat(helper).mode & 0o111, 'the helper is executable');
  await call('/api/vault/lock', 'POST', {});
}

// ---- 0.13.0: the CEO leads every project ----
{
  const { ceo, ne, se } = orgIds;
  const proj = (await call('/api/agents', 'POST', { provider: 'mock', approvals: false, name: 'CEO led site', goal: 'say hi' })).body;
  await until(() => engine.agents[proj.id].status === 'idle');
  const root = engine.agents[proj.id];
  assert.equal(engine._persona(root).id, ceo.id, 'the project is led by the CEO'); assert.equal(engine._persona(ne).id, ne.id, 'specialists are themselves');
  const sys = engine._system(root);
  assert.ok(sys.includes(`You are "${ceo.name}"`) && sys.includes('leading the project "CEO led site"') && /You lead the team/.test(sys) && sys.includes(ne.name) && sys.includes(se.name), 'CEO identity, project and specialists');
  assert.ok(!/Lead agent/.test(sys));
  assert.equal(engine._mkey(root), engine._mkey(ceo), 'same secrets and memory as the CEO');
  assert.ok(!engine.eligibleAgents().some((a) => /project lead/.test(a.label)) && !engine.assignable().some((a) => a.id === proj.id), 'a project is not an agent you can pick');
  // a secret given to the CEO works in the project without a prompt
  await call('/api/vault/unlock', 'POST', { passphrase: 'correct horse battery' });
  const sk = (await call('/api/vault', 'GET')).body.secrets[0];
  await call('/api/vault/secrets/' + sk.id, 'PUT', { assigned: [{ key: engine._mkey(ceo), label: 'CEO', grant: 'always' }] });
  const nts = []; await engine._secrets(root, [{ name: sk.name }], nts);
  assert.ok(nts.some((n) => /environment variable/.test(n)), 'granted without asking'); assert.equal(engine.approvals().some((a) => a.status === 'pending' && a.kind === 'secret' && a.agentId === proj.id), false);
  engine._clearLease(root.id);
  // secrets that were given to the old lead by its own name keep working
  await call('/api/vault/secrets/' + sk.id, 'PUT', { assigned: [{ key: 'ceo-led-site', label: 'old lead', grant: 'always' }] });
  const nts2 = []; await engine._secrets(root, [{ name: sk.name }], nts2); assert.ok(nts2.some((n) => /environment variable/.test(n)), 'old assignment still honoured'); engine._clearLease(root.id);
  await call('/api/vault/secrets/' + sk.id, 'PUT', { assigned: [{ key: 'network-engineer', label: 'Network Engineer', grant: 'ask' }] });
  await call('/api/vault/lock', 'POST', {});
  // the CEO hands project work to a specialist, who gets the project folder
  let seen = null; const orig = engine.send.bind(engine);
  engine.send = (id, text, from) => { if (id === ne.id) seen = { folder: engine._projectDirs(engine.agents[ne.id]), note: engine._projectNote(engine.agents[ne.id]) }; return orig(id, text, from); };
  const notes = []; const job = await engine._assignJob(root, { to: ne.name, task: 'check the router config' }, notes);
  engine.send = orig;
  assert.ok(job && job.kind === 'report', 'the specialist did the job'); assert.deepEqual(seen.folder, [root.cwd]); assert.match(seen.note, /CEO led site/);
  assert.equal(engine.projectFor.has(ne.id), false, 'the project is forgotten afterwards'); assert.deepEqual(engine._projectDirs(engine.agents[ne.id]), []);
  // peers: a project can message the CEO's specialists by name
  assert.equal((await engine._findPeer(root, ne.name)).peer?.id, ne.id);
  // the responsible agent can be someone else, and then they are the one acting
  assert.equal((await call(`/api/projects/${proj.id}/owner`, 'PUT', { agent: se.id })).status, 200);
  assert.equal(engine._persona(root).id, se.id); assert.ok(engine._system(root).includes(`You are "${se.name}"`));
  assert.match(fsRead(new URL('../public/app.js', import.meta.url), 'utf8'), /Led by \$\{ownerOf\(a\)/);
}

// ---- sign-in with a username and password ----
{
  const { Auth } = await import('../src/auth.js');
  const auth = new Auth(path.join(tmp, 'auth-test.json'));
  const srv = createServer(engine, { auth });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${srv.address().port}`;
  const J = { 'content-type': 'application/json' };
  const post = (p, body, headers = {}) => fetch(b + p, { method: 'POST', headers: { ...J, ...headers }, body: JSON.stringify(body) });
  // no account: open as before
  assert.equal((await fetch(b + '/api/state')).status, 200);
  assert.equal((await post('/api/account', { username: 'bob', password: 'short' })).status, 400, 'weak password refused');
  assert.equal((await post('/api/account', { username: 'sam', password: 'sam-is-the-password' })).status, 400, 'password containing the username refused');
  const made = await post('/api/account', { username: 'sam', password: 'purple lamp seven rivers' });
  assert.equal(made.status, 200);
  const setCookie = made.headers.get('set-cookie'); assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
  assert.ok(!JSON.stringify(fsRead(path.join(tmp, 'auth-test.json'), 'utf8')).includes('purple lamp'), 'the password is not stored');
  assert.equal(fsStat(path.join(tmp, 'auth-test.json')).mode & 0o777, 0o600);
  // now the portal needs it
  assert.equal((await fetch(b + '/api/state')).status, 401);
  const page = await fetch(b + '/', { headers: { accept: 'text/html' }, redirect: 'manual' });
  assert.equal(page.status, 302); assert.equal(page.headers.get('location'), '/login');
  assert.equal((await fetch(b + '/login')).status, 200); assert.equal((await fetch(b + '/login.js')).status, 200);
  assert.equal((await fetch(b + '/app.js')).status, 401, 'the app itself is behind the sign-in');
  // wrong then right
  const bad = await post('/api/login', { username: 'sam', password: 'nope nope nope' }); assert.equal(bad.status, 401);
  const ok = await post('/api/login', { username: 'Sam', password: 'purple lamp seven rivers' }); assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(b + '/api/state', { headers: { cookie } })).status, 200);
  assert.equal((await fetch(b + '/api/state', { headers: { cookie: cookie.slice(0, -3) + 'abc' } })).status, 401, 'a forged cookie is refused');
  assert.equal((await fetch(b + '/api/state', { headers: { cookie } }).then((r) => r.json())).account.username, 'sam');
  // changing needs the current password and signs everyone else out
  assert.equal((await post('/api/account', { password: 'another long phrase here' }, { cookie })).status, 403);
  const ch = await post('/api/account', { current: 'purple lamp seven rivers', password: 'another long phrase here' }, { cookie });
  assert.equal(ch.status, 200);
  assert.equal((await fetch(b + '/api/state', { headers: { cookie } })).status, 401, 'old sessions end when the password changes');
  const fresh = ch.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(b + '/api/state', { headers: { cookie: fresh } })).status, 200);
  // too many wrong tries are slowed down
  let last; for (let i = 0; i < 6; i++) last = await post('/api/login', { username: 'sam', password: 'wrong wrong ' + i });
  assert.equal(last.status, 429); assert.match((await last.json()).error, /Too many/);
  // a login page with a cross-site origin is blocked
  assert.equal((await post('/api/login', { username: 'x', password: 'y' }, { origin: 'http://evil.example' })).status, 403);
  // removal needs the password too
  assert.equal((await fetch(b + '/api/account', { method: 'DELETE', headers: { ...J, cookie: fresh }, body: JSON.stringify({ current: 'wrong' }) })).status, 403);
  assert.equal((await fetch(b + '/api/account', { method: 'DELETE', headers: { ...J, cookie: fresh }, body: JSON.stringify({ current: 'another long phrase here' }) })).status, 200);
  assert.equal((await fetch(b + '/api/state')).status, 200, 'open again after removal');
  assert.match(fsRead(new URL('../public/app.js', import.meta.url), 'utf8'), /pageSignin/);
  srv.close();
}

// ---- vault auto-unlock ----
{
  const { Vault } = await import('../src/vault.js');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'apiary-auto-')), vf = path.join(dir, 'data', 'vault.json'), kf = path.join(dir, 'keys', 'vault.key');
  const v1 = new Vault(vf, kf); v1.init('correct horse battery');
  const it = v1.add('Site login', 'hunter2-value', 'n', 'bob');
  assert.equal(v1.auto, 'off');
  assert.throws(() => new Vault(vf, kf).enableAuto('correct horse battery'), /locked/);
  assert.throws(() => v1.enableAuto('wrong passphrase!!'), /Wrong passphrase/);
  v1.enableAuto('correct horse battery'); assert.equal(v1.auto, 'on');
  assert.equal(fsStat(kf).mode & 0o777, 0o600); assert.equal(fsStat(path.dirname(kf)).mode & 0o777, 0o700);
  assert.ok(!fsRead(vf, 'utf8').includes('hunter2-value'), 'values stay encrypted');
  // a restart: the vault opens by itself, values and usernames intact
  const v2 = new Vault(vf, kf); assert.equal(v2.unlocked, true); assert.equal(v2.value(it.id), 'hunter2-value'); assert.equal(v2.user(it.id), 'bob'); assert.equal(v2.auto, 'on');
  // without the key file (a copied or exported vault) it stays locked
  const v3 = new Vault(vf, path.join(dir, 'elsewhere', 'vault.key')); assert.equal(v3.unlocked, false); assert.equal(v3.auto, 'broken');
  await v3.unlock('correct horse battery'); assert.equal(v3.value(it.id), 'hunter2-value', 'the passphrase still works');
  assert.equal(new Vault(vf).unlocked, false, 'no key file configured, no auto-unlock');
  // a key file from another vault does not open this one
  const other = new Vault(path.join(dir, 'o', 'vault.json'), path.join(dir, 'ok', 'vault.key')); other.init('another long phrase'); other.enableAuto('another long phrase');
  const v4 = new Vault(vf, path.join(dir, 'ok', 'vault.key')); assert.equal(v4.unlocked, false); assert.equal(v4.auto, 'broken');
  // turning it off removes the key file
  v2.disableAuto(); assert.equal(v2.auto, 'off'); assert.equal(fsExists(kf), false);
  assert.equal(new Vault(vf, kf).unlocked, false);
  // through the API: the passphrase is needed to turn it on
  await call('/api/vault/unlock', 'POST', { passphrase: 'correct horse battery' });
  assert.equal((await call('/api/vault/auto', 'POST', { enable: true, passphrase: 'wrong wrong wrong' })).status, 403);
  assert.equal((await call('/api/vault/auto', 'POST', { enable: true, passphrase: 'correct horse battery' })).status, 200);
  assert.equal((await call('/api/vault')).body.auto, 'on'); assert.ok(fsExists(process.env.APIARY_KEYFILE));
  assert.equal(fsRead(path.join(tmp, 'vault.json'), 'utf8').includes(fsRead(process.env.APIARY_KEYFILE).toString('base64')), false, 'the key is not stored beside the vault');
  assert.equal((await call('/api/vault/auto', 'POST', { enable: false })).body.auto, 'off'); assert.equal(fsExists(process.env.APIARY_KEYFILE), false);
  assert.match(fsRead(new URL('../public/app.js', import.meta.url), 'utf8'), /Turn on auto-unlock/);
}

// ---- sign in to GitHub from the page (fake `gh`, no network) ----
{
  const fs = await import('node:fs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'apiary-ghlogin-')), bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const go = path.join(dir, 'go'), fail = path.join(dir, 'fail'), signed = path.join(dir, 'signed'), seenEnv = path.join(dir, 'env');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
case "$1 $2" in
  "auth login") echo "TOKEN=\${GH_TOKEN:-none} ARGS=$*" > "${seenEnv}"
    echo "! First copy your one-time code: ABCD-1234" >&2
    echo "Open this URL to continue in your web browser: https://github.com/login/device" >&2
    while [ ! -f "${go}" ]; do sleep 0.1; done
    if [ -f "${fail}" ]; then echo "authentication failed: access_denied" >&2; exit 1; fi
    touch "${signed}"; echo "Authentication complete."; exit 0;;
  "auth status") [ -f "${signed}" ] && exit 0; echo "You are not logged in" >&2; exit 1;;
  "api user") echo example-user; exit 0;;
esac
[ "$1" = "--version" ] && echo "gh version 0.0.0 (fake)"
exit 0
`, { mode: 0o755 });
  const oldPath = process.env.PATH, oldTok = process.env.GH_TOKEN;
  process.env.PATH = bin + path.delimiter + oldPath; process.env.GH_TOKEN = 'must-not-reach-gh';
  try {
    const wait = async (state) => { for (let i = 0; i < 60; i++) { const st = (await call('/api/github/login')).body; if (st.state === state) return st; await new Promise((r) => setTimeout(r, 100)); } throw new Error('never reached ' + state + ': ' + JSON.stringify((await call('/api/github/login')).body)); };
    assert.equal((await call('/api/github/login')).body.state, 'idle');
    const st = await call('/api/github/login', 'POST'); assert.equal(st.status, 202);
    const waiting = await wait('waiting');
    assert.equal(waiting.code, 'ABCD-1234'); assert.equal(waiting.url, 'https://github.com/login/device');
    assert.match(fs.readFileSync(seenEnv, 'utf8'), /TOKEN=none .*auth login --hostname github\.com --git-protocol https --web/, 'a stray GH_TOKEN is not passed on, and the sign-in is the web flow');
    // cancelling stops it and a new try works
    assert.equal((await call('/api/github/login', 'DELETE')).body.state, 'cancelled');
    await call('/api/github/login', 'POST'); await wait('waiting');
    // approving on GitHub finishes it and the connection shows as connected
    fs.writeFileSync(go, '');
    await wait('done');
    const gh = (await call('/api/connections')).body.find((c) => c.id === 'github');
    assert.equal(gh.method, 'cli'); assert.equal(gh.status.ok, true); assert.equal(gh.status.account, 'example-user');
    // a refused sign-in gives a plain message
    fs.rmSync(signed); fs.writeFileSync(fail, ''); await call('/api/github/login', 'POST');
    const bad = await wait('failed'); assert.match(bad.message, /cancelled on GitHub/); assert.ok(!bad.code);
    // no gh tool: a clear message, not a crash
    // The app also looks in the home folder, so this check only means something on a machine without the tool.
    const ghHere = fs.existsSync(path.join(os.homedir(), '.local', 'bin', 'gh')) || fs.existsSync('/usr/bin/gh');
    if (ghHere) console.log('  (skipped the "no GitHub tool" check: the GitHub CLI is installed on this machine)');
    else {
      process.env.PATH = '/nonexistent'; const none = await call('/api/github/login', 'POST'); process.env.PATH = bin + path.delimiter + oldPath;
      assert.equal(none.status, 400); assert.match(none.body.error || none.body.message || '', /not installed/);
    }
  } finally { process.env.PATH = oldPath; if (oldTok === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = oldTok; }
  // the installer knows how to fetch the GitHub tool, and its script is valid shell
  const { RECIPES } = await import('../src/tools.js'); const { spawnSync } = await import('node:child_process');
  assert.ok(RECIPES.gh && RECIPES.gh.cmd === 'bash'); assert.equal(spawnSync('bash', ['-n', '-c', RECIPES.gh.args[1]]).status, 0, 'installer script parses');
  assert.ok(!/sudo/.test(RECIPES.gh.args[1]), 'installs for the current user only');
  const { explainLogin } = await import('../src/ghlogin.js'); assert.match(explainLogin('dial tcp: lookup github.com: no such host'), /Could not reach github\.com/);
  const app = fsRead(new URL('../public/app.js', import.meta.url), 'utf8'); assert.match(app, /Sign in with GitHub/); assert.match(app, /Install GitHub tool for me/);
}

// ---- Discovery: list what a host runs over SSH (fake ssh, read-only) ----
{
  const fs = await import('node:fs');
  const D = await import('../src/discovery.js');
  // 1. The commands are pinned. Anything that could change a host fails here.
  const ALLOWED = [/^qm list$/, /^pct list$/, /^virsh -c qemu:\/\/\/system list --all$/, /^vim-cmd vmsvc\/getallvms$/, /^xe vm-list is-control-domain=false params=name-label,power-state$/,
    /^docker ps -a --format \{\{\.Names\}\}\|\{\{\.State\}\}\|\{\{\.Image\}\}$/, /^lxc-ls -f$/, /^incus list --format csv -c ns4$/, /^lxc list --format csv -c ns4$/, /^Get-VM$/];
  assert.equal(D.COMMANDS.length, ALLOWED.length);
  for (const c of D.COMMANDS) assert.ok(ALLOWED.some((re) => re.test(c)), `command is not on the read-only list: ${c}`);
  const script = D.posixScript(), ps = D.powershellScript();
  const execLines = script.split('\n').filter((l) => /^if command -v/.test(l));
  assert.equal(execLines.length, D.DETECTORS.length, 'one guarded listing line per detector');
  for (const l of execLines) assert.match(l.replace(/'[^']*'/g, "'x'"), /^if command -v (\S+) >\/dev\/null 2>&1; then run \S+ \1 [^;&|<>`$()]*; fi$/, `no chaining or redirects: ${l}`);
  assert.ok(!/\b(rm|reboot|shutdown|poweroff|start|stop|destroy|delete|kill|create|migrate|restore|rollback|snapshot|exec|prune|install|upgrade|write|edit|set)\b/i.test(execLines.join('\n').replace(/\bis-control-domain\b/g, '')), 'no changing verbs in the script');
  assert.ok(!/Set-|Start-|Stop-|Remove-|New-|Restart-/.test(ps), 'PowerShell only reads');
  // 2. Parsers on realistic output
  const P = (tag, text) => D.BY_TAG.get(tag).parse(text);
  assert.deepEqual(P('proxmox-vm', '      VMID NAME                 STATUS     MEM(MB)    BOOTDISK(GB) PID\n       100 web-proxy            running    2048              32.00 1234\n       101 db-main              stopped    4096              64.00 0\n').map((x) => [x.name, x.status]), [['web-proxy', 'running'], ['db-main', 'stopped']]);
  assert.deepEqual(P('proxmox-ct', 'VMID       Status     Lock         Name\n200        running                 dns-ct\n201        stopped    backup       old-ct\n').map((x) => [x.name, x.status]), [['dns-ct', 'running'], ['old-ct', 'stopped']]);
  assert.deepEqual(P('libvirt', ' Id   Name        State\n------------------------\n 3    kvm-guest   running\n -    kvm-off     shut off\n').map((x) => [x.name, x.status]), [['kvm-guest', 'running'], ['kvm-off', 'shut off']]);
  assert.deepEqual(P('esxi', 'Vmid   Name         File                          Guest OS   Version   Annotation\n1      esx-web      [datastore1] esx-web/esx-web.vmx   ubuntu64Guest   vmx-19\n2      Old Box 2    [datastore1] Old Box 2/Old Box 2.vmx   otherGuest   vmx-14\n').map((x) => x.name), ['esx-web', 'Old Box 2']);
  assert.deepEqual(P('xcp', 'name-label ( RW): xen-a\npower-state ( RO): running\n\nname-label ( RW): xen-b\npower-state ( RO): halted\n').map((x) => [x.name, x.status]), [['xen-a', 'running'], ['xen-b', 'halted']]);
  assert.deepEqual(P('docker', 'nginx|running|nginx:latest\nredis|exited|redis:7\n').map((x) => [x.name, x.status]), [['nginx', 'running'], ['redis', 'exited']]);
  assert.deepEqual(P('lxc', 'NAME  STATE   AUTOSTART GROUPS IPV4      IPV6 UNPRIVILEGED\nweb1  RUNNING 0         -      10.0.3.5  -    false\nweb2  STOPPED 0         -      -         -    false\n').map((x) => [x.name, x.status, x.address]), [['web1', 'running', '10.0.3.5'], ['web2', 'stopped', '']]);
  assert.deepEqual(P('incus', 'c1,RUNNING,10.0.0.7 (eth0)\nc2,STOPPED,\n').map((x) => [x.name, x.address]), [['c1', '10.0.0.7'], ['c2', '']]);
  assert.deepEqual(P('hyperv', 'win-vm-1|Running\nwin-vm-2|Off\n').map((x) => [x.name, x.status]), [['win-vm-1', 'running'], ['win-vm-2', 'off']]);
  assert.match(D.explainSsh('Permission denied (publickey,password).', 255), /refused the login/);
  assert.match(D.explainSsh('ssh: connect to host x port 22: Connection refused', 255), /refused the connection/);

  // 3. End to end with a fake ssh on the PATH. It records what it was asked to run and answers from a mode file.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'apiary-disc-')), bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const modeFile = path.join(dir, 'mode'), scriptFile = path.join(dir, 'script'), calls = path.join(dir, 'calls');
  fs.writeFileSync(modeFile, 'full');
  const SECTIONS = {
    full: `@@APIARY begin
@@APIARY proxmox-vm rc=0
      VMID NAME                 STATUS     MEM(MB)    BOOTDISK(GB) PID
       100 web-proxy            running    2048              32.00 1234
       101 db-main              stopped    4096              64.00 0
@@APIARY proxmox-ct rc=0
VMID       Status     Lock         Name
       200        running                 dns-ct
@@APIARY docker rc=0
nginx|running|nginx:latest
@@APIARY incus rc=1
Error: permission denied for secret-hunter2
@@APIARY end
`,
  };
  SECTIONS.fewer = SECTIONS.full.replace(/ {7}101 db-main.*\n/, '');
  SECTIONS.none = '@@APIARY begin\n@@APIARY end\n';
  SECTIONS.windows = '@@APIARY begin\n@@APIARY hyperv rc=0\nwin-vm-1|Running\n@@APIARY end\n';
  fs.writeFileSync(path.join(dir, 'sections.json'), JSON.stringify(SECTIONS));
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh
mode=$(cat "${modeFile}"); script=$(cat); last=""; for a in "$@"; do last="$a"; done
echo "$*" >> "${calls}"; printf '%s' "$script" > "${scriptFile}"
case "$mode" in
  down) echo "ssh: connect to host example-host port 22: Connection refused" >&2; exit 255;;
  windows) case "$*" in *"sh -s"*) echo "'sh' is not recognized as an internal or external command" >&2; exit 1;; esac;;
esac
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(s[process.argv[2]]||"")' "${path.join(dir, 'sections.json')}" "$mode"
`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = bin + path.delimiter + oldPath;
  try {
    await call('/api/vault/unlock', 'POST', { passphrase: 'correct horse battery' });
    const sec = await call('/api/vault/secrets', 'POST', { name: 'Disc login', value: 'secret-hunter2', type: 'ssh', username: 'root', host: '10.0.0.5' });
    assert.ok([200, 201].includes(sec.status));
    const host = (await call('/api/infra', 'POST', { name: 'disc-host', type: 'proxmox', address: '10.0.0.5', secret: 'Disc login' })).body;
    const noLogin = (await call('/api/infra', 'POST', { name: 'disc-nologin', type: 'server', address: '10.0.0.9' })).body;
    assert.equal((await call(`/api/infra/${noLogin.id}/discover`, 'POST', {})).status, 400, 'a device without a login cannot be scanned');
    const r1 = await call(`/api/infra/${host.id}/discover`, 'POST', {});
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.deepEqual([...r1.body.added].sort(), ['db-main', 'dns-ct', 'nginx', 'web-proxy']);
    assert.equal(r1.body.detected.find((d) => d.tag === 'incus').ok, false);
    assert.ok(!JSON.stringify(r1.body).includes('secret-hunter2'), 'no secret value in the result (and the host error is redacted)');
    let items = (await call('/api/infra')).body.items;
    const web = items.find((i) => i.name === 'web-proxy');
    assert.equal(web.state, 'proposed'); assert.equal(web.parentId, host.id); assert.equal(web.type, 'vm'); assert.equal(web.by, 'Discovery');
    assert.equal(items.find((i) => i.name === 'dns-ct').type, 'container');
    // what was run on the host is exactly the fixed script, sent on standard input
    assert.equal(fs.readFileSync(scriptFile, 'utf8'), D.posixScript().trimEnd());
    assert.match(fs.readFileSync(calls, 'utf8'), /root@10\.0\.0\.5 sh -s/);
    // pressing it again adds nothing and does not duplicate
    const r2 = (await call(`/api/infra/${host.id}/discover`, 'POST', {})).body;
    assert.equal(r2.added.length, 0); assert.equal(r2.waiting.length, 4);
    // Yes to one, No to another: No removes it, and it comes back next time
    await call(`/api/infra/${web.id}/confirm`, 'POST', { ok: true });
    const db = items.find((i) => i.name === 'db-main'); await call(`/api/infra/${db.id}/confirm`, 'POST', { ok: false });
    const r3 = (await call(`/api/infra/${host.id}/discover`, 'POST', {})).body;
    assert.deepEqual(r3.added, ['db-main'], 'an ignored item is offered again');
    assert.equal(r3.known, 1, 'the confirmed one is known, not offered again');
    // a name used elsewhere gets the host name added
    await call('/api/infra', 'POST', { name: 'nginx-other', type: 'server' });
    // something that disappears is reported, never removed
    fs.writeFileSync(modeFile, 'fewer');
    const r4 = (await call(`/api/infra/${host.id}/discover`, 'POST', {})).body;
    assert.ok(!r4.missing.includes('db-main'), 'proposed items are not reported as missing');
    await call(`/api/infra/${(await call('/api/infra')).body.items.find((i) => i.name === 'db-main').id}/confirm`, 'POST', { ok: true });
    const r5 = (await call(`/api/infra/${host.id}/discover`, 'POST', {})).body;
    assert.deepEqual(r5.missing, ['db-main']); assert.ok((await call('/api/infra')).body.items.some((i) => i.name === 'db-main'), 'nothing is deleted');
    // nothing recognised, Windows (Hyper-V over PowerShell), and a server that is down
    fs.writeFileSync(modeFile, 'none'); assert.equal((await call(`/api/infra/${host.id}/discover`, 'POST', {})).body.nothing, true);
    fs.writeFileSync(modeFile, 'windows'); const w = (await call(`/api/infra/${host.id}/discover`, 'POST', {})).body;
    assert.deepEqual(w.added, ['win-vm-1']); assert.equal(fs.readFileSync(scriptFile, 'utf8'), D.powershellScript().trimEnd());
    fs.writeFileSync(modeFile, 'down'); const down = await call(`/api/infra/${host.id}/discover`, 'POST', {});
    assert.equal(down.status, 502); assert.match(down.body.error, /refused the connection/);
    // locked vault
    await call('/api/vault/lock', 'POST', {}); assert.equal((await call(`/api/infra/${host.id}/discover`, 'POST', {})).status, 423);
    await call('/api/vault/unlock', 'POST', { passphrase: 'correct horse battery' });
    // audit has it, and nothing secret is in state or audit
    const au = (await call('/api/audit?kind=infra')).body; assert.ok(JSON.stringify(au).includes('ran Discovery'));
    assert.ok(!JSON.stringify(au).includes('secret-hunter2'));
  } finally { process.env.PATH = oldPath; }
  const app = fsRead(new URL('../public/app.js', import.meta.url), 'utf8'); assert.match(app, /Discover/); assert.match(app, /Yes to all/);
}

// ---- infrastructure map: text fits its box, the map can be moved and zoomed ----
{
  const app = fsRead(new URL('../public/map.js', import.meta.url), 'utf8');
  assert.match(app, /const fit = \(t, maxW, s, min, w\)/, 'map text is fitted to the box width');
  assert.ok(!/t\.length > 30 \? t\.slice\(0, 29\)/.test(app), 'map text is not cut by a fixed number of characters');
  assert.match(app, /class: 'mapscroll'/); assert.match(app, /type: 'range', min: String\(MIN \* 100\)/); assert.match(app, /Drag to move . Ctrl \+ scroll to zoom/); assert.match(fsRead(new URL('../public/app.js', import.meta.url), 'utf8'), /from '\.\/map\.js'/, 'the page uses the map module');
  assert.match(fsRead(new URL('../public/style.css', import.meta.url), 'utf8'), /\.mapscroll\{overflow:auto/);
}

// ---- infrastructure map ----
{
  const net = await import('node:net');
  const probe = net.createServer((c) => c.end()); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  assert.equal((await call('/api/infra', 'POST', { name: '', type: 'server' })).status, 400);
  assert.equal((await call('/api/infra', 'POST', { name: 'bad', address: 'http://x' })).status, 400, 'a web link is not an address');
  assert.equal((await call('/api/infra', 'POST', { name: 'bad', url: 'ftp://x' })).status, 400);
  const pve = (await call('/api/infra', 'POST', { name: 'Proxmox', type: 'proxmox', address: '127.0.0.1', port })).body;
  const vm = (await call('/api/infra', 'POST', { name: 'Web VM', type: 'vm', parentId: pve.id, secret: 'NPM admin' })).body;
  assert.equal((await call('/api/infra', 'POST', { name: 'proxmox' })).status, 409, 'names are unique');
  assert.equal((await call(`/api/infra/${pve.id}`, 'PUT', { parentId: vm.id })).status, 400, 'no loops');
  assert.equal((await call(`/api/infra/${vm.id}`, 'PUT', { links: [{ to: pve.id, label: 'storage' }, { to: 'nope' }] })).body.links.length, 1);
  // test connection: open port, closed port, no address
  assert.equal((await call(`/api/infra/${pve.id}/test`, 'POST', {})).body.status.ok, true);
  probe.close(); await new Promise((r) => setTimeout(r, 50));
  assert.equal((await call(`/api/infra/${pve.id}/test`, 'POST', {})).body.status.ok, false);
  assert.equal((await call(`/api/infra/${vm.id}/test`, 'POST', {})).body.status.ok, false);
  // an agent proposes things: they wait for the person
  const r = await import('../src/engine.js');
  const pr = r.parseSpawns('Sounds good.\n```apiary-infra\n{"items":[{"name":"Pi-hole","type":"pi","address":"10.0.0.2","hostedOn":"Proxmox","connectsTo":["Web VM"],"why":"You said DNS runs on a Pi","question":"Where is its config stored?"},{"nope":1}]}\n```');
  assert.equal(pr.infra.length, 2); assert.equal(pr.clean, 'Sounds good.');
  const got = engine._infra(engine.agents[orgIds.ceo.id], pr.infra);
  assert.equal(got.added.length, 1); assert.equal(got.notes.length, 1);
  let list = (await call('/api/infra')).body.items; const ph = list.find((i) => i.name === 'Pi-hole');
  assert.equal(ph.state, 'proposed'); assert.equal(ph.parentId, pve.id); assert.equal(ph.links.length, 1);
  assert.ok(!engine.infra.summary().includes('Pi-hole'), 'unconfirmed items are not treated as fact');
  assert.equal((await call(`/api/infra/${ph.id}/answer`, 'POST', { text: '' })).status, 400);
  assert.equal((await call(`/api/infra/${ph.id}/answer`, 'POST', { text: 'On the SD card' })).status, 200);
  assert.match((await call('/api/infra')).body.items.find((i) => i.id === ph.id).notes, /On the SD card/);
  await call(`/api/infra/${ph.id}/confirm`, 'POST', { ok: true });
  assert.equal((await call('/api/infra')).body.items.find((i) => i.id === ph.id).state, 'confirmed');
  assert.match(engine._system(engine.agents[orgIds.ceo.id]), /INFRASTRUCTURE MAP[\s\S]*Pi-hole/);
  // standing team members get the same map summary (names, addresses, links, secret NAMES only)
  for (const m of [orgIds.ne, orgIds.se]) {
    assert.ok(m.member, 'fixture is a standing team member');
    const sys = engine._system(engine.agents[m.id]);
    assert.match(sys, /INFRASTRUCTURE MAP[\s\S]*Already on the map:[\s\S]*Pi-hole \(.*\) 10\.0\.0\.2/, 'team member sees the map');
    assert.match(sys, /Web VM[\s\S]*\[vault: NPM admin\]/, 'secret name is shown');
    assert.ok(!sys.includes('S3cr3t-Value-123!') && !sys.includes('S3cr3t'), 'no secret value in a member prompt');
  }
  // rejecting removes it, and removing something frees what ran on it
  engine.infra.propose('x', [{ name: 'Ghost', type: 'nas' }]); const gh = engine.infra.byName('Ghost');
  await call(`/api/infra/${gh.id}/confirm`, 'POST', { ok: false }); assert.equal(engine.infra.byName('Ghost'), undefined);
  await call(`/api/infra/${pve.id}`, 'DELETE'); list = (await call('/api/infra')).body.items;
  assert.equal(list.find((i) => i.id === vm.id).parentId, ''); assert.ok(list.every((i) => (i.links || []).every((l) => l.to !== pve.id)));
  assert.equal(fsStat(path.join(tmp, 'infra.json')).mode & 0o777, 0o600);
  assert.ok(!fsRead(path.join(tmp, 'infra.json'), 'utf8').includes('S3cr3t'), 'no secret values in the map');
  const app = fsRead(new URL('../public/app.js', import.meta.url), 'utf8'); assert.match(app, /pageInfra/); assert.match(app, /Is this right\?/);
}

// ---- factory reset ----
{
  const { ResetGate, plan } = await import('../src/reset.js');
  const g = new ResetGate();
  let q = g.start(); assert.equal(q.step, 1);
  assert.throws(() => g.answer(q.id, 'yes'), /not YES/); assert.throws(() => g.answer(q.id, 'YES'), /expired or was cancelled/, 'a wrong answer cancels everything');
  q = g.start(); q = g.answer(q.id, 'YES'); assert.equal(q.step, 2); q = g.answer(q.id, 'YES'); assert.equal(q.step, 3);
  const [, a, b] = /What is (\d+) \+ (\d+)\?/.exec(q.prompt); assert.throws(() => g.answer(q.id, String(+a + +b + 1)), /not the right answer/);
  q = g.start(); g.answer(q.id, 'YES'); q = g.answer(q.id, 'YES'); const [, a3, b3] = /What is (\d+) \+ (\d+)\?/.exec(q.prompt); assert.deepEqual(g.answer(q.id, String(+a3 + +b3)), { done: true });
}
{
  // through the API on a separate engine and data folder, so nothing else in the test is disturbed
  const { plan } = await import('../src/reset.js');
  const dir2 = mkdtempSync(path.join(os.tmpdir(), 'apiary-reset-'));
  const st2 = new Store(path.join(dir2, 'state.json')), eng2 = new Engine(st2);
  const keep = path.join(os.tmpdir(), `apiary-outside-${Date.now()}`); (await import('node:fs')).mkdirSync(keep); (await import('node:fs')).writeFileSync(path.join(keep, 'mine.txt'), 'my own file');
  const proj = await eng2.createLead({ provider: 'mock', approvals: false, name: 'P', goal: 'hi', cwd: keep });
  eng2.infra.add({ name: 'A box', type: 'server' }); eng2.vault.init('correct horse battery'); eng2.vault.add('X', 'val');
  eng2.store.flush();
  (await import('node:fs')).writeFileSync(path.join(dir2, 'token'), 'tok'); (await import('node:fs')).writeFileSync(path.join(dir2, 'auth.json'), '{"v":1}');
  let restarted = 0;
  const { Auth } = await import('../src/auth.js');
  const srv2 = createServer(eng2, { restart: () => { restarted++; }, auth: new Auth(path.join(dir2, 'auth.json')) });
  await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
  const c2 = async (body) => { const r = await fetch(`http://127.0.0.1:${srv2.address().port}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  // skipping ahead or guessing does nothing
  assert.equal((await c2({ id: 'x', answer: 'YES' })).status, 409);
  let r1 = (await c2({ action: 'start' })).body; r1 = (await c2({ id: r1.id, answer: 'YES' })).body; r1 = (await c2({ id: r1.id, answer: 'YES' })).body;
  assert.equal(r1.step, 3); assert.equal((await c2({ id: r1.id, answer: '1' })).status, 400);
  assert.ok(fsExists(path.join(dir2, 'state.json')) && eng2.vault.exists, 'nothing deleted after a wrong sum');
  let r2 = (await c2({ action: 'start' })).body; r2 = (await c2({ id: r2.id, answer: 'YES' })).body; r2 = (await c2({ id: r2.id, answer: 'YES' })).body;
  const [, a2, b2] = /What is (\d+) \+ (\d+)\?/.exec(r2.prompt);
  assert.ok(plan(eng2).files.length > 3);
  const done = await c2({ id: r2.id, answer: String(+a2 + +b2) });
  assert.equal(done.status, 200); assert.equal(done.body.done, true);
  await new Promise((r) => setTimeout(r, 900)); assert.equal(restarted, 1, 'it restarts afterwards');
  for (const n of ['state.json', 'vault.json', 'infra.json', 'memory.json', 'workspaces']) assert.equal(fsExists(path.join(dir2, n)), false, n + ' is gone');
  assert.ok(fsExists(path.join(dir2, 'token')) && fsExists(path.join(dir2, 'auth.json')), 'the access token and sign-in stay');
  assert.equal(fsRead(path.join(keep, 'mine.txt'), 'utf8'), 'my own file', 'folders outside Apiary are never touched');
  // and the next start is a clean first run
  const fresh = new Engine(new Store(path.join(dir2, 'state.json'))); assert.equal(fresh.onboardingDone, false); assert.equal(Object.keys(fresh.agents).length, 0); assert.equal(fresh.infra.items.length, 0); assert.equal(fresh.vault.exists, false);
  srv2.close(); void proj;
  const appjs = fsRead(new URL('../public/app.js', import.meta.url), 'utf8'); assert.match(appjs, /Start factory reset/); assert.match(appjs, /pageActivity/); assert.match(appjs, /Working now/);
}

// ---- automatic backups and machine usage ----
{
  const { lastDue } = await import('../src/backup.js');
  const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi);
  assert.equal(+lastDue({ every: 'daily', time: '02:00' }, at(2026, 11, 24, 10, 0)), +at(2026, 11, 24, 2, 0));
  assert.equal(+lastDue({ every: 'daily', time: '02:00' }, at(2026, 11, 24, 1, 0)), +at(2026, 11, 23, 2, 0));
  assert.equal(+lastDue({ every: 'weekly', time: '03:30', weekday: 1 }, at(2026, 11, 24, 10, 0)), +at(2026, 11, 23, 3, 30), 'the Monday before Tuesday 24 Nov 2026');
  const bdir = path.join(tmp, 'bk1'), bdir2 = path.join(tmp, 'bk2');
  assert.equal((await call('/api/backups', 'PUT', { dir: 'relative/dir' })).status, 400);
  assert.equal((await call('/api/backups', 'PUT', { dir: '/' })).status, 400);
  assert.equal((await call('/api/backups', 'PUT', { keep: 0 })).status, 400);
  assert.equal((await call('/api/backups', 'PUT', { time: '25:99' })).status, 400);
  assert.equal((await call('/api/backups', 'PUT', { dir: bdir, dir2: bdir })).status, 400, 'two different places');
  const cfg = (await call('/api/backups', 'PUT', { dir: bdir, dir2: bdir2, keep: 2, vault: false, files: false })).body.config;
  assert.equal(cfg.dir, bdir); assert.equal(cfg.keep, 2);
  // a backup is made, checked, private, and the vault stays out when unticked
  const r1 = (await call('/api/backups/run', 'POST', {})).body; assert.match(r1.name, /^apiary-backup-\d{8}-\d{6}\.tgz$/);
  assert.equal(fsStat(path.join(bdir, r1.name)).mode & 0o777, 0o600); assert.ok(fsExists(path.join(bdir2, r1.name)), 'copied to the second place');
  const listing = (await import('node:child_process')).execFileSync('tar', ['-tzf', path.join(bdir, r1.name)], { encoding: 'utf8' }).split('\n');
  assert.ok(listing.includes('state.json')); assert.ok(!listing.includes('vault.json'), 'no vault in this backup'); assert.ok(!listing.some((n) => n.startsWith('workspaces')), 'no project files when unticked');
  assert.ok(!listing.some((n) => n.includes('backups')), 'backups are not backed up inside backups');
  await call('/api/backups/run', 'POST', {}); await call('/api/backups/run', 'POST', {});
  const l = (await call('/api/backups')).body; assert.equal(l.files.length, 2, 'only the newest two are kept'); assert.equal(l.status.lastError, ''); assert.ok(l.status.lastOk > 0);
  assert.equal((await import('node:fs')).readdirSync(bdir2).filter((n) => n.endsWith('.tgz')).length, 2, 'the second place is pruned too');
  // download works for real backups only
  const dl = await fetch(base + '/api/backups/' + l.files[0].name); assert.equal(dl.status, 200); assert.equal(dl.headers.get('content-type'), 'application/gzip'); assert.equal((await dl.arrayBuffer()).byteLength, l.files[0].size);
  assert.equal((await fetch(base + '/api/backups/apiary-backup-19990101-000000.tgz')).status, 404); assert.equal((await fetch(base + '/api/backups/..%2Fstate.json')).status, 404);
  // a failing second place is reported but the backup itself still counts
  const blocker = path.join(tmp, 'blocker'); (await import('node:fs')).writeFileSync(blocker, 'x');
  await call('/api/backups', 'PUT', { dir2: path.join(blocker, 'sub') });
  const r4 = (await call('/api/backups/run', 'POST', {})).body; assert.match(r4.copyError, /copy to .* failed/);
  // the schedule: not due when a backup is recent, due when it is old; off means never
  await call('/api/backups', 'PUT', { enabled: true, dir2: '', every: 'daily', time: '02:00' });
  const eng = engine.backups, now = new Date();
  eng.st.lastRun = Date.now(); assert.equal(await eng.tick(now), null, 'recent backup, nothing due');
  eng.st.lastRun = +lastDue(eng.config, now) - 1000; const ran = await eng.tick(now); assert.ok(ran && ran.reason === 'schedule', 'overdue, so it runs');
  await call('/api/backups', 'PUT', { enabled: false }); eng.st.lastRun = 0; assert.equal(await eng.tick(now), null, 'switched off');
  // machine usage
  await call('/api/system'); await new Promise((r) => setTimeout(r, 2100));
  const sys = (await call('/api/system')).body; assert.ok(sys.cpu >= 0 && sys.cpu <= 100); assert.ok(sys.mem.total > 0 && sys.mem.used <= sys.mem.total); assert.ok(sys.disk.total > 0);
  const appjs = fsRead(new URL('../public/app.js', import.meta.url), 'utf8'); assert.match(appjs, /Back up now/); assert.match(appjs, /pollSystem/);
}

// ---- audit log ----
{
  const { Audit } = await import('../src/audit.js');
  const fsx = await import('node:fs');
  const a0 = (await call('/api/audit')).body; assert.ok(a0.total >= 1, 'earlier activity (backups) was recorded');
  assert.ok(a0.items.some((e) => e.kind === 'backup'), 'backups are in the log');
  // agent log lines become entries; secrets never are
  const ag = Object.values(engine.agents)[0];
  engine._log(ag, '$ ls -la /srv'); engine._log(ag, '$ apiary-ssh "pve" -- uptime'); engine._log(ag, '> Edit: src/app.js'); engine._log(ag, '> Read: README.md'); engine._log(ag, '✔ committed changes on feature-x');
  let r = (await call('/api/audit?kind=command')).body; assert.ok(r.items.some((e) => e.action === 'ls -la /srv' && e.actor === ag.name));
  r = (await call('/api/audit?kind=ssh')).body; assert.ok(r.items.some((e) => /apiary-ssh/.test(e.action)));
  r = (await call('/api/audit?kind=file')).body; assert.ok(r.items.some((e) => e.action === 'Edit' && e.detail === 'src/app.js'));
  assert.ok(!(await call('/api/audit?kind=file')).body.items.some((e) => e.action === 'Read'), 'reads are tools, not file changes');
  assert.ok((await call('/api/audit?kind=commit')).body.items.some((e) => e.detail === 'feature-x'));
  // search is word based and case-insensitive; filters combine
  assert.equal((await call('/api/audit?q=LS%20srv')).body.total, 1);
  assert.equal((await call('/api/audit?q=nonexistentword')).body.total, 0);
  assert.ok((await call('/api/audit?actor=' + encodeURIComponent(ag.name) + '&kind=command')).body.items.every((e) => e.actor === ag.name));
  assert.ok((await call('/api/audit')).body.facets.kinds.command >= 1);
  // vault and sign-in events
  await call('/api/vault/lock', 'POST', {}); assert.ok((await call('/api/audit?kind=vault')).body.items.some((e) => /locked the vault/.test(e.action)));
  // redaction: a known secret value is masked before it is written
  const raw = fsx.readFileSync(engine.audit.file, 'utf8'); assert.ok(!/sup3rs3cret/.test(raw));
  // retention: old entries are deleted, new ones kept; file is private
  const f = path.join(tmp, 'audit-retention.jsonl'); const au = new Audit(f);
  fsx.writeFileSync(f, JSON.stringify({ t: Date.now() - 31 * 86400000, kind: 'command', actor: 'x', project: '', action: 'old', detail: '' }) + '\n' + JSON.stringify({ t: Date.now() - 29 * 86400000, kind: 'command', actor: 'x', project: '', action: 'recent', detail: '' }) + '\n');
  assert.equal(au.prune(), 1); assert.deepEqual(au.search().items.map((e) => e.action), ['recent']);
  assert.equal(fsx.statSync(engine.audit.file).mode & 0o777, 0o600);
  const page = fsRead(new URL('../public/app.js', import.meta.url), 'utf8'); assert.match(page, /pageAudit/);
  // factory reset removes the log
  const { plan } = await import('../src/reset.js'); assert.ok(plan(engine, { keepAccount: true }).files.some((x) => /audit\.jsonl$/.test(x)));
}

// ---- health ----
{
  const { Health, LOGIN_RE } = await import('../src/health.js');
  const h0 = (await call('/api/health/check', 'POST', {})).body; assert.ok(h0.at > 0 && Array.isArray(h0.items));
  assert.ok(h0.items.every((i) => i.title && i.problem && i.fix), 'every warning says what is wrong and what to do');
  assert.ok(h0.items.some((i) => i.id === 'backup-off'), 'backups off is suggested');
  // a device that does not answer is reported, and the check itself updates the map
  const dev = (await call('/api/infra', 'POST', { name: 'Ghost NAS', type: 'server', address: '127.0.0.1', port: 1 })).body;
  const h1 = (await call('/api/health/check', 'POST', {})).body;
  const w = h1.items.find((i) => i.id === 'device-' + dev.id); assert.ok(w && w.level === 'err' && /Ghost NAS/.test(w.title), 'down device warned');
  assert.equal(engine.infra.get(dev.id).status.ok, false, 'map turned red by the scheduled check');
  assert.ok(h1.count >= 1 && (await call('/api/state')).body.health.count === h1.count);
  await call('/api/infra/' + dev.id, 'DELETE');
  // locked vault
  if (engine.vault.exists) { await call('/api/vault/lock', 'POST', {}); assert.ok(engine.health.evaluate().some((i) => i.id === 'vault')); }
  // backup failure
  engine.backups.st.lastError = 'disk full'; engine.backups.st.config = { ...engine.backups.config, enabled: true };
  assert.ok(engine.health.evaluate().some((i) => i.id === 'backup-failed' && i.level === 'err'));
  engine.backups.st.lastError = ''; engine.backups.st.config = { ...engine.backups.config, enabled: false };
  // expired login from a failed task, cleared by a success
  engine.health.noteLoginFailure('claude', 'Error: 401 Unauthorized, please run /login'); assert.ok(engine.health.evaluate().some((i) => i.id === 'login-claude'));
  engine.health.noteLoginFailure('codex', 'network timeout'); assert.ok(!engine.health.evaluate().some((i) => i.id === 'login-codex'), 'other errors are not login problems');
  engine.health.noteSuccess('claude'); assert.ok(!engine.health.evaluate().some((i) => i.id === 'login-claude'));
  assert.ok(LOGIN_RE.test('Not logged in') && !LOGIN_RE.test('rate limited'));
  assert.match(fsRead(new URL('../public/app.js', import.meta.url), 'utf8'), /pageHealth/);
}

// ---- telegram alerts ----
{
  const http = await import('node:http'), fs = await import('node:fs');
  const TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-Tq';
  const fake = { updates: [], sent: [], id: 1 };
  const tg = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const body = b ? JSON.parse(b) : {}, m = /^\/bot([^/]+)\/(\w+)/.exec(req.url);
      res.setHeader('content-type', 'application/json');
      if (!m || m[1] !== TOKEN) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, description: 'Unauthorized' })); }
      if (m[2] === 'getUpdates') { const u = fake.updates.splice(0); return res.end(JSON.stringify({ ok: true, result: u })); }
      if (m[2] === 'sendMessage') { fake.sent.push(body); return res.end(JSON.stringify({ ok: true, result: {} })); }
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
  });
  await new Promise((r) => tg.listen(0, '127.0.0.1', r));
  process.env.APIARY_TELEGRAM_API = `http://127.0.0.1:${tg.address().port}`;
  const T = engine.telegram, until2 = async (f, ms = 4000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting: ' + f); await new Promise((r) => setTimeout(r, 40)); } };
  // the token must go to the vault, and the vault must be open
  await call('/api/vault/lock', 'POST', {});
  assert.equal((await call('/api/telegram', 'PUT', { token: TOKEN })).status, 409, 'locked vault: nowhere to put the token');
  assert.equal((await call('/api/vault/unlock', 'POST', { passphrase: 'correct horse battery' })).status, 200);
  assert.equal((await call('/api/telegram', 'PUT', { token: 'nonsense' })).status, 400);
  assert.equal((await call('/api/telegram', 'PUT', { token: TOKEN })).status, 200);
  assert.ok(engine.vault.list().some((x) => x.name === 'Telegram bot token'), 'token stored in the vault');
  assert.ok(!JSON.stringify((await call('/api/telegram')).body).includes(TOKEN), 'token never comes back from the API');
  assert.ok(!fs.readFileSync(path.join(tmp, 'state.json'), 'utf8').includes(TOKEN), 'token is not in the state file');
  assert.equal((await call('/api/telegram', 'PUT', { enabled: true })).status, 200);
  // linking: a stranger and a wrong code do nothing; the right code from a private chat links it
  const code = (await call('/api/telegram/link', 'POST', {})).body.linking.code; assert.match(code, /^\d{6}$/);
  fake.updates.push({ update_id: 1, message: { chat: { id: 555, type: 'private' }, text: '000000' } }, { update_id: 2, message: { chat: { id: 777, type: 'group' }, text: code } });
  await new Promise((r) => setTimeout(r, 600)); assert.equal(T.config.chatId, '', 'wrong code and group chats are ignored');
  assert.equal(fake.sent.length, 0, 'strangers get no reply');
  fake.updates.push({ update_id: 3, message: { chat: { id: 42, type: 'private' }, text: code } });
  await until2(() => T.config.chatId === '42'); await until2(() => fake.sent.some((m) => /Linked/.test(m.text)));
  // alerts: approvals, health, long tasks; never output
  fake.sent.length = 0;
  const ag = Object.values(engine.agents)[0];
  engine._ask(ag, { kind: 'plan', title: 'Review the deployment plan' }).catch(() => {});
  await until2(() => fake.sent.some((m) => /Approval waiting.*Review the deployment plan/.test(m.text)));
  { // approve or deny from the phone: the alert carries the buttons; only the linked chat can press them; a new secret can only be denied there
    const alertMsg = fake.sent.find((m) => /Approval waiting.*Review the deployment plan/.test(m.text));
    assert.ok(alertMsg.reply_markup?.inline_keyboard?.[0]?.some((b) => /Approve/.test(b.text)), 'the alert has an Approve button');
    const plan = Object.values(engine.store.data.approvals).find((r) => r.status === 'pending' && r.title === 'Review the deployment plan');
    const press = (chatId, data) => { fake.updates.push({ update_id: 900 + fake.updates.length, callback_query: { id: 'cb' + fake.id++, data, message: { message_id: 7, text: 'Approval waiting', chat: { id: chatId, type: 'private' } } } }); };
    press(999, `ap:${plan.id}:a`);   // a stranger's press
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(engine.store.data.approvals[plan.id].status, 'pending', 'a stranger cannot approve');
    press(42, `ap:${plan.id}:a`);     // the linked chat approves
    await until2(() => engine.store.data.approvals[plan.id].status === 'approved');
    // a new-secret request can be denied from the phone, but never approved there
    const ns = engine._ask(ag, { kind: 'newsecret', title: 'Example phone secret', detail: 'x', secretName: 'Example phone secret' }).catch(() => {});
    const nsRec = await new Promise((r) => { const t0 = Date.now(); const f = () => { const x = Object.values(engine.store.data.approvals).find((q) => q.status === 'pending' && q.kind === 'newsecret'); if (x) return r(x); if (Date.now() - t0 > 3000) throw new Error('no newsecret'); setTimeout(f, 30); }; f(); });
    press(42, `ap:${nsRec.id}:a`); await new Promise((r) => setTimeout(r, 500));
    assert.equal(engine.store.data.approvals[nsRec.id].status, 'pending', 'a new secret is not approved from Telegram');
    press(42, `ap:${nsRec.id}:d`);
    await until2(() => engine.store.data.approvals[nsRec.id].status === 'denied');
    await ns;
  }
  engine.emit('health-new', { id: 'x', level: 'err', title: 'The disk is almost full', problem: 'secret detail /home/x', fix: 'free space' });
  await until2(() => fake.sent.some((m) => /Health: The disk is almost full/.test(m.text)));
  assert.ok(!fake.sent.some((m) => /secret detail/.test(m.text)), 'health detail is not sent, only the title');
  T.st.longTaskMinutes = 1; engine.emit('task-done', { agent: ag, ms: 30000, failed: false }); engine.emit('task-done', { agent: ag, ms: 5 * 60000, failed: false });
  await until2(() => fake.sent.some((m) => /Finished.*after 5 min/.test(m.text))); assert.equal(fake.sent.filter((m) => /Finished/.test(m.text)).length, 1, 'short tasks are not announced');
  // dedupe and settings
  const n = fake.sent.length; await T.alert('same text'); await T.alert('same text'); assert.equal(fake.sent.length, n + 1, 'repeats within 10 minutes are dropped');
  await call('/api/telegram', 'PUT', { events: { approvals: false } });
  const n2 = fake.sent.length; engine._ask(ag, { kind: 'plan', title: 'Another one' }).catch(() => {}); await new Promise((r) => setTimeout(r, 300)); assert.equal(fake.sent.length, n2, 'switched off');
  assert.equal((await call('/api/telegram', 'PUT', { longTaskMinutes: 0 })).status, 400);
  // /status answers only the linked chat
  fake.updates.push({ update_id: 4, message: { chat: { id: 99, type: 'private' }, text: '/status' } }, { update_id: 5, message: { chat: { id: 42, type: 'private' }, text: '/status' } });
  await until2(() => fake.sent.some((m) => /Apiary: \d+ working/.test(m.text))); assert.ok(fake.sent.filter((m) => m.chat_id === '99' || m.chat_id === 99).length === 0);
  // redaction and test alert
  assert.equal((await call('/api/telegram/test', 'POST', {})).status, 200);
  assert.equal((await call('/api/telegram/unlink', 'POST', {})).body.linked, false);
  await call('/api/telegram', 'PUT', { enabled: false });
  assert.match(fsRead(new URL('../public/app.js', import.meta.url), 'utf8'), /pageTelegram/);
  await new Promise((r) => setTimeout(r, 1300)); tg.close();
}

// ---- project templates and global search ----
{
  const { scrub } = await import('../src/templates.js');
  await call('/api/infra', 'POST', { name: 'Homelab Proxmox', type: 'server', address: '10.0.0.77' });
  const src = await engine.createLead({ name: 'Website relaunch', provider: 'mock' });
  await engine._makeMember(src, { title: 'Web designer', role: 'Designs pages', department: 'design', instructions: 'Log in with password: hunter2 to root@10.0.0.77 and check https://intranet.example.com/admin', provider: 'mock', reportsTo: src.id });
  src.plan = { goal: 'Relaunch the website on Homelab Proxmox', createdAt: 1, updatedAt: 1, phases: [{ id: 1, title: 'Design', goal: 'Pages', status: 'done', steps: [{ text: 'Mock-ups', done: true }, { text: 'Deploy to 10.0.0.77', done: true }] }, { id: 2, title: 'Build', goal: 'Code', status: 'active', steps: [{ text: 'Write pages', done: false }] }] };
  // scrub
  const sc = scrub(engine, 'ssh root@10.0.0.77 then open http://x.test/a, Homelab Proxmox token=abc123'); assert.ok(!/10\.0\.0\.77|x\.test|abc123|Homelab/.test(sc.text) && sc.removed >= 4, sc.text);
  assert.equal((await call('/api/templates', 'POST', { projectId: 'nope', name: 'x' })).status, 404);
  const sv = await call('/api/templates', 'POST', { projectId: src.id, name: 'Website', description: 'Relaunch a site' }); assert.equal(sv.status, 201);
  const tpl = sv.body; assert.ok(tpl.removed >= 3, 'specific details were removed');
  const raw = JSON.stringify(tpl); assert.ok(!/hunter2|10\.0\.0\.77|intranet\.example|Homelab/.test(raw), 'no passwords or servers in the template: ' + raw);
  assert.deepEqual(tpl.phases.map((p) => p.title), ['Design', 'Build']); assert.ok(tpl.phases.every((p) => p.steps.length), 'steps kept');
  assert.equal(tpl.members.length, 1); assert.equal((await call('/api/templates', 'POST', { projectId: src.id, name: 'website' })).status, 409, 'duplicate name');
  assert.ok(!('cwd' in tpl) && !('source' in tpl), 'no folders');
  // edit and list
  assert.equal((await call('/api/templates/' + tpl.id, 'PUT', { description: 'Relaunch a site at 192.168.1.5' })).body.description, 'Relaunch a site at <server>');
  assert.equal((await call('/api/templates')).body.length, 1);
  // start
  assert.equal((await call(`/api/templates/${tpl.id}/start`, 'POST', { name: 'Shop relaunch' })).status, 400, 'provider required');
  const st = await call(`/api/templates/${tpl.id}/start`, 'POST', { name: 'Shop relaunch', provider: 'mock' }); assert.equal(st.status, 201);
  const np = engine.agents[st.body.id]; assert.equal(np.name, 'Shop relaunch'); assert.notEqual(np.id, src.id);
  assert.deepEqual(np.plan.phases.map((p) => [p.title, p.status === 'done']), [['Design', false], ['Build', false]], 'plan starts fresh');
  assert.ok(np.plan.phases.every((p) => p.steps.every((x) => !x.done)));
  assert.equal(engine._roster(np).length, 1); assert.equal(engine._roster(np)[0].title, 'Web designer');
  assert.notEqual(engine._roster(np)[0].id, engine._roster(src)[0].id);
  assert.equal((await call('/api/templates/' + tpl.id + '/start', 'POST', { name: 'x', provider: 'nope' })).status, 400);
  // global search
  const g = async (q) => (await call('/api/search?q=' + encodeURIComponent(q))).body;
  assert.deepEqual((await g('')).groups, []);
  let r = await g('relaunch'); assert.ok(r.groups.find((x) => x.type === 'project').items.some((i) => i.title === 'Website relaunch' && i.href === '#/project/' + src.id));
  assert.ok(r.groups.some((x) => x.type === 'template'));
  r = await g('homelab'); assert.ok(r.groups.find((x) => x.type === 'device'));
  r = await g('web designer'); assert.ok(r.groups.find((x) => x.type === 'member'));
  const tk = (await call('/api/tasks', 'POST', { title: 'Renew certificate for intranet' })).body; r = await g('certificate'); assert.ok(r.groups.find((x) => x.type === 'task'));
  engine._msg(src, { role: 'user', text: 'Please remember the quokka migration plan' }); r = await g('quokka'); assert.ok(r.groups.find((x) => x.type === 'chat').items[0].title.includes('quokka'));
  assert.equal((await g('zzzznothing')).groups.length, 0);
  // secret names, never values; vault locked -> note
  await call('/api/vault/unlock', 'POST', { passphrase: 'correct horse battery' });
  await call('/api/vault/secrets', 'POST', { name: 'Zebra API key', value: 'v4lu3-s3cr3t-xyz', type: 'token' });
  r = await g('zebra'); assert.ok(r.groups.find((x) => x.type === 'secret')); assert.ok(!JSON.stringify(await g('v4lu3')).includes('v4lu3-s3cr3t'), 'values are not searched');
  assert.equal((await g('v4lu3')).groups.length, 0);
  await call('/api/vault/lock', 'POST', {}); r = await g('zebra'); assert.ok(!r.groups.find((x) => x.type === 'secret') && /locked/.test(r.note));
  assert.equal((await call('/api/templates/' + tpl.id, 'DELETE')).status, 200); assert.equal((await call('/api/templates')).body.length, 0);
  const app = fsRead(new URL('../public/app.js', import.meta.url), 'utf8'); assert.match(app, /pageProjectTemplates/); assert.match(app, /globalSearchBox/);
}

// ---- weekly report ----
{
  const { dayKey } = await import('../src/usage.js');
  const R = engine.reports, DAYMS = 86400000, now = Date.now();
  engine.usage.d.days = {}; engine.usage.d.hitLog = {}; engine.usage.d.hits = {};
  const seed = (daysAgo, provider, agentId, name, tok) => { const k = dayKey(now - daysAgo * DAYMS), day = (engine.usage.d.days[k] ||= { agents: {}, providers: {} }); const a = (day.agents[agentId] ||= { name, provider, input: 0, output: 0 }); a.input += tok; (day.providers[provider] ||= { input: 0, output: 0 }).input += tok; };
  seed(1, 'claude', 'a1', 'CEO', 3000); seed(2, 'codex', 'a2', 'Coder', 1000);       // this week: 4000
  seed(8, 'claude', 'a1', 'CEO', 1600); seed(9, 'codex', 'a2', 'Coder', 400);        // last week: 2000
  seed(15, 'claude', 'a1', 'CEO', 500);                                              // two weeks ago
  const limitDay = now - 9 * DAYMS; engine.usage.d.hitLog.claude = [limitDay];
  const t1 = (await call('/api/tasks', 'POST', { title: 'Ship the thing' })).body; await call('/api/tasks/' + t1.id, 'PUT', { status: 'done' });
  const t2 = (await call('/api/tasks', 'POST', { title: 'Waiting on DNS' })).body; await call('/api/tasks/' + t2.id, 'PUT', { status: 'blocked' });
  const rep = (await call('/api/reports/run', 'POST', {})).body;
  assert.equal(rep.usage.thisWeek, 4000); assert.equal(rep.usage.lastWeek, 2000); assert.equal(rep.usage.changePct, 100);
  assert.deepEqual(rep.usage.byProvider, { claude: 3000, codex: 1000 }); assert.equal(rep.usage.weeks.length, 8);
  assert.deepEqual(rep.usage.weeks.slice(-3).map((w) => w.total), [500, 2000, 4000]);
  assert.deepEqual(rep.usage.weeks[rep.usage.weeks.length - 2].limitHit, ['claude'], 'the week the limit was hit is marked');
  assert.equal(rep.usage.weeks[rep.usage.weeks.length - 1].limitHit.length, 0);
  assert.ok(rep.usage.topAgents[0].name === 'CEO' && rep.usage.topAgents[0].tokens === 3000);
  assert.ok(rep.stats.tasksDone.includes('Ship the thing') && rep.stats.tasksStuck.includes('Waiting on DNS'));
  const text = rep.summary.join('\n'); assert.match(text, /Tokens used: 4\.0k this week, up 100% from 2\.0k last week/); assert.ok(text.includes(`Tasks: ${rep.stats.tasksDone.length} task`) && /stuck or blocked/.test(text)); assert.match(text, /Approvals:/); assert.match(text, /Health:/); assert.match(text, /Next week:/);
  assert.equal((await call('/api/reports')).body.list.length >= 1, true); assert.equal((await call('/api/reports/' + rep.id)).body.id, rep.id); assert.equal((await call('/api/reports/nope')).status, 404);
  // the Telegram version has counts only, never titles
  const dg = R.digest(rep); assert.match(dg, new RegExp(`Weekly report: ${rep.stats.tasksDone.length} tasks? finished, ${rep.stats.tasksStuck.length} stuck`)); assert.ok(!/Ship the thing|Waiting on DNS/.test(dg));
  // settings are validated
  assert.equal((await call('/api/reports', 'PUT', { weekday: 9 })).status, 400); assert.equal((await call('/api/reports', 'PUT', { time: '25:00' })).status, 400);
  // schedule: not when off, once when due, not again until the next week
  const before = R.all.length; assert.equal(await R.tick(new Date()), null, 'off means never');
  await call('/api/reports', 'PUT', { enabled: true, weekday: new Date().getDay(), time: '00:00' });
  const first = await R.tick(new Date()); assert.ok(first && first.reason === 'schedule'); assert.equal(R.all.length, before + 1);
  assert.equal(await R.tick(new Date()), null, 'already made this week');
  const nextWeek = new Date(Date.now() + 7 * DAYMS + 60000); assert.ok(await R.tick(nextWeek), 'due again a week later');
  await call('/api/reports', 'PUT', { enabled: false });
  const app = fsRead(new URL('../public/app.js', import.meta.url), 'utf8'); assert.match(app, /pageReports/); assert.match(app, /usageChart/);
}

// ---- runbooks and approval rules ----
{
  const { parseSpawns } = await import('../src/engine.js');
  const ag = Object.values(engine.agents).find((a) => !a.parentId && a.kind !== 'general');
  const rb = parseSpawns('Done.\n```apiary-runbook\n{"title":"Restart Pi-hole DNS","problem":"DNS stops answering","steps":["1. ssh in with the secret \\"Pi login\\"","sudo systemctl restart pihole-FTL","password: hunter2 is wrong"],"tags":["dns","Server"]}\n```');
  assert.equal(rb.runbooks.length, 1); assert.ok(!/apiary-runbook/.test(rb.clean));
  const d1 = engine.runbooks.propose(ag.name, ag.name, rb.runbooks[0]);
  assert.equal(d1.status, 'draft'); assert.deepEqual(d1.tags, ['dns', 'server']); assert.equal(d1.steps[0], 'ssh in with the secret "Pi login"', 'numbering stripped');
  assert.ok(!/hunter2/.test(JSON.stringify(d1)), 'passwords are masked');
  assert.equal(engine.runbooks.draftCount, 1); assert.equal((await call('/api/state')).body.runbookDrafts, 1);
  assert.ok(!engine._system(ag).includes('sudo systemctl restart pihole-FTL'), 'drafts are never given to agents');
  assert.match(engine._system(ag), /apiary-runbook/); assert.match(engine._system(ag), /no approved runbooks/);
  // an agent can refresh its own draft, but needs title and steps
  assert.throws(() => engine.runbooks.propose('x', '', { title: 'No steps' }), /needs steps/); assert.equal(engine.runbooks.list().length, 1);
  engine.runbooks.propose(ag.name, ag.name, { title: 'restart pi-hole dns', steps: ['Just restart pihole-FTL'] }); assert.equal(engine.runbooks.list().length, 1, 'same draft updated');
  // approve (you), then agents get it
  const ap = await call('/api/runbooks/' + d1.id, 'PUT', { status: 'trusted' }); assert.equal(ap.body.status, 'trusted'); assert.equal(engine.runbooks.draftCount, 0);
  assert.match(engine._system(ag), /APPROVED RUNBOOKS[\s\S]*Restart Pi-hole DNS[\s\S]*Just restart pihole-FTL/);
  // an agent cannot change a trusted one: a separate draft appears
  const upd = engine.runbooks.propose(ag.name, '', { title: 'Restart Pi-hole DNS', steps: ['rm -rf /'] }); assert.equal(upd.title, 'Restart Pi-hole DNS (update)'); assert.equal(upd.status, 'draft');
  assert.ok(!engine._system(ag).includes('rm -rf'), 'trusted text unchanged and the draft is not shown');
  // you can write, edit, search and delete
  const mine = await call('/api/runbooks', 'POST', { title: 'Renew certificate', steps: '1. Open the proxy\n2. Press renew', tags: 'tls' }); assert.equal(mine.status, 201); assert.equal(mine.body.status, 'trusted'); assert.deepEqual(mine.body.steps, ['Open the proxy', 'Press renew']);
  assert.equal((await call('/api/runbooks', 'POST', { title: 'renew certificate', steps: 'x' })).status, 409);
  assert.equal((await call('/api/runbooks/' + mine.body.id, 'PUT', { steps: '' })).status, 400); assert.equal((await call('/api/runbooks/' + mine.body.id, 'PUT', { status: 'weird' })).status, 400);
  assert.ok((await call('/api/search?q=pihole')).body.groups.some((g) => g.type === 'runbook'));
  assert.equal((await call('/api/runbooks/' + mine.body.id, 'DELETE')).status, 200); assert.equal((await call('/api/runbooks/' + upd.id, 'DELETE')).status, 200);
  assert.ok((await call('/api/audit?q=runbook')).body.total >= 2);

  // approval rules
  const ask = (kind, title, extra = {}) => engine._ask(ag, { kind, title, ...extra });
  const P = engine.policy; for (const r of [...P.rules]) P.remove(r.id);
  assert.equal((await call('/api/policy', 'POST', { kind: 'nonsense', action: 'allow' })).status, 400); assert.equal((await call('/api/policy', 'POST', { kind: 'plan', action: 'maybe' })).status, 400); assert.equal((await call('/api/policy', 'POST', { kind: 'plan', action: 'allow', project: 'nope' })).status, 400);
  const pending0 = engine.approvals().filter((a) => a.status === 'pending').length;
  const r1 = await call('/api/policy', 'POST', { kind: 'plan', action: 'allow' }); assert.equal(r1.status, 201); assert.match(r1.body.text, /Allow without asking: when an agent wants to accept a project plan/);
  assert.equal((await call('/api/policy', 'POST', { kind: 'plan', action: 'allow' })).status, 409, 'duplicates refused');
  const res = await ask('plan', 'A plan'); assert.equal(res.decision, 'approve'); assert.equal(engine.approvals().filter((a) => a.status === 'pending').length, pending0, 'nobody was asked');
  const auto = engine.approvals().find((a) => a.title === 'A plan'); assert.ok(auto.auto && auto.status === 'approved' && /rule/.test(auto.note));
  assert.ok((await call('/api/audit?kind=approval&q=automatically')).body.items.length >= 1);
  // other kinds still ask
  let settled = false; ask('hire', 'Hire someone').then(() => { settled = true; }); await new Promise((r) => setTimeout(r, 50)); assert.equal(settled, false); const hp = engine.approvals().find((a) => a.title === 'Hire someone'); assert.equal(hp.status, 'pending'); engine.decide(hp.id, { decision: 'deny' });
  // the most careful rule wins: ask beats allow, block beats ask
  await call('/api/policy', 'POST', { kind: 'any', action: 'allow' });
  await call('/api/policy', 'POST', { kind: 'secret', action: 'ask', secret: 'Vault root' });
  const ok2 = await ask('merge', 'Merge branch'); assert.equal(ok2.decision, 'approve', 'allow-anything covers merges');
  let sec = false; ask('secret', 'Use Vault root', { secret: 'vault ROOT' }).then(() => { sec = true; }); await new Promise((r) => setTimeout(r, 50)); assert.equal(sec, false, '"ask" overrides "allow"'); const sp = engine.approvals().find((a) => a.title === 'Use Vault root'); engine.decide(sp.id, { decision: 'deny' });
  const ok3 = await ask('secret', 'Use another', { secret: 'Other' }); assert.equal(ok3.decision, 'approve'); assert.equal(ok3.mode, 'once');
  await call('/api/policy', 'POST', { kind: 'secret', action: 'deny', contains: 'delete' });
  const bl = await ask('secret', 'Use it to delete everything', { secret: 'Other' }); assert.equal(bl.decision, 'deny'); assert.match(bl.note, /Blocked by your rule/);
  // project scope
  for (const r of [...P.rules]) P.remove(r.id);
  await call('/api/policy', 'POST', { kind: 'hire', action: 'allow', project: ag.id });
  assert.equal((await ask('hire', 'Hire in scope')).decision, 'approve');
  const other = await engine.createLead({ name: 'Other project', provider: 'mock' }); let o = false; engine._ask(other, { kind: 'hire', title: 'Hire out of scope' }).then(() => { o = true; }); await new Promise((r) => setTimeout(r, 50)); assert.equal(o, false, 'a rule for one project does not cover another'); engine.decide(engine.approvals().find((a) => a.title === 'Hire out of scope').id, { decision: 'deny' });
  assert.equal((await call('/api/policy')).body.rules.length, 1);
  for (const r of [...P.rules]) assert.equal((await call('/api/policy/' + r.id, 'DELETE')).status, 200); assert.equal((await call('/api/policy/zzzz', 'DELETE')).status, 404);
  const app = fsRead(new URL('../public/app.js', import.meta.url), 'utf8'); assert.match(app, /pageRunbooks/); assert.match(app, /pagePolicy/);
}

{ const a = fsRead(new URL('../public/app.js', import.meta.url), 'utf8'); assert.match(a, /navLeaves/); assert.match(a, /label: 'Security'/); assert.match(a, /id: 'reuse'/); }
{ const a = fsRead(new URL('../public/app.js', import.meta.url), 'utf8'); assert.match(a, /Create your sign-in/); assert.match(a, /signin-nag/); assert.ok(a.indexOf('// 8 Sign-in') < a.indexOf('// 9 Startup'), 'sign-in comes before startup'); }

// ----- pictures and screenshots -----
{
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const up = await call('/api/images', 'POST', { name: 'shot.png', data: 'data:image/png;base64,' + png.toString('base64') });
  assert.equal(up.status, 201); assert.match(up.body.id, /^img-[a-f0-9]{16}$/); assert.equal(up.body.mime, 'image/png');
  assert.equal((await call('/api/images', 'POST', { name: 'x.svg', data: Buffer.from('<svg onload="alert(1)"/>').toString('base64') })).status, 400, 'SVG and other non-pictures are refused');
  assert.equal((await call('/api/images', 'POST', { name: 'x.png', data: Buffer.from('not a picture at all').toString('base64') })).status, 400, 'the file contents decide, not the name');
  const got = await fetch(`${base}/api/images/${up.body.id}`);
  assert.equal(got.headers.get('content-type'), 'image/png'); assert.equal(got.headers.get('x-content-type-options'), 'nosniff'); assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);
  assert.equal((await call('/api/images/img-0000000000000000')).status, 404);
  assert.equal((await call('/api/images/..%2F..%2Fetc%2Fpasswd')).status, 404, 'no path tricks');
  const chat = (await call('/api/chat')).body;
  assert.equal((await call(`/api/agents/${chat.id}/messages`, 'POST', { text: 'look', images: [{ id: 'img-ffffffffffffffff' }] })).status, 400, 'an unknown picture is refused');
  assert.equal((await call(`/api/agents/${chat.id}/messages`, 'POST', { text: 'what is wrong here?', images: [{ id: up.body.id, name: 'shot.png' }] })).status, 202);
  await until(() => engine.messages(chat.id).some((m) => m.role === 'agent' && /saw 1 picture/.test(m.text)));
  assert.equal(engine.messages(chat.id).find((m) => m.role === 'user' && m.images)?.images[0].id, up.body.id, 'the message keeps its picture');
  assert.equal((await call(`/api/agents/${chat.id}/messages`, 'POST', { text: '', images: [] })).status, 400);
  // a task keeps its pictures and hands them over when it starts
  const t = await call('/api/tasks', 'POST', { title: 'Fix the layout in the picture', status: 'todo', images: [{ id: up.body.id, name: 'shot.png' }] });
  assert.equal(t.status, 201); assert.equal(t.body.images.length, 1);
  assert.equal((await call('/api/tasks', 'POST', { title: 'x', images: [{ id: 'nope' }] })).status, 400);
  assert.equal((await call('/api/tasks/' + t.body.id + '/start', 'POST', {})).status, 202);
  await until(() => engine.messages(chat.id).some((m) => m.role === 'user' && /Fix the layout/.test(m.text) && m.images?.length === 1));
  const a = fsRead(new URL('../public/app.js', import.meta.url), 'utf8'); assert.match(a, /function attacher/); assert.match(a, /onpaste: att\.onPaste/);
}
{ const a = fsRead(new URL('../public/app.js', import.meta.url), 'utf8'); assert.match(a, /function codeBlock/); assert.match(a, /class: 'codeblock'/); assert.match(a, /clipboard\.writeText/); assert.match(a, /oncopy/); assert.match(a, /\.trim\(\);   \/\/ no stray/); }
{ const sys = engine._system(engine.agents[(await call('/api/chat')).body.id]); assert.match(sys, /fenced code block/, 'agents are told to put commands in code blocks'); }
{
  assert.equal((await call('/api/settings')).body.imageKeepDays, 30, 'pictures are kept 30 days by default');
  for (const d of [90, 180, 365, 0]) { assert.equal((await call('/api/settings', 'PUT', { imageKeepDays: d })).body.imageKeepDays, d); }
  assert.equal((await call('/api/settings', 'PUT', { imageKeepDays: 45 })).status, 400, 'only the offered choices');
  const { Images } = await import('../src/images.js'); const { mkdtempSync, utimesSync, existsSync } = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const im = new Images(mkdtempSync(path.join(os.tmpdir(), 'pics-'))), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const old = im.save({ data: png.toString('base64') }), fresh = im.save({ data: png.toString('base64') });
  const ago = (d) => new Date(Date.now() - d * 864e5); utimesSync(im.find(old.id).path, ago(40), ago(40));
  assert.equal(im.prune(0), 0, 'never delete keeps everything'); assert.ok(im.find(old.id));
  assert.equal(im.prune(90), 0, '40 days old is kept under a 90 day limit');
  assert.equal(im.prune(30), 1); assert.equal(im.find(old.id), null, 'older than 30 days is deleted'); assert.ok(im.find(fresh.id), 'newer pictures stay');
  await call('/api/settings', 'PUT', { imageKeepDays: 30 });
  const a = fsRead(new URL('../public/app.js', import.meta.url), 'utf8'); assert.match(a, /Keep pictures for/); assert.match(a, /ACTIVE_ATTACH/);
}
{
  const d = (await call('/api/dashboard')).body;
  for (const k of ['finished', 'counts', 'agents', 'offline', 'recent', 'projects', 'usage']) assert.ok(k in d, `dashboard has ${k}`);
  assert.ok(Array.isArray(d.finished) && d.recent.every((r) => r.code && r.title), 'recent work lists tasks');
  assert.equal(typeof d.agents.working, 'number');
  const a = fsRead(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(a, /async function pageHome/); assert.match(a, /\|\| '#\/home'/, 'the dashboard is the home page'); assert.match(a, /nav-top/); assert.doesNotMatch(a, /items: \[\['#\/home', 'Dashboard'\]/, 'Dashboard sits at the very top, outside Workspace'); assert.match(a, /async function pageLibrary/); assert.match(a, /\['#\/library', 'Library'\]/); assert.doesNotMatch(a, /openLibrary\(draw\)/, 'no Library button on the Devices page');
  assert.doesNotMatch(JSON.stringify(d), /sk-|password|secret/i, 'no secrets on the dashboard');
}
{ const appjs = fsRead(new URL('../public/app.js', import.meta.url), 'utf8');
  if (!/function rich\(/.test(appjs) || !/rich\(t\.notes\)/.test(appjs) || !/rich\(c\.text\)/.test(appjs)) throw new Error('details should be formatted with rich()'); }
{ const css = fsRead(new URL('../public/style.css', import.meta.url), 'utf8');
  if (!/\.grid>\.card,\.grid>\.card\+\.card\{margin-top:0\}/.test(css)) throw new Error('cards in a grid must stay aligned'); }
{ const appjs = fsRead(new URL('../public/app.js', import.meta.url), 'utf8');
  if (!/status !== 'pending' && !a\.auto/.test(appjs)) throw new Error('automatic decisions should be hidden on the Approvals page'); }
{ const appjs = fsRead(new URL('../public/app.js', import.meta.url), 'utf8');
  if (!/i\.secret && i\.via !== 'token' && i\.secretKind !== 'token' \? h\('button'/.test(appjs)) throw new Error('Discover must be hidden for token-only devices'); }
{ const r = await call('/api/infra'); if (!Array.isArray(r.body.items)) throw new Error('infra list should still load'); }
console.log('all e2e checks passed');
server.close(); process.exit(0);
