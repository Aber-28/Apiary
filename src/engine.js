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
  maxPeerMessages: Number(process.env.APIARY_MAX_PEER_MESSAGES || 30), // agent-to-agent messages per project
};
const LIMIT_RANGE = { maxDepth: [0, 4], maxAgents: [1, 40], maxRounds: [0, 10], maxPeerMessages: [0, 200] };
const SPAWN_RE = /```apiary-spawn\s*([\s\S]*?)```/g;
const SEND_RE = /```apiary-send\s*([\s\S]*?)```/g;
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
    this.pending = new Map();  // approvalId -> { resolve, reject }
    this.waitingOn = new Map();// agentId -> Set of agentIds it is waiting for (deadlock check)
    this.peerCounts = new Map();// project id -> agent-to-agent messages sent
    for (const a of Object.values(store.data.agents)) if (a.status !== 'idle') a.status = 'idle'; // interrupted by a restart
    for (const r of Object.values(store.data.approvals)) if (r.status === 'pending') r.status = 'expired'; // nobody is waiting any more
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

  get approvalsDefault() { return this.store.data.settings.approvalsDefault !== false; }
  setApprovalsDefault(v) { this.store.data.settings.approvalsDefault = !!v; this.store.save(); return this.approvalsDefault; }

  // ---------- approvals ----------
  approvals() { return Object.values(this.store.data.approvals).sort((a, b) => b.createdAt - a.createdAt); }
  _needsApproval(agent) { return this.rootOf(agent).approvals !== false; }
  _ask(agent, fields) {
    const id = id8();
    const rec = { id, agentId: agent.id, agentName: agent.name, projectId: this.rootOf(agent).id, status: 'pending', createdAt: Date.now(), ...fields };
    this.store.data.approvals[id] = rec;
    const decided = Object.values(this.store.data.approvals).filter((r) => r.status !== 'pending').sort((a, b) => b.createdAt - a.createdAt);
    for (const r of decided.slice(100)) delete this.store.data.approvals[r.id];
    this.emit('event', { type: 'approval', approval: rec });
    this._log(agent, `? waiting for your approval: ${rec.title}`);
    this.store.save();
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  decide(id, { decision, note, only } = {}) {
    const rec = this.store.data.approvals[id];
    if (!rec) throw httpErr(404, 'No such approval');
    if (rec.status !== 'pending' || !this.pending.has(id)) throw httpErr(409, 'This request was already answered or has expired');
    if (!['approve', 'deny'].includes(decision)) throw httpErr(400, 'decision must be approve or deny');
    if (only !== undefined && (!Array.isArray(only) || only.some((i) => !Number.isInteger(i) || i < 0 || i >= (rec.items?.length || 0)))) throw httpErr(400, 'Bad selection');
    rec.status = decision === 'approve' ? 'approved' : 'denied';
    rec.note = String(note || '').slice(0, 1000);
    if (decision === 'approve' && only) rec.only = only;
    rec.decidedAt = Date.now();
    const p = this.pending.get(id); this.pending.delete(id);
    this.emit('event', { type: 'approval', approval: rec });
    this.store.save();
    p.resolve({ decision, note: rec.note, only: rec.only });
    return rec;
  }

  get defaultProvider() { const p = this.store.data.settings.defaultProvider; return this.available.some((x) => x.id === p) ? p : ''; }
  get onboardingDone() { return !!this.store.data.settings.onboardingDone; }
  setSettings({ defaultProvider, onboardingDone }) {
    const st = this.store.data.settings;
    if (defaultProvider !== undefined) { if (defaultProvider && !['claude', 'codex'].includes(defaultProvider)) throw httpErr(400, 'Unknown provider'); st.defaultProvider = defaultProvider; }
    if (onboardingDone !== undefined) st.onboardingDone = !!onboardingDone;
    this.store.save();
  }
  defaultModel(provider) { return provider === 'mock' ? '' : this.connections.get(provider).model || ''; }

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
  async createLead({ name, provider, model, cwd, access, goal, source, base, approvals }) {
    if (!this.available.some((p) => p.id === provider)) throw httpErr(400, `Provider "${provider}" is not available. Connect it first.`);
    const method = this.resolveMethod(provider);
    const id = id8();
    const title = (name || goal || 'New project').trim().split('\n')[0].slice(0, 48);
    const pslug = slug(title);
    const fields = { id, name: title, role: 'Lead agent', provider, method, model: model || this.defaultModel(provider), access: access === 'full' ? 'full' : 'safe', parentId: null, depth: 0, approvals: approvals === undefined ? this.approvalsDefault : !!approvals };

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
    const ids = new Set(this.tree(agentId));
    for (const id of ids) {
      this.stopped.add(id);
      this.ctls.get(id)?.abort();
    }
    for (const r of Object.values(this.store.data.approvals)) {
      const p = this.pending.get(r.id);
      if (r.status === 'pending' && p && ids.has(r.agentId)) {
        r.status = 'cancelled'; this.pending.delete(r.id);
        this.emit('event', { type: 'approval', approval: r });
        p.reject(Object.assign(new Error('stopped'), { name: 'AbortError' }));
      }
    }
  }

  // Review screen data: what this agent's branch adds on top of its parent's (or the base branch).
  async diff(agentId) {
    const a = this.agents[agentId];
    if (!a) throw httpErr(404, 'No such agent');
    const g = a.git;
    if (!g) throw httpErr(409, 'This agent is not working in a git repository');
    const parent = a.parentId ? this.agents[a.parentId] : null;
    const from = parent?.git ? parent.git.branch : await git.startRef(g.repo, g.base);
    return { from, to: g.branch, ...(await git.diff(g.repo, from, g.branch)) };
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
    s += 'If a message is marked "Message from teammate", your reply goes back to that teammate.\n';
    const mates = this.tree(this.rootOf(agent).id).map((i) => this.agents[i]).filter((a) => a && a.id !== agent.id);
    if (mates.length && this.limits.maxPeerMessages > 0) {
      s += '\nYou can talk to or hand work to any teammate by name. Put a block like this in your reply:\n\n' +
        '```apiary-send\n{"to":"Teammate name","text":"Your question or the task, written so it stands alone","wait":true}\n```\n\n' +
        '"to" can also be "parent" or "lead". With "wait":true (default) you get the teammate\'s reply as your next message; with "wait":false the message is delivered and you carry on. ' +
        'You cannot wait on someone who is waiting on you. Keep it purposeful: do not chat for the sake of it.\nTeammates:\n' +
        mates.map((a) => `- ${a.name}${a.role ? ': ' + a.role : ''}`).join('\n') + '\n';
    }
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
    // A message from a teammate (not the parent handing over a task) is labelled so the agent knows who is asking.
    let prompt = from && from.id !== agent.parentId ? `Message from teammate ${from.name}:\n\n${userText}` : userText, final = '';
    try {
      for (let round = 0; round <= this.limits.maxRounds; round++) {
        const reply = await this._exec(agent, prompt);
        const { clean, spawns, sends, errors } = parseSpawns(reply);
        final = clean || final;
        if (clean) this._msg(agent, { role: 'agent', text: clean });
        if ((!spawns.length && !sends.length && !errors.length) || round === this.limits.maxRounds) break;

        const notes = [...errors];
        let runnable = [];
        for (const s of spawns) {
          const label = s.agent || s.name;
          if (s.agent && !this._findDef(s.agent)) { notes.push(`No saved agent called "${s.agent}".`); continue; }
          if (!this._canSpawn(agent)) { notes.push(`Could not create "${label}": team size or depth limit reached. Do it yourself.`); continue; }
          runnable.push(s);
        }
        // Human approval before new agents appear.
        if (runnable.length && this._needsApproval(agent)) {
          this._setStatus(agent, 'waiting');
          this.emit('event', { type: 'activity', agentId: agent.id, text: 'Waiting for your approval' });
          const r = await this._ask(agent, {
            kind: 'spawn', title: `${agent.name} wants to create ${runnable.length} sub-agent${runnable.length > 1 ? 's' : ''}`,
            items: runnable.map((s) => { const def = s.agent ? this._findDef(s.agent) : null; const p = [s.provider, def?.provider].find((x) => this.available.some((v) => v.id === x)) || agent.provider; return { name: def?.name || s.name, role: def?.role || s.role, provider: p, task: s.task }; }),
          });
          if (r.decision === 'deny') { notes.push(`The human declined to create these sub-agents${r.note ? ': ' + r.note : ''}. Continue without them.`); runnable = []; }
          else {
            if (r.only) { const skipped = runnable.length - r.only.length; runnable = runnable.filter((_, i) => r.only.includes(i)); if (skipped) notes.push(`The human approved only some sub-agents; ${skipped} were not created.`); }
            if (r.note) notes.push(`Human note: ${r.note}`);
          }
        }
        if (agent.git) await this._commit(agent, 'work before delegating');
        this._setStatus(agent, 'waiting');

        // Messages to teammates run alongside the sub-agents.
        const jobs = runnable.map((s) => this._runChild(agent, s).then((r) => ({ kind: 'report', ...r })));
        for (const m of sends) {
          const job = await this._peerJob(agent, m, notes);
          if (job) jobs.push(job);
        }
        const results = await Promise.all(jobs);
        this.waitingOn.delete(agent.id);
        if (this.stopped.has(agent.id)) throw Object.assign(new Error('stopped'), { name: 'AbortError' });

        const reports = results.filter((r) => r.kind === 'report'), replies = results.filter((r) => r.kind === 'reply');
        for (const r of reports) if (r.child?.branch) r.text += await this._mergeChild(agent, r.child);

        let body = '';
        if (reports.length) body += 'Reports from your sub-agents:\n\n' + reports.map((r) => `### ${r.name}\n${r.text}`).join('\n\n');
        if (replies.length) body += (body ? '\n\n' : '') + 'Replies from teammates:\n\n' + replies.map((r) => `### ${r.name}\n${r.text}`).join('\n\n');
        if (!body) body = 'Nothing was run this round.';
        if (notes.length) body += '\n\nNotes from Apiary:\n- ' + notes.join('\n- ');
        body += '\n\nContinue: use these to complete the task and give your final answer.';
        this._msg(agent, { role: 'report', text: body });
        prompt = body;
      }
      await this._commit(agent, userText);
      this._setStatus(agent, 'idle');
      return final;
    } catch (e) {
      this.waitingOn.delete(agent.id);
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

  // ----- agent-to-agent messages -----
  async _findPeer(agent, to) {
    const root = this.rootOf(agent);
    const t = String(to || '').trim().toLowerCase();
    for (let tries = 0; tries < 10; tries++) {   // a just-spawned teammate may not exist yet
      if (t === 'parent' && agent.parentId) return { peer: this.agents[agent.parentId] };
      if (t === 'lead') return { peer: root };
      const hits = this.tree(root.id).map((i) => this.agents[i]).filter((a) => a && a.id !== agent.id && (a.id === to || a.name.toLowerCase() === t));
      if (hits.length === 1) return { peer: hits[0] };
      if (hits.length > 1) return { error: `More than one teammate is called "${to}". Use a more specific name.` };
      await new Promise((r) => setTimeout(r, 100));
    }
    return { error: `No teammate called "${to}" in this project.` };
  }
  // Would `from` waiting on `to` close a circle of agents waiting on each other?
  _wouldDeadlock(from, to) {
    const seen = new Set(), stack = [to];
    while (stack.length) {
      const x = stack.pop();
      if (x === from) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      for (const y of this.waitingOn.get(x) || []) stack.push(y);
    }
    return false;
  }
  async _peerJob(agent, m, notes) {
    const root = this.rootOf(agent).id;
    if ((this.peerCounts.get(root) || 0) >= this.limits.maxPeerMessages) { notes.push(`Message to "${m.to}" not sent: this project reached its limit of ${this.limits.maxPeerMessages} agent-to-agent messages.`); return null; }
    const { peer, error } = await this._findPeer(agent, m.to);
    if (error) { notes.push(error); return null; }
    if (peer.id === agent.id) { notes.push('You cannot message yourself.'); return null; }
    if (m.wait && this._wouldDeadlock(agent.id, peer.id)) {
      notes.push(`Not sent to ${peer.name} with wait: ${peer.name} is already waiting for you, so you would both wait forever. Send it with "wait":false and carry on.`);
      return null;
    }
    this.peerCounts.set(root, (this.peerCounts.get(root) || 0) + 1);
    this._msg(agent, { role: 'system', text: `${m.wait ? 'Asked' : 'Told'} ${peer.name}: ${m.text.slice(0, 160)}${m.text.length > 160 ? '…' : ''}`, agentId: peer.id });
    if (!m.wait) {
      this.send(peer.id, m.text, agent).catch(() => {});
      notes.push(`Message delivered to ${peer.name} (no reply awaited).`);
      return null;
    }
    this._edge(agent.id, peer.id);
    return this.send(peer.id, m.text, agent).then((text) => ({ kind: 'reply', name: peer.name, text: text || '(no reply)' }), (e) => ({ kind: 'reply', name: peer.name, text: `FAILED: ${e.message}` }))
      .finally(() => this.waitingOn.get(agent.id)?.delete(peer.id));
  }
  _edge(a, b) { (this.waitingOn.get(a) || this.waitingOn.set(a, new Set()).get(a)).add(b); }

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
      provider, method, model: def?.model || (provider === parent.provider ? parent.model : this.defaultModel(provider)),
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
    this._edge(parent.id, child.id);
    this._msg(parent, { role: 'system', text: `Created sub-agent ${child.name} (${provider})`, agentId: child.id });
    try {
      const text = await this.send(child.id, spec.task, parent);
      return { name: child.name, text: text || '(no output)', child };
    } catch (e) {
      return { name: child.name, text: `FAILED: ${e.message}`, child };
    } finally { this.waitingOn.get(parent.id)?.delete(child.id); }
  }

  // Bring a child's branch into its parent's. A conflict is aborted and reported, never left half-done.
  async _mergeChild(parent, child) {
    const parentBranch = parent.git.branch;
    let note, merge = true;
    if (this._needsApproval(parent)) {
      let d = { stat: '', patch: '', truncated: false };
      try { d = await git.diff(parent.cwd, parentBranch, child.branch); } catch (e) { d.stat = `(could not read the changes: ${e.message})`; }
      if (d.stat.trim()) {
        this.emit('event', { type: 'activity', agentId: parent.id, text: 'Waiting for your review' });
        const r = await this._ask(parent, { kind: 'merge', title: `Merge ${child.name}'s changes into ${parentBranch}?`, detail: `${child.name} worked on branch ${child.branch}.`, diff: d, childId: child.id });
        if (r.decision === 'deny') {
          merge = false;
          note = `\n\n(The human did NOT approve merging ${child.name}'s changes${r.note ? ': ' + r.note : ''}. The branch ${child.branch} is kept. Revise the plan or ask the human.)`;
        } else if (r.note) note = `\n\n(Human note about ${child.name}'s changes: ${r.note})`;
      }
    }
    if (merge) {
      const res = await git.merge(parent.cwd, child.branch);
      if (res.ok) note = (note || '') + `\n\n(Apiary merged ${child.name}'s changes into your branch.)`;
      else note = (note || '') + `\n\n(Apiary could NOT merge ${child.name}'s branch ${child.branch} into yours${res.conflicts.length ? `: conflicts in ${res.conflicts.join(', ')}` : ''}. Nothing was merged; the branch is kept. Resolve this yourself or ask the human.)`;
      this._log(parent, res.ok ? `✔ merged ${child.branch} into ${parentBranch}` : `! merge conflict with ${child.branch}`);
    } else this._log(parent, `✘ merge of ${child.branch} declined`);
    await this._lock(parent.git.repo, () => git.worktreeRemove(parent.git.repo, child.cwd)).catch(() => {});
    return note;
  }
}

export function parseSpawns(reply) {
  const spawns = [], sends = [], errors = [];
  reply = reply.replace(SEND_RE, (_, body) => {
    try {
      for (const s of [].concat(JSON.parse(body.trim()))) {
        const text = s && (s.text ?? s.message ?? s.task);
        if (!s || !s.to || typeof text !== 'string' || !text.trim()) { errors.push('An apiary-send block needs "to" and "text".'); continue; }
        sends.push({ to: String(s.to), text, wait: s.wait !== false });
      }
    } catch (err) { errors.push(`An apiary-send block was not valid JSON (${err.message}).`); }
    return '';
  });
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
  return { clean, spawns, sends, errors };
}

export function httpErr(status, message) { return Object.assign(new Error(message), { status }); }
