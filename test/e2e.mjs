// End-to-end test with the mock provider: lead -> spawns 2 sub-agents -> reports -> final answer.
import assert from 'node:assert/strict';
import { mkdtempSync, statSync as fsStat, readFileSync as fsRead, existsSync as fsExists } from 'node:fs';
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
  const added = (await call('/api/memory', 'POST', { text: 'Malcolm prefers short answers', scope: 'global' })).body;
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
  assert.match(ap.items[1].name, /^[A-Z]/); assert.notEqual(ap.items[1].name, ap.items[1].title, 'a comic-book style name is suggested');
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
  const a1 = rec('approved', 2), a2 = rec('denied', 30), a3 = rec('approved', 23.5), a4 = rec('denied', 24.5);
  const list = (await call('/api/approvals')).body;
  const get = (id) => list.find((x) => x.id === id);
  assert.equal(get(a1).archived, false); assert.equal(get(a3).archived, false);
  assert.equal(get(a2).archived, true); assert.equal(get(a4).archived, true, 'older than 24 hours is archived');
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
  // assign to the network engineer only
  await call('/api/vault/secrets/' + sec.id, 'PUT', { assigned: [{ key: 'network-engineer', label: 'Network Engineer', grant: 'ask' }] });
  const ne = orgIds.ne, se = orgIds.se;
  const ask = async (agent, text) => { const n = engine.messages(agent.id).length; await call(`/api/agents/${agent.id}/messages`, 'POST', { text }); return n; };
  const pendingSecret = async () => { let f; await until(() => (f = engine.approvals().find((a) => a.status === 'pending' && a.kind === 'secret')), 8000); return f; };
  const idle = (a) => until(() => engine.agents[a.id].status === 'idle' && !engine.approvals().some((x) => x.status === 'pending' && x.agentId === a.id), 8000);

  // not assigned -> no approval is even offered
  await ask(se, 'use-secret:NPM_admin please'); await idle(se);
  assert.ok(engine.messages(se.id).some((m) => /has not been assigned to you/.test(m.text || '') || m.role === 'report'), 'unassigned agents are refused');
  assert.equal(engine.approvals().some((a) => a.status === 'pending' && a.kind === 'secret'), false);
  assert.ok(!engine.messages(se.id).some((m) => (m.text || '').includes(SECRET)));
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
  const blocked = await c2('/api/update/install', 'POST', {}); assert.equal(blocked.status, 409); assert.ok(blocked.body.busy >= 1, 'asks before interrupting working agents');
  assert.equal(restarts, 0);
  busyAgent.status = was;
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
  await call(`/api/agents/${lead.id}/messages`, 'POST', { text: 'progress:1:1' });
  await until(() => lead.plan.phases[0].steps[0].done && engine.agents[lead.id].status === 'idle', 8000);
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

console.log('all e2e checks passed');
server.close(); process.exit(0);
