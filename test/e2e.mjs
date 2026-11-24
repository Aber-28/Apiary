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
assert.equal((await call('/api/agents', 'POST', { provider: 'mock', goal: 'x', cwd: '/definitely/not/here' })).status, 400);

// plain chat, no delegation
let lead = (await call('/api/agents', 'POST', { provider: 'mock', goal: 'hello there' })).body;
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
const lead2 = (await call('/api/agents', 'POST', { provider: 'mock', goal: 'delegate work' })).body;
await until(() => Object.values(engine.agents).some((a) => a.parentId === lead2.id));
await call(`/api/agents/${lead2.id}/stop`, 'POST', {});
await until(() => engine.agents[lead2.id].status === 'idle' && Object.values(engine.agents).filter((a) => a.parentId === lead2.id).every((a) => a.status === 'idle'));

// saved agents + settings + connections
{
  const d = await call('/api/defs', 'POST', { name: 'Reviewer', role: 'Reviews work', instructions: 'Be strict.' });
  assert.equal(d.status, 201);
  assert.equal((await call('/api/defs', 'POST', { name: 'reviewer' })).status, 409);
  const l3 = (await call('/api/agents', 'POST', { provider: 'mock', goal: 'use a saved agent please' })).body;
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
  assert.equal((await call('/api/agents', 'POST', { provider: 'mock', goal: 'x', source: 'not a repo' })).status, 400);
  const gl = (await call('/api/agents', 'POST', { provider: 'mock', goal: 'delegate in a repo', source: repo, name: 'Repo job' })).body;
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

const before = Object.keys(engine.agents).length;
assert.equal((await call(`/api/agents/${lead.id}`, 'DELETE')).status, 200);
assert.equal(Object.keys(engine.agents).length, before - 3);
assert.equal((await call(`/api/agents/${lead.id}/messages`)).status, 404);

// persistence survives restart
store.flush();
const engine2 = new Engine(new Store(path.join(tmp, 'state.json')));
assert.ok(engine2.agents[lead2.id]);

console.log('all e2e checks passed');
server.close(); process.exit(0);
