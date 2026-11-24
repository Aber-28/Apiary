// The engine: agents, chat history, the delegate-and-report loop, and git worktrees.
//
// How sub-agents work (provider-agnostic): an agent that wants help writes a fenced
// ```apiary-spawn {json}``` block in its reply. Apiary creates those sub-agents, runs them
// in parallel, and feeds their reports back to the parent as its next message. This
// works identically for Claude and Codex because it needs nothing but text.
//
// In a git project every agent gets its own worktree + branch (apiary/<project>/lead,
// apiary/<project>/<agent-id>). Children branch from their parent, are auto-committed after
// each turn, and the parent merges them when they report back.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { providers, which } from './providers.js';
import { HOME } from './store.js';
import { Connections } from './connections.js';
import { git } from './git.js';
import { github, validateSource } from './github.js';

const ENV_LIMITS = {
  maxDepth: Number(process.env.APIARY_MAX_DEPTH || 2),     // lead = depth 0
  maxAgents: Number(process.env.APIARY_MAX_AGENTS || 12),  // per whole tree
  maxRounds: Number(process.env.APIARY_MAX_ROUNDS || 4),   // delegate/report cycles per turn
};
const LIMIT_RANGE = { maxDepth: [0, 4], maxAgents: [1, 40], maxRounds: [0, 10] };
const SPAWN_RE = /```apiary-spawn\s*([\s\S]*?)```/g;
const MAX_LOG = 1000;
const id8 = () => randomUUID().slice(0, 8);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'agent';
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export class Engine extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.connections = new Connections(store);
    this.ctls = new Map();     // agentId -> AbortController of the running provider call
    this.chains = new Map();   // agentId -> promise chain (one turn at a time per agent)
    this.stopped = new Set();  // agents asked to stop mid-delegation
    this.locks = new Map();    // repo dir -> promise chain (git worktree operations are serialised)
    for (const a of Object.values(store.data.agents)) if (a.status !== 'idle') a.status = 'idle'; // interrupted by a restart
  }

  get agents() { return this.store.data.agents; }
  get defs() { return this.store.data.defs; }
  messages(id) { return (this.store.data.messages[id] ||= []); }
  logs(id) { return (this.store.data.logs[id] ||= []); }
  tree(rootId) {
    const out = [];
    const walk = (id) => { out.push(id); for (const a of Object.values(this.agents)) if (a.parentId === id) walk(a.id); };
    walk(rootId);
    return out;
  }
  rootOf(a) { while (a.parentId) a = this.agents[a.parentId]; return a; }

  // ---------- settings ----------
  get limits() { return { ...ENV_LIMITS, ...(this.store.data.settings.limits || {}) }; }
  setLimits(patch) {
    const cur = { ...(this.store.data.settings.limits || {}) };
    for (const [k, [lo, hi]] of Object.entries(LIMIT_RANGE)) {
      if (patch[k] === undefined) continue;
      const n = Number(patch[k]);
      if (!Number.isInteger(n) || n < lo || n > hi) throw httpErr(400, `${k} must be a whole number from ${lo} to ${hi}`);
      cur[k] = n;
    }
    this.store.data.settings.limits = cur;
    this.store.save();
    return this.limits;
  }

  // ---------- providers ----------
  // Which way each AI is reached right now: its chosen method, falling back to the other if that one is unusable.
  resolveMethod(provider) {
    if (provider === 'mock') return process.env.APIARY_MOCK === '1' ? 'cli' : null;
    const c = this.connections.get(provider);
    const cliOk = !!which(provider), apiOk = !!c.apiKey;
    if (c.method === 'api') return apiOk ? 'api' : cliOk ? 'cli' : null;
    return cliOk ? 'cli' : apiOk ? 'api' : null;
  }
  get available() {
    return ['claude', 'codex', 'mock']
      .map((id) => ({ id, method: this.resolveMethod(id) }))
      .filter((p) => p.method)
      .map((p) => ({ ...p, label: p.id === 'claude' ? 'Claude' : p.id === 'codex' ? 'Codex' : 'Mock (test)' }));
  }

  // ---------- saved agents ----------
  saveDef(fields, id = null) {
    const name = String(fields.name || '').trim().slice(0, 40);
    if (!name) throw httpErr(400, 'Give the agent a name');
    if (fields.provider && !['claude', 'codex', 'mock'].includes(fields.provider)) throw httpErr(400, 'Unknown provider');
    const dup = Object.values(this.defs).find((d) => d.name.toLowerCase() === name.toLowerCase() && d.id !== id);
    if (dup) throw httpErr(409, `You already have an agent called "${name}"`);
    const def = {
      id: id || id8(), name,
      role: String(fields.role || '').slice(0, 200),
      provider: fields.provider || '',
      model: String(fields.model || '').slice(0, 100),
      instructions: String(fields.instructions || '').slice(0, 4000),
    };
    this.defs[def.id] = def;
    this.store.save();
    return def;
  }
  removeDef(id) {
    if (!this.defs[id]) throw httpErr(404, 'No such saved agent');
    delete this.defs[id];
    this.store.save();
  }

  // ---------- public API ----------
  async createLead({ name, provider, model, cwd, access, goal, source, base }) {
    if (!this.available.some((p) => p.id === provider)) throw httpErr(400, `Provider "${provider}" is not available. Connect it first.`);
    const method = this.resolveMethod(provider);
    const id = id8();
    const title = (name || goal || 'New project').trim().split('\n')[0].slice(0, 48);
    const pslug = slug(title);
    const fields = { id, name: title, role: 'Lead agent', provider, method, model: model || '', access: access === 'full' ? 'full' : 'safe', parentId: null, depth: 0 };

    // Where does the work happen?
    let repo = null;
    if (source) {
      const src = validateSource(source);
      if (src.kind === 'path') {
        if (await git.isRepo(src.spec)) repo = await git.toplevel(src.spec);
        else fields.cwd = src.spec;
      } else {
        const dest = path.join(HOME, 'repos', `${slug(src.spec.replace(/^https?:\/\//, ''))}-${id}`);
        mkdirSync(path.dirname(dest), { recursive: true });
        await github.clone(this.connections.get('github'), src.spec, dest);
        repo = dest;
      }
    } else if (cwd && (await git.isRepo(cwd))) repo = await git.toplevel(cwd);
    else if (cwd) fields.cwd = cwd;

    if (repo) {
      if (method === 'api') throw httpErr(400, 'Web (API key) agents cannot edit files. Use the terminal connection for repository projects.');
      const baseBranch = base || (await git.currentBranch(repo));
      const start = await git.startRef(repo, baseBranch);
      if (!(await git.refExists(repo, start))) throw httpErr(400, `Branch "${baseBranch}" was not found in that repository`);
      const branch = `apiary/${pslug}-${id}/lead`;
      const wt = path.join(HOME, 'worktrees', id, 'lead');
      mkdirSync(path.dirname(wt), { recursive: true });
      await this._lock(repo, () => git.worktreeAdd(repo, wt, branch, start)).catch((e) => { throw httpErr(400, e.message); });
      fields.cwd = wt;
      fields.git = { repo, base: baseBranch, branch, slug: `${pslug}-${id}`, source: source || repo, prUrl: null };
    } else if (!fields.cwd) {
      fields.cwd = path.join(HOME, 'workspaces', `${pslug}-${id}`);
    }
    mkdirSync(fields.cwd, { recursive: true });
    const agent = this._add(fields);
    if (goal) this.send(agent.id, goal).catch(() => {});
    return agent;
  }

  send(agentId, text, from = null) {
    const agent = this.agents[agentId];
    if (!agent) throw httpErr(404, 'No such agent');
    const prev = this.chains.get(agentId) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => this._converse(agent, text, from));
    this.chains.set(agentId, run);
    return run;
  }

  stop(agentId) {
    for (const id of this.tree(agentId)) {
      this.stopped.add(id);
      this.ctls.get(id)?.abort();
    }
  }

  // The command that continues this agent's own CLI session in a real terminal.
  resumeCommand(agentId) {
    const a = this.agents[agentId];
    if (!a) throw httpErr(404, 'No such agent');
    if (a.method === 'api') throw httpErr(409, 'Web agents have no terminal session');
    if (a.provider === 'mock') return `cd ${shq(a.cwd)}`;
    if (!a.sessionId) throw httpErr(409, 'This agent has not started a session yet');
    const cmd = a.provider === 'claude' ? `claude --resume ${shq(a.sessionId)}` : `codex resume ${shq(a.sessionId)}`;
    return `cd ${shq(a.cwd)} && ${cmd}`;
  }
  // "Take over": stop the agent so the person can continue in their own terminal without two writers.
  takeover(agentId) {
    const cmd = this.resumeCommand(agentId);
    this.stop(agentId);
    return { command: cmd };
  }

  async openPr(agentId, { title, body } = {}) {
    const a = this.agents[agentId];
    if (!a) throw httpErr(404, 'No such agent');
    if (!a.git || a.parentId) throw httpErr(400, 'Pull requests are opened from the lead agent of a repository project');
    if (a.status !== 'idle') throw httpErr(409, 'Wait for the agent to finish first');
    await git.commitAll(a.cwd, `${a.name}: final changes`);
    const t = String(title || a.name).slice(0, 200);
    const url = await github.openPr(this.connections.get('github'), {
      dir: a.cwd, branch: a.git.branch, base: a.git.base, title: t,
      body: String(body || `Work by Apiary agents on "${a.name}".`).slice(0, 8000),
    });
    a.git.prUrl = url;
    this._msg(a, { role: 'system', text: `Opened pull request: ${url}` });
    this.emit('event', { type: 'agent', agent: a });
    this.store.save();
    return url;
  }

  async remove(agentId) {
    this.stop(agentId);
    const ids = this.tree(agentId);
    for (const id of ids) {
      const a = this.agents[id];
      if (a?.git?.repo && a.cwd) await this._lock(a.git.repo, () => git.worktreeRemove(a.git.repo, a.cwd)).catch(() => {});
      delete this.agents[id];
      delete this.store.data.messages[id];
      delete this.store.data.logs[id];
      this.chains.delete(id);
      this.emit('event', { type: 'removed', id });
    }
    this.store.save();
  }

  // ---------- internals ----------
  _lock(key, fn) {
    const prev = this.locks.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(key, next);
    return next;
  }
  _add(fields) {
    const agent = { status: 'idle', sessionId: null, createdAt: Date.now(), ...fields };
    this.agents[agent.id] = agent;
    this.emit('event', { type: 'agent', agent });
    this.store.save();
    return agent;
  }
  _setStatus(agent, status) {
    agent.status = status;
    this.emit('event', { type: 'agent', agent });
    this.store.save();
  }
  _msg(agent, m) {
    const msg = { id: id8(), ts: Date.now(), ...m };
    this.messages(agent.id).push(msg);
    this.emit('event', { type: 'message', agentId: agent.id, message: msg });
    this.store.save();
    return msg;
  }
  _log(agent, line) {
    const l = this.logs(agent.id);
    l.push(line);
    if (l.length > MAX_LOG) l.splice(0, l.length - MAX_LOG);
    this.emit('event', { type: 'log', agentId: agent.id, line });
    this.store.save();
  }

  _canSpawn(agent) {
    const L = this.limits;
    return agent.depth < L.maxDepth && this.tree(this.rootOf(agent).id).length < L.maxAgents;
  }

  _system(agent) {
    const names = this.available.filter((p) => p.id !== 'mock').map((p) => p.id).join(', ') || agent.provider;
    let s = `You are "${agent.name}" (${agent.role}), one agent in a small team coordinated by Apiary. Work in your current directory unless told otherwise.\n`;
    if (agent.instructions) s += `\nStanding instructions for you:\n${agent.instructions}\n`;
    if (agent.method === 'api') s += 'You are connected through a web API: you cannot read files or run commands. Answer in text only.\n';
    if (agent.git) s += `You are working on git branch ${agent.git.branch} in your own checkout. Your changes are committed for you after each turn; do not switch branches or push.\n`;
    s += agent.parentId
      ? 'Your reply goes back to the agent that gave you this task, not to a human. Be concrete and concise: say what you did, what you found, and where any files are.\n'
      : 'Your replies go to the human you are working for. Be clear and concise.\n';
    if (agent.depth < this.limits.maxDepth) {
      s += `\nYou can delegate to sub-agents. To create one, put a block like this in your reply:\n\n` +
        '```apiary-spawn\n{"name":"Short name","role":"What this agent is good at","task":"Complete, self-contained instructions","provider":"claude"}\n```\n\n' +
        `Rules: "provider" is optional (one of: ${names}; default is yours). Sub-agents cannot see this conversation, so the task must stand alone. ` +
        'Several blocks in one reply run in parallel. When they finish you will receive their reports as your next message; use them to write the final answer. ' +
        'Only delegate when it genuinely helps (parallel work, a second opinion from another model, a self-contained subtask). Do small things yourself.\n';
      const defs = Object.values(this.defs);
      if (defs.length) {
        s += `\nThe human has saved agents you can reuse by name: put {"agent":"<name>","task":"..."} in a block. Saved agents:\n` +
          defs.map((d) => `- ${d.name}${d.role ? ': ' + d.role : ''}`).join('\n') + '\n';
      }
    } else {
      s += '\nYou cannot create sub-agents. Do the task yourself.\n';
    }
    return s;
  }

  async _exec(agent, prompt) {
    const ctl = new AbortController();
    this.ctls.set(agent.id, ctl);
    this._setStatus(agent, 'working');
    this._log(agent, `── ${new Date().toLocaleTimeString()} ${agent.name} (${agent.provider}, ${agent.method === 'api' ? 'web' : 'terminal'}) ──`);
    try {
      const runner = providers.pick(agent);
      const res = await runner.run({
        agent, prompt, system: this._system(agent), signal: ctl.signal,
        history: agent.history || [], conn: agent.method === 'api' ? this.connections.get(agent.provider) : null,
        onText: (text) => this.emit('event', { type: 'delta', agentId: agent.id, text }),
        onActivity: (text) => this.emit('event', { type: 'activity', agentId: agent.id, text }),
        onLog: (line) => this._log(agent, line),
      });
      if (res.sessionId) agent.sessionId = res.sessionId;
      if (agent.method === 'api') {
        agent.history = [...(agent.history || []), { role: 'user', content: prompt }, { role: 'assistant', content: res.text }].slice(-40);
      }
      return res.text;
    } catch (e) {
      if (e.name !== 'AbortError') this._log(agent, `! ${e.message}`);
      throw e;
    } finally {
      this.ctls.delete(agent.id);
      this.emit('event', { type: 'activity', agentId: agent.id, text: '' });
    }
  }

  async _commit(agent, label) {
    if (!agent.git && !agent.branch) return;
    try {
      const made = await git.commitAll(agent.cwd, `${agent.name}: ${String(label).replace(/\s+/g, ' ').slice(0, 60)}`);
      if (made) this._log(agent, `✔ committed changes on ${agent.git?.branch || agent.branch}`);
    } catch (e) { this._log(agent, `! commit failed: ${e.message}`); }
  }

  async _converse(agent, userText, from) {
    this.stopped.delete(agent.id);
    this._msg(agent, { role: 'user', text: userText, from: from ? { id: from.id, name: from.name } : null });
    let prompt = userText, final = '';
    try {
      for (let round = 0; round <= this.limits.maxRounds; round++) {
        const reply = await this._exec(agent, prompt);
        const { clean, spawns, errors } = parseSpawns(reply);
        final = clean || final;
        if (clean) this._msg(agent, { role: 'agent', text: clean });
        if ((!spawns.length && !errors.length) || round === this.limits.maxRounds) break;

        const notes = [...errors];
        const runnable = [];
        for (const s of spawns) {
          const label = s.agent || s.name;
          if (s.agent && !this._findDef(s.agent)) { notes.push(`No saved agent called "${s.agent}".`); continue; }
          if (!this._canSpawn(agent)) { notes.push(`Could not create "${label}": team size or depth limit reached. Do it yourself.`); continue; }
          runnable.push(s);
        }
        if (agent.git) await this._commit(agent, 'work before delegating');
        this._setStatus(agent, 'waiting');
        const reports = await Promise.all(runnable.map((s) => this._runChild(agent, s)));
        if (this.stopped.has(agent.id)) throw Object.assign(new Error('stopped'), { name: 'AbortError' });
        for (const r of reports) if (r.child?.branch) r.text += await this._mergeChild(agent, r.child);

        let body = 'Reports from your sub-agents:\n\n' + reports.map((r) => `### ${r.name}\n${r.text}`).join('\n\n');
        if (notes.length) body += '\n\nNotes from Apiary:\n- ' + notes.join('\n- ');
        body += '\n\nContinue: use these to complete the task and give your final answer.';
        this._msg(agent, { role: 'report', text: body });
        prompt = body;
      }
      await this._commit(agent, userText);
      this._setStatus(agent, 'idle');
      return final;
    } catch (e) {
      if (e.name === 'AbortError') {
        await this._commit(agent, 'stopped');
        this._msg(agent, { role: 'system', text: 'Stopped.' });
        this._setStatus(agent, 'idle');
        return final || '(stopped)';
      }
      this._msg(agent, { role: 'system', text: `Error: ${e.message}`, error: true });
      this._setStatus(agent, 'error');
      throw e;
    }
  }

  _findDef(name) {
    return Object.values(this.defs).find((d) => d.name.toLowerCase() === String(name).toLowerCase());
  }

  async _runChild(parent, spec) {
    const def = spec.agent ? this._findDef(spec.agent) : null;
    const wanted = spec.provider || def?.provider;
    const provider = this.available.some((p) => p.id === wanted) ? wanted : parent.provider;
    const method = this.resolveMethod(provider);
    const fields = {
      id: id8(), name: def?.name || spec.name, role: def?.role || spec.role, instructions: def?.instructions || '',
      provider, method, model: def?.model || (provider === parent.provider ? parent.model : ''),
      cwd: parent.cwd, access: parent.access, parentId: parent.id, depth: parent.depth + 1,
    };
    // Each CLI agent in a git project gets its own checkout, branched from its parent.
    if (parent.git && method === 'cli') {
      const g = parent.git;
      const branch = `apiary/${g.slug}/${fields.id}`;
      const wt = path.join(HOME, 'worktrees', this.rootOf(parent).id, fields.id);
      try {
        await this._lock(g.repo, () => git.worktreeAdd(g.repo, wt, branch, g.branch === parent.git.branch && !parent.parentId ? g.branch : parent.branch || g.branch));
        fields.cwd = wt; fields.branch = branch; fields.git = { repo: g.repo, base: g.base, branch, slug: g.slug };
      } catch (e) { this._log(parent, `! could not create a checkout for ${fields.name}: ${e.message}`); }
    }
    const child = this._add(fields);
    this._msg(parent, { role: 'system', text: `Created sub-agent ${child.name} (${provider})`, agentId: child.id });
    try {
      const text = await this.send(child.id, spec.task, parent);
      return { name: child.name, text: text || '(no output)', child };
    } catch (e) {
      return { name: child.name, text: `FAILED: ${e.message}`, child };
    }
  }

  // Bring a child's branch into its parent's. A conflict is aborted and reported, never left half-done.
  async _mergeChild(parent, child) {
    const parentBranch = parent.git.branch;
    const res = await git.merge(parent.cwd, child.branch);
    let note;
    if (res.ok) note = `\n\n(Apiary merged ${child.name}'s changes into your branch.)`;
    else {
      note = `\n\n(Apiary could NOT merge ${child.name}'s branch ${child.branch} into yours${res.conflicts.length ? `: conflicts in ${res.conflicts.join(', ')}` : ''}. ` +
        'Nothing was merged; the branch is kept. Resolve this yourself or ask the human.)';
    }
    this._log(parent, res.ok ? `✔ merged ${child.branch} into ${parentBranch}` : `! merge conflict with ${child.branch}`);
    await this._lock(parent.git.repo, () => git.worktreeRemove(parent.git.repo, child.cwd)).catch(() => {});
    return note;
  }
}

export function parseSpawns(reply) {
  const spawns = [], errors = [];
  const clean = reply.replace(SPAWN_RE, (_, body) => {
    try {
      const parsed = JSON.parse(body.trim());
      for (const s of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!s || typeof s.task !== 'string' || !s.task.trim()) { errors.push('A apiary-spawn block was missing a "task".'); continue; }
        spawns.push({
          name: String(s.name || s.agent || 'Helper').slice(0, 40),
          role: String(s.role || 'Helper').slice(0, 200),
          task: s.task,
          provider: s.provider,
          agent: s.agent ? String(s.agent) : undefined,
        });
      }
    } catch (e) {
      errors.push(`A apiary-spawn block was not valid JSON (${e.message}).`);
    }
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { clean, spawns, errors };
}

export function httpErr(status, message) { return Object.assign(new Error(message), { status }); }
