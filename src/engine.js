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
import { readFileSync, mkdirSync, realpathSync, existsSync, statSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { providers, which } from './providers.js';
import { HOME } from './store.js';
import { Connections } from './connections.js';
import { git } from './git.js';
import { github, validateSource } from './github.js';
import { Memory, parseRemember } from './memory.js';
import { buildProfile, DEPARTMENTS, pickName, inferDepartment } from './roles.js';
import { Infra } from './infra.js';
import { Audit } from './audit.js';
import { Health } from './health.js';
import { Telegram } from './telegram.js';
import { Templates } from './templates.js';
import { Reports } from './report.js';
import { Runbooks } from './runbooks.js';
import { Policy } from './policy.js';
import { Backups } from './backup.js';
import { Vault, envName, redactPairs, typeOf } from './vault.js';
import * as orgfiles from './orgfiles.js';
import { Usage, estimateTokens, looksLikeLimit } from './usage.js';
import { Tasks, STATUSES as TASK_STATUSES } from './tasks.js';
import { Tickets } from './tickets.js';
import os from 'node:os';
import { Repos } from './repos.js';
import { suggestModel } from './models.js';
import { Limits } from './limits.js';
import { ToolInstaller } from './tools.js';

const ENV_LIMITS = {
  maxDepth: Number(process.env.APIARY_MAX_DEPTH || 2),     // lead = depth 0
  maxAgents: Number(process.env.APIARY_MAX_AGENTS || 12),  // per whole tree
  maxRounds: Number(process.env.APIARY_MAX_ROUNDS || 4),   // delegate/report cycles per turn
  maxPeerMessages: Number(process.env.APIARY_MAX_PEER_MESSAGES || 30), // agent-to-agent messages per project
};
const LIMIT_RANGE = { maxDepth: [0, 4], maxAgents: [1, 40], maxRounds: [0, 10], maxPeerMessages: [0, 200] };
const SPAWN_RE = /```apiary-spawn\s*([\s\S]*?)```/g;
const SEND_RE = /```apiary-send\s*([\s\S]*?)```/g;
const HIRE_RE = /```apiary-hire\s*([\s\S]*?)```/g;
const TYPE_LABEL = { login: 'login', ssh: 'SSH login', token: 'API key or token' };
const SECRET_RE = /```apiary-secret\s*([\s\S]*?)```/g;
const PLAN_RE = /```apiary-plan\s*([\s\S]*?)```/g;
const PROGRESS_RE = /```apiary-progress\s*([\s\S]*?)```/g;
const INFRA_RE = /```apiary-infra\s*([\s\S]*?)```/g;
const RUNBOOK_RE = /```apiary-runbook\s*([\s\S]*?)```/g;
const TASK_RE = /```apiary-task\s*([\s\S]*?)```/g;
const ASSIGN_RE = /```apiary-assign\s*([\s\S]*?)```/g;
const MAX_LOG = 1000;
const id8 = () => randomUUID().slice(0, 8);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'agent';
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export const STAGES = { building: { label: 'Building', hint: 'Being made for the first time' }, maintenance: { label: 'Maintenance', hint: 'Finished. Fixes, security updates and small changes' }, closed: { label: 'Closed', hint: 'Finished for good. Kept, but not worked on' } };
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
    this.memory = new Memory(path.join(path.dirname(store.file), 'memory.json'));
    this.backups = new Backups(this);
    this.infra = new Infra(path.join(path.dirname(store.file), 'infra.json'));
    this._workStart = new Map();
    this.health = new Health(this);
    this.audit = new Audit(path.join(path.dirname(store.file), 'audit.jsonl'), (t) => this._redact(t));
    this.telegram = new Telegram(this);
    this.templates = new Templates(this);
    this.reports = new Reports(this);
    this.runbooks = new Runbooks(this);
    this.policy = new Policy(this);
    this.vault = new Vault(path.join(path.dirname(store.file), 'vault.json'), process.env.APIARY_KEYFILE || path.join(os.homedir(), '.config', 'apiary', 'vault.key'));
    this.usage = new Usage(store);
    this.providerLimits = new Limits();
    this.toolInstaller = new ToolInstaller({ onDone: () => { this.connections._cache.clear(); this.emit('event', { type: 'tools' }); } });
    this.tasks = new Tasks(store);
    this.tickets = new Tickets(store);
    this.repos = new Repos(store, () => this.connections.get('github'), path.join(path.dirname(store.file), 'repos'));
    this.userLeases = new Map(); // agentId -> Map(secret name -> username), same lifetime as leases
    this.projectFor = new Map(); // agentId -> project id, while a specialist is working on a project from another folder
    this.metaLeases = new Map(); // agentId -> { ENV_NAME: value } for the non-secret details of a lease (host, port, how to log in)
    this.leases = new Map();   // agentId -> Map(secret name -> value), only for the turn that was approved
    for (const a of Object.values(store.data.agents)) if (a.status !== 'idle') a.status = 'idle'; // interrupted by a restart
    this.seedTeams();
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
  // Decisions stay in view for a day, then count as archived.
  approvals() {
    const cut = Date.now() - 24 * 3600000;
    return Object.values(this.store.data.approvals).sort((a, b) => b.createdAt - a.createdAt).map((r) => ({ ...r, archived: r.status !== 'pending' && (r.decidedAt || r.createdAt) < cut }));
  }
  _needsApproval(agent) { return this.rootOf(agent).approvals !== false; }
  _ask(agent, fields) {
    const id = id8();
    const rec = { id, agentId: agent.id, agentName: agent.name, projectId: this.rootOf(agent).id, status: 'pending', createdAt: Date.now(), ...fields };
    const rule = this.policy.match({ kind: fields.kind, title: fields.title, secret: fields.secret, project: rec.projectId });
    if (rule) {   // one of your rules decides, so nobody is asked
      const allow = rule.action === 'allow';
      Object.assign(rec, { status: allow ? 'approved' : 'denied', decidedAt: Date.now(), auto: true, rule: rule.id, note: allow ? `Allowed automatically by your rule. ${this.policy.describe(rule)}` : `Blocked by your rule. ${this.policy.describe(rule)}`, ...(allow && fields.kind === 'secret' ? { mode: 'once' } : {}) });
      this.store.data.approvals[id] = rec;
      this.audit.add('approval', { actor: 'Rule', project: this._pname(agent), action: `${rec.status} automatically: ${rec.title}`, detail: this.policy.describe(rule) });
      this.emit('event', { type: 'approval', approval: rec });
      this._log(agent, `${allow ? '✔' : '!'} ${allow ? 'allowed' : 'blocked'} by your rule: ${rec.title}`);
      this.store.save();
      return Promise.resolve({ decision: allow ? 'approve' : 'deny', note: rec.note, only: undefined, names: undefined, mode: rec.mode, models: undefined });
    }
    this.store.data.approvals[id] = rec;
    const decided = Object.values(this.store.data.approvals).filter((r) => r.status !== 'pending').sort((a, b) => b.createdAt - a.createdAt);
    for (const r of decided.slice(500)) delete this.store.data.approvals[r.id];
    this.emit('event', { type: 'approval', approval: rec });
    this.audit.add('approval', { actor: agent.name, project: this._pname(agent), action: `asked: ${rec.title}`, detail: rec.kind || '' });
    this._log(agent, `? waiting for your approval: ${rec.title}`);
    this.store.save();
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  decide(id, { decision, note, only, names, mode, models } = {}) {
    const rec = this.store.data.approvals[id];
    if (!rec) throw httpErr(404, 'No such approval');
    if (rec.status !== 'pending' || !this.pending.has(id)) throw httpErr(409, 'This request was already answered or has expired');
    if (!['approve', 'deny'].includes(decision)) throw httpErr(400, 'decision must be approve or deny');
    if (only !== undefined && (!Array.isArray(only) || only.some((i) => !Number.isInteger(i) || i < 0 || i >= (rec.items?.length || 0)))) throw httpErr(400, 'Bad selection');
    rec.status = decision === 'approve' ? 'approved' : 'denied';
    rec.note = String(note || '').slice(0, 1000);
    if (decision === 'approve' && only) rec.only = only;
    if (decision === 'approve' && rec.kind === 'secret') rec.mode = mode === 'always' ? 'always' : 'once';
    if (decision === 'approve' && rec.kind === 'hire' && names && typeof names === 'object') {
      rec.names = {};
      for (const [i, n] of Object.entries(names)) { const t = String(n || '').trim().slice(0, 40); if (t && rec.items?.[Number(i)]) rec.names[Number(i)] = t; }
    }
    if (decision === 'approve' && rec.kind === 'hire' && models && typeof models === 'object') {
      rec.models = {};
      for (const [i, m] of Object.entries(models)) if (rec.items?.[Number(i)]) rec.models[Number(i)] = String(m || '').trim().slice(0, 80);
    }
    rec.decidedAt = Date.now();
    const p = this.pending.get(id); this.pending.delete(id);
    this.audit.add('approval', { actor: 'You', project: this.agents[rec.agentId] ? this._pname(this.agents[rec.agentId]) : '', action: `${rec.status}: ${rec.title}`, detail: `${rec.agentName || ''}${rec.mode === 'always' ? ' (always)' : ''}`.trim() });
    this.emit('event', { type: 'approval', approval: rec });
    this.store.save();
    p.resolve({ decision, note: rec.note, only: rec.only, names: rec.names, mode: rec.mode, models: rec.models });
    return rec;
  }

  get defaultProvider() { const p = this.store.data.settings.defaultProvider; return this.available.some((x) => x.id === p) ? p : ''; }
  get onboardingDone() { return !!this.store.data.settings.onboardingDone; }
  get orgDone() { return !!this.store.data.settings.orgDone; }
  // How often Apiary looks for a new version: daily, weekly, monthly, or never by itself (manual).
  get updateCheck() { const v = this.store.data.settings.updateCheck; return ['daily', 'weekly', 'monthly', 'manual'].includes(v) ? v : (this.store.data.settings.autoUpdate === false ? 'manual' : 'daily'); }
  get autoUpdate() { return this.updateCheck !== 'manual'; }
  updateDue(now = Date.now()) {
    const every = { daily: 86400000, weekly: 7 * 86400000, monthly: 30 * 86400000 }[this.updateCheck];
    return !!every && now - (this.store.data.settings.lastUpdateCheck || 0) >= every - 60000;
  }
  markUpdateChecked() { this.store.data.settings.lastUpdateCheck = Date.now(); this.store.save(); }
  get meeting() { return { frequency: 'off', time: '00:00', weekday: 0, last: 0, ...(this.store.data.settings.meeting || {}) }; }
  setMeeting(p = {}) {
    const m = { ...this.meeting };
    if (p.frequency !== undefined) { if (!['off', 'daily', 'weekly'].includes(p.frequency)) throw httpErr(400, 'frequency must be off, daily or weekly'); m.frequency = p.frequency; }
    if (p.time !== undefined) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time)) throw httpErr(400, 'time must look like 00:00'); m.time = p.time; }
    if (p.weekday !== undefined) { const d = Number(p.weekday); if (!Number.isInteger(d) || d < 0 || d > 6) throw httpErr(400, 'weekday must be 0 (Sunday) to 6'); m.weekday = d; }
    if (p.frequency !== undefined && p.frequency !== 'off' && !m.last) m.last = Date.now();   // first meeting at the next scheduled time, not immediately
    this.store.data.settings.meeting = m; this.store.save();
    return this.meeting;
  }
  get plainEnglish() { return this.store.data.settings.plainEnglish !== false; }
  setSettings({ defaultProvider, onboardingDone, autoUpdate, updateCheck, meeting, plainEnglish, usageLimits }) {
    if (autoUpdate !== undefined) { this.store.data.settings.autoUpdate = !!autoUpdate; if (updateCheck === undefined) this.store.data.settings.updateCheck = autoUpdate ? 'daily' : 'manual'; }
    if (updateCheck !== undefined) { if (!['daily', 'weekly', 'monthly', 'manual'].includes(updateCheck)) throw httpErr(400, 'updateCheck must be daily, weekly, monthly or manual'); this.store.data.settings.updateCheck = updateCheck; this.store.data.settings.autoUpdate = updateCheck !== 'manual'; }
    if (plainEnglish !== undefined) this.store.data.settings.plainEnglish = !!plainEnglish;
    if (usageLimits) this.usage.setLimits(usageLimits);
    if (meeting) this.setMeeting(meeting);
    const st = this.store.data.settings;
    if (defaultProvider !== undefined) { if (defaultProvider && !['claude', 'codex'].includes(defaultProvider)) throw httpErr(400, 'Unknown provider'); st.defaultProvider = defaultProvider; }
    if (onboardingDone !== undefined) st.onboardingDone = !!onboardingDone;
    this.store.save();
  }
  get memoryEnabled() { return this.store.data.settings.memory !== false; }
  setMemoryEnabled(v) { this.store.data.settings.memory = !!v; this.store.save(); return this.memoryEnabled; }
  // A project has no agent of its own. Whoever is responsible for it (the CEO unless you chose another agent) does the work,
  // using their own name, instructions, secrets, memory and team. The project keeps its folder, plan and chat history.
  _isProject(a) { return !a.parentId && !a.kind && !a.member; }
  _persona(a) { if (!this._isProject(a)) return a; const o = this.ownerOf(a); return o && o.id !== a.id ? o : a; }
  // Whose team is it: for a project led by the CEO, the CEO's team of specialists.
  _teamRoot(a) { const r = this.rootOf(a); if (!this._isProject(r)) return r; const p = this._persona(r); return p.kind === 'general' ? p : r; }
  _mkey(a) { const p = this._persona(a); return p.memKey || slug(p.name); }
  _pname(a) { const r = this.rootOf(a); return r.kind === 'general' ? '' : r.name; }
  _pkey(a) { const r = this.rootOf(a); return r.git?.repo || r.cwd || r.id; }
  // Remember one finished task for this agent, its project, and (through the project) its teammates.
  _record(agent, userText, from, final) {
    if (!this.memoryEnabled || !final || !String(final).trim() || from?.id === 'meeting') return;
    const asked = from ? `${from.name} asked` : 'Task';
    this.memory.add({ kind: 'episode', agent: this._mkey(agent), project: this._pkey(agent), who: agent.name, text: this._redact(`${asked}: ${userText.replace(/\s+/g, ' ').slice(0, 500)} → ${String(final).replace(/\s+/g, ' ').slice(0, 800)}`) });
  }
  memoryPreview(agentId, q = '') {
    const a = this.agents[agentId];
    if (!a) throw httpErr(404, 'No such agent');
    return this.memory.context(this._mkey(a), this._pkey(a), q, { budget: 6000 });
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

  // ---------- the general chat (not part of any project) ----------
  async general() {
    let a = Object.values(this.agents).find((x) => x.kind === 'general');
    if (a) return a;
    const provider = this.defaultProvider || this.available.find((p) => p.id !== 'mock')?.id || this.available[0]?.id;
    if (!provider) throw httpErr(400, 'Connect an AI first (Connections).');
    const cwd = path.join(HOME, 'workspaces', 'general');
    mkdirSync(cwd, { recursive: true });
    a = this._add({ id: id8(), name: 'Assistant', role: 'General assistant', provider, method: this.resolveMethod(provider), model: this.defaultModel(provider), cwd, access: 'safe', parentId: null, depth: 0, approvals: true, kind: 'general', memKey: 'assistant' });
    return a;
  }

  // ---------- organisation chart ----------
  org(rootId) {
    const root = this.agents[rootId];
    if (!root) throw httpErr(404, 'No such project');
    const node = (a) => ({ id: a.id, name: a.name, title: a.title || '', role: a.role, department: a.department || null, departmentLabel: a.department ? DEPARTMENTS[a.department]?.label : null, status: a.status, hired: !!a.hiredAt, reason: a.profile?.reason || '', reports: [] });
    const members = this._roster(root), byId = new Map([[root.id, node(root)], ...members.map((m) => [m.id, node(m)])]);
    for (const m of members) { const up = byId.get(m.reportsTo) || byId.get(root.id); up.reports.push(byId.get(m.id)); }
    byId.get(root.id).helpers = Object.values(this.agents).filter((a) => a.parentId && !a.member && this.rootOf(a).id === root.id).length;
    return byId.get(root.id);
  }

  // ---------- project files ----------
  _fileRoot(agentId) {
    const a = this.agents[agentId];
    if (!a) throw httpErr(404, 'No such agent');
    return realpathSync(this.rootOf(a).cwd);
  }
  _safePath(agentId, rel = '') {
    const root = this._fileRoot(agentId);
    const full = path.resolve(root, String(rel).replace(/^\/+/, ''));
    if (full !== root && !full.startsWith(root + path.sep)) throw httpErr(400, 'That path is outside the project');
    const parts = path.relative(root, full).split(path.sep);
    if (parts.includes('.git')) throw httpErr(400, 'The .git folder is managed by Apiary');
    // resolve symlinks on the part that exists so a link cannot lead outside
    let probe = full; while (!existsSync(probe) && probe !== root) probe = path.dirname(probe);
    const real = realpathSync(probe);
    if (real !== root && !real.startsWith(root + path.sep)) throw httpErr(400, 'That path is outside the project');
    return { root, full };
  }
  files(agentId, rel = '') {
    const { root, full } = this._safePath(agentId, rel);
    let st; try { st = statSync(full); } catch { throw httpErr(404, 'No such folder'); }
    if (!st.isDirectory()) throw httpErr(400, 'Not a folder');
    const items = readdirSync(full, { withFileTypes: true }).filter((e) => !['.git', 'node_modules'].includes(e.name)).map((e) => {
      const s = statSync(path.join(full, e.name));
      return { name: e.name, type: e.isDirectory() || s.isDirectory() ? 'dir' : 'file', size: s.size, mtime: s.mtimeMs };
    }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { path: path.relative(root, full), items };
  }
  readFile(agentId, rel) {
    const { full } = this._safePath(agentId, rel);
    let st; try { st = statSync(full); } catch { throw httpErr(404, 'No such file'); }
    if (!st.isFile()) throw httpErr(400, 'Not a file');
    return { full, size: st.size, name: path.basename(full) };
  }
  writeFile(agentId, rel, content) {
    if (typeof content !== 'string') throw httpErr(400, 'content must be text');
    if (Buffer.byteLength(content) > 2_000_000) throw httpErr(413, 'Files up to 2 MB can be saved here');
    const { full, root } = this._safePath(agentId, rel);
    if (full === root) throw httpErr(400, 'Give the file a name');
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
    return { path: path.relative(root, full) };
  }
  deleteFile(agentId, rel) {
    const { full, root } = this._safePath(agentId, rel);
    if (full === root) throw httpErr(400, 'Cannot delete the project folder');
    let st; try { st = statSync(full); } catch { throw httpErr(404, 'No such file'); }
    if (st.isDirectory()) throw httpErr(400, 'Only files can be deleted here');
    unlinkSync(full);
  }

  // ---------- hiring ----------
  _scope(root) { return root.kind === 'general' ? 'org' : root.id; }
  _standing(agent) { const p = this._persona(agent); return (p.mdFile && orgfiles.readStanding(p.mdFile)) || p.instructions || ''; }

  // Create a permanent team member: name (comic-book style unless given), full profile, Markdown file.
  async _makeMember(root, spec) {
    const roster = this._roster(root);
    const taken = new Set([root.name, ...roster.map((m) => m.name)].map((n) => n.toLowerCase()));
    const title = String(spec.title || spec.name || 'Specialist').trim().slice(0, 60);
    const dept = DEPARTMENTS[spec.department] ? spec.department : inferDepartment(title, spec.role);
    let name = String(spec.name || '').trim().slice(0, 40) || pickName(dept, taken);
    if (taken.has(name.toLowerCase())) { let i = 2; while (taken.has(`${name} ${i}`.toLowerCase())) i++; name = `${name} ${i}`; }
    const profile = buildProfile({ name, title, role: spec.role, department: dept, reason: spec.reason, instructions: spec.instructions, guardrails: spec.guardrails });
    const boss = this.agents[spec.reportsTo] || root;
    const child = await this._makeChild(root, { name, title, role: profile.role, instructions: profile.instructions, provider: spec.provider || root.provider, model: spec.model, member: true, consult: spec.consult !== false, memKey: slug(title), department: profile.department, profile, reportsTo: boss.id, hiredAt: Date.now() });
    child.mdFile = orgfiles.writeAgent(this._scope(root), child.memKey, { name, title, department: profile.departmentLabel, reportsTo: boss.name, reason: spec.reason, instructions: profile.instructions, hired: child.hiredAt });
    this.store.save();
    return child;
  }

  // A proposal is turned into complete profiles (instructions + guardrails), shown for approval, then the agents join the team.
  // An agent suggests devices, links or a question about the person's infrastructure. They appear as "Is this right?" cards.
  _infra(agent, list) {
    const who = this._persona(agent);
    const r = this.infra.propose(who.name, list);
    if (r.added.length) this.emit('event', { type: 'infra' });
    if (r.added.length) this._msg(agent, { role: 'system', text: `Added ${r.added.length} suggestion${r.added.length > 1 ? 's' : ''} to the Infrastructure page for you to confirm: ${r.added.map((i) => i.name).join(', ')}.` });
    for (const n of r.notes) this._msg(agent, { role: 'system', text: n, error: true });
    return r;
  }
  async _hire(proposer, hires, notes) {
    const root = this._teamRoot(proposer);
    const roster = this._roster(root);
    const titles = new Set(roster.map((m) => (m.title || m.name).toLowerCase()));
    const taken = new Set([root.name, ...roster.map((m) => m.name)].map((n) => n.toLowerCase()));
    const ok = [];
    for (const h of hires.slice(0, 8)) {
      const title = String(h.title || h.name).trim().slice(0, 60);
      if (titles.has(title.toLowerCase())) { notes.push(`There is already a ${title} on the team, so no one was hired for that. Use apiary-assign to give them work.`); continue; }
      if (this.tree(root.id).length + ok.length >= this.limits.maxAgents) { notes.push(`Could not hire a ${title}: the team is at its size limit.`); continue; }
      titles.add(title.toLowerCase());
      const dept = DEPARTMENTS[h.department] ? h.department : inferDepartment(title, h.role);
      const given = h.title && h.name ? String(h.name).trim().slice(0, 40) : '';
      const name = given && !taken.has(given.toLowerCase()) ? given : pickName(dept, taken);
      taken.add(name.toLowerCase());
      const provider = this.available.some((p) => p.id === h.provider) ? h.provider : root.provider;
      const want = String(h.reportsTo || '').toLowerCase();
      const same = (m) => m.name.toLowerCase() === want || (m.title || '').toLowerCase() === want;
      const up = [root, ...roster].find(same) || ok.find((o) => o.name.toLowerCase() === want || o.title.toLowerCase() === want) || (proposer.member ? proposer : root);
      const advice = suggestModel({ provider, department: dept, role: h.role, complexity: h.complexity, models: this._modelList(provider) });
      ok.push({ title, name, provider, advice, spec: { ...h, title, department: dept }, reportsTo: up.id || null, reportsToName: up.name, profile: buildProfile({ name, title, role: h.role, department: dept, reason: h.reason, instructions: h.instructions, guardrails: h.guardrails }) });
    }
    if (!ok.length) return;
    let chosen = ok.map((x, i) => ({ x, i })), names = {}, models = {};
    if (this._needsApproval(proposer)) {
      this._setStatus(proposer, 'waiting');
      this.emit('event', { type: 'activity', agentId: proposer.id, text: 'Waiting for your approval to hire' });
      const r = await this._ask(proposer, {
        kind: 'hire', title: `${proposer.name} suggests hiring ${ok.length} ${ok.length > 1 ? 'people' : 'person'}`,
        items: ok.map((x) => ({ name: x.name, title: x.title, role: x.profile.role, department: x.profile.department, departmentLabel: x.profile.departmentLabel, reason: x.profile.reason, provider: x.provider, reportsTo: x.reportsToName, instructions: x.profile.instructions, guardrails: x.profile.guardrails, suggestedModel: x.advice.model, modelWhy: x.advice.why, modelOptions: this._modelList(x.provider).map((m) => m.id) })),
      });
      if (r.decision === 'deny') { notes.push(`The human did not approve these hires${r.note ? ': ' + r.note : ''}. Carry on without them or propose something different.`); return; }
      if (r.only) { const skipped = ok.length - r.only.length; chosen = chosen.filter(({ i }) => r.only.includes(i)); if (skipped) notes.push(`The human approved only some hires; ${skipped} were not hired.`); }
      names = r.names || {}; models = r.models || {};
      if (r.note) notes.push(`Human note: ${r.note}`);
    }
    const hired = [], made = new Map();
    for (const { x, i } of chosen) {
      // a manager proposed in the same batch only counts if they were actually hired
      const boss = x.reportsTo || made.get(x.reportsToName) || root.id;
      const pickedModel = i in models ? models[i] : x.advice.model;
      const child = await this._makeMember(root, { ...x.spec, name: names[i] || x.name, provider: x.provider, model: x.provider === 'mock' ? '' : pickedModel, reportsTo: boss });
      made.set(x.name, child.id);
      this._msg(root, { role: 'system', text: `Hired ${child.name}, ${x.title} (${x.profile.departmentLabel}), reporting to ${x.reportsToName}`, agentId: child.id });
      hired.push(`${child.name} (${x.title})`);
    }
    if (hired.length) notes.push(`Hired: ${hired.join(', ')}. They are now permanent team members: hand them work with apiary-assign.`);
  }

  // The standing organisation, offered as a team for new projects.
  _orgTeamDef() {
    const g = Object.values(this.agents).find((x) => x.kind === 'general');
    const members = g ? this._roster(g) : [];
    if (!members.length) return null;
    return { id: 'org', name: 'My organisation', lead: { name: g.name, role: g.role, instructions: this._standing(g) },
      members: members.map((m) => ({ name: m.name, title: m.title || m.name, role: m.role, department: m.department, instructions: m.profile?.custom || '', provider: m.provider, model: m.model, consult: m.consult !== false })) };
  }

  // ---------- organisation: the CEO and the standing team ----------
  // One short question at a time, written by the AI, until it knows enough to propose a team.
  async interview({ answers = [], ceoName = '' } = {}) {
    answers = (Array.isArray(answers) ? answers : []).slice(0, 12).map((a) => ({ q: String(a.q || '').slice(0, 400), a: String(a.a || '').slice(0, 1500) }));
    const MAX = 8;
    const transcript = answers.map((a, i) => `Q${i + 1}: ${a.q}\nA${i + 1}: ${a.a}`).join('\n\n');
    const system = `ONBOARDING INTERVIEW. You are helping a person set up their personal organisation of AI agents: a CEO and a few specialists. Interview them to learn their setup and goals. Ask ONE short question at a time (the person can pick several of your choices and add their own words, so offer choices that can be combined and say so when they cannot), each building on earlier answers (their infrastructure and network, servers and hosting, websites, tools they use, what they want help with, how much the agents may change without asking, how they like to be kept informed). Offer 2 to 5 short quick-answer choices. Never ask for passwords, keys or tokens: those go in an encrypted vault later. Ask at most ${MAX} questions in total${answers.length >= MAX - 1 ? '; you have asked enough, so finish now' : ''}.\n` +
      'Reply with JSON only, no other text. To ask: {"question":"...","choices":["..."]}. When you know enough: {"done":true,"overview":"markdown summary of their setup and goals, no secrets","team":[{"title":"Job title","department":"engineering|marketing|design|security|networking|research|data|product|operations|finance|legal","role":"what they do","reason":"why this person needs them","instructions":"specifics for this setup"}]} with 3 to 6 specialists that fit what they said and no one they do not need.';
    let out;
    try { out = await this._oneShot(system, transcript ? `Interview so far:\n\n${transcript}\n\nContinue.` : 'Start the interview.'); }
    catch (e) { out = null; this._lastInterviewError = e.message; }
    let j = null;
    try { const m = /\{[\s\S]*\}/.exec(out || ''); if (m) j = JSON.parse(m[0]); } catch { j = null; }
    if (!j || (!j.done && !j.question)) j = fallbackInterview(answers);
    if (answers.length >= MAX && !j.done) j = fallbackInterview(answers, true);
    if (!j.done) return { question: String(j.question).slice(0, 400), choices: [].concat(j.choices || []).map(String).slice(0, 5).map((c) => c.slice(0, 80)), asked: answers.length + 1, max: MAX };
    const taken = new Set([ceoName].filter(Boolean));
    const team = (Array.isArray(j.team) ? j.team : []).slice(0, 6).filter((t) => t && String(t.title || '').trim()).map((t) => {
      const title = String(t.title).trim().slice(0, 60), dept = DEPARTMENTS[t.department] ? t.department : inferDepartment(title, t.role);
      const name = pickName(dept, taken); taken.add(name.toLowerCase());
      const profile = buildProfile({ name, title, role: t.role, department: dept, reason: t.reason, instructions: t.instructions });
      return { name, title, department: dept, departmentLabel: profile.departmentLabel, role: String(t.role || '').slice(0, 300), reason: String(t.reason || '').slice(0, 400), custom: String(t.instructions || '').slice(0, 2000), instructions: profile.instructions, guardrails: profile.guardrails };
    });
    return { done: true, overview: String(j.overview || '').slice(0, 5000), team, suggestedCeoName: ceoName || pickName('leadership', taken) };
  }
  // A single question to the AI with no project, tools or memory. Used for the interview.
  async _oneShot(system, prompt) {
    const provider = this.defaultProvider || this.available.find((p) => p.id !== 'mock')?.id || this.available[0]?.id;
    if (!provider) throw httpErr(400, 'Connect an AI first (Connections).');
    const cwd = path.join(HOME, 'workspaces', 'interview');
    mkdirSync(cwd, { recursive: true });
    const agent = { id: 'interview', name: 'Interviewer', role: '', provider, method: this.resolveMethod(provider), model: this.defaultModel(provider), cwd, access: 'safe', depth: 0 };
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 180000);
    try {
      const res = await providers.pick(agent).run({ agent, prompt, system, signal: ctl.signal, history: [], conn: agent.method === 'api' ? this.connections.get(provider) : null, onText() {}, onActivity() {}, onLog() {} });
      this._usage(agent, res, system, prompt);
      return res.text;
    } finally { clearTimeout(timer); }
  }

  // Turn the interview into the CEO (the main chat agent) and its team. Safe to run again: it only adds.
  async createOrg({ ceoName, overview, team = [] } = {}) {
    const g = await this.general();
    const name = String(ceoName || '').trim().slice(0, 40) || pickName('leadership', new Set());
    if (this.store.data.settings.orgDone && g.name !== name && Object.values(this.agents).some((a) => a.id !== g.id && a.name.toLowerCase() === name.toLowerCase())) throw httpErr(409, `Someone is already called ${name}`);
    Object.assign(g, { name, title: 'CEO', role: 'Chief executive: understands what you need, hands each job to the right specialist, and reports back', department: 'leadership', team: { id: 'org', name: 'My organisation', leadName: name }, org: true, memKey: 'ceo' });
    const ov = String(overview || '').trim();
    if (ov) orgfiles.writeCompany(`# About my setup\n\n${ov}\n`);
    g.mdFile = orgfiles.writeAgent('org', 'ceo', { name, title: 'CEO', department: 'Leadership', reportsTo: 'you', reason: '', instructions: 'You are the CEO of this person\'s organisation. Decide who should do each job, hand it over, and give the human a short, clear summary when it is done. Do not do specialist work yourself when a team member can. Use the overview of their setup (shown below as "About the human\'s setup") to make good decisions.', hired: g.createdAt });
    this.emit('event', { type: 'agent', agent: g });
    const made = [];
    for (const t of (Array.isArray(team) ? team : []).slice(0, 8)) {
      if (!t || !String(t.title || '').trim()) continue;
      if (this._roster(g).some((m) => (m.title || m.name).toLowerCase() === String(t.title).trim().toLowerCase())) continue;
      made.push(await this._makeMember(g, { title: t.title, name: t.name, role: t.role, department: t.department, reason: t.reason, instructions: t.custom ?? t.instructions, provider: g.provider, reportsTo: g.id }));
    }
    this.store.data.settings.orgDone = true; this.store.save();
    return { ceo: g, hired: made.length, org: this.org(g.id) };
  }

  // ----- profiles (the Markdown file behind each agent) -----
  profile(agentId) {
    const a = this.agents[agentId];
    if (!a) throw httpErr(404, 'No such agent');
    let text = ''; try { if (a.mdFile) text = readFileSync(a.mdFile, 'utf8'); } catch { /* none yet */ }
    return { id: a.id, name: a.name, title: a.title || '', role: a.role, department: a.department || '', file: a.mdFile || null, text };
  }
  setProfile(agentId, { name, text } = {}) {
    const a = this.agents[agentId];
    if (!a) throw httpErr(404, 'No such agent');
    if (name !== undefined) {
      const n = String(name).trim().slice(0, 40);
      if (!n) throw httpErr(400, 'Give the agent a name');
      const root = this.rootOf(a);
      if (this.tree(root.id).some((i) => i !== a.id && this.agents[i]?.name.toLowerCase() === n.toLowerCase())) throw httpErr(409, `Someone on this team is already called ${n}`);
      if (n !== a.name) {
        a.name = n;
        if (a.mdFile) { try { const t = readFileSync(a.mdFile, 'utf8').replace(/^name:.*$/m, `name: ${n}`).replace(/^# .*?( — .*)?$/m, (_, r) => `# ${n}${r || ''}`); orgfiles.writeRaw(a.mdFile, t); } catch { /* file missing */ } }
        this.emit('event', { type: 'agent', agent: a });
      }
    }
    if (text !== undefined) {
      if (!a.mdFile) throw httpErr(409, 'This agent has no profile file');
      if (String(text).length > 20000) throw httpErr(413, 'That profile is too long');
      orgfiles.writeRaw(a.mdFile, String(text));
    }
    this.store.save();
    return this.profile(agentId);
  }

  // ---------- team meetings ----------
  // Everyone reports what they did, then everyone hears everyone else's report. Minutes are saved as Markdown.
  async runMeeting(rootId, { since } = {}) {
    const root = this.agents[rootId];
    if (!root) throw httpErr(404, 'No such project');
    const people = [root, ...this._roster(root)];
    if (people.length < 2) throw httpErr(409, 'A meeting needs at least two people on the team');
    const from = { id: 'meeting', name: 'Team meeting' };
    const now = new Date(), date = now.toLocaleDateString('en-CA');
    since = since || Math.max(this.meeting.last || 0, Date.now() - 7 * 86400000);
    const label = (a) => `${a.name}${a.title ? ` (${a.title})` : ''}`;
    const ask = (a, text) => this.send(a.id, text, from).then((t) => (t || '').trim() || '(no update)', (e) => `(no update: ${e.message})`);
    const upd = await Promise.all(people.map((a) => {
      const mine = this.memory.items.filter((m) => m.kind === 'episode' && m.agent === this._mkey(a) && m.ts >= since).slice(-8).map((m) => `- ${new Date(m.ts).toLocaleString()}: ${m.text.slice(0, 220)}`).join('\n');
      return ask(a, `TEAM MEETING, update round (${date}). Tell the team in 3 to 6 short lines: what you did since ${new Date(since).toLocaleString()}, anything others must know (changes you made, decisions, risks), and anything you are blocked on or need from someone. Do not start new work and do not use apiary-send, apiary-assign or apiary-spawn.\n\nWhat Apiary recorded for you in that time:\n${mine || '(nothing recorded)'}`);
    }));
    const report = people.map((a, i) => `### ${label(a)}\n${upd[i]}`).join('\n\n');
    const replies = await Promise.all(people.map((a) => ask(a, `TEAM MEETING, everyone's updates (${date}):\n\n${report}\n\nIn 1 to 3 lines: what affects your work, any conflict or gap you can see, and any follow-up you will take. If nothing, say "Noted."`)));
    const follow = people.map((a, i) => `- **${label(a)}**: ${replies[i].replace(/\s+/g, ' ')}`).join('\n');
    const md = `# Team meeting, ${date}\n\n${root.kind === 'general' ? 'Organisation' : `Project: ${root.name}`}\n\n## Updates\n\n${report}\n\n## Reactions and follow-ups\n\n${follow}\n`;
    const file = orgfiles.writeMinutes(this._scope(root), date, this._redact(md));
    this.memory.add({ kind: 'episode', agent: null, project: this._pkey(root), who: 'Team meeting', text: this._redact(`Team meeting ${date}. ${people.map((a, i) => `${a.name}: ${upd[i].replace(/\s+/g, ' ').slice(0, 160)}`).join(' | ')}`).slice(0, 1500) });
    return { file, date, scope: this._scope(root) };
  }
  // Called every minute by the server: holds the meeting when the chosen time has passed.
  async tickMeetings(now = new Date()) {
    const m = this.meeting;
    if (m.frequency === 'off') return null;
    const [hh, mm] = m.time.split(':').map(Number);
    const due = new Date(now); due.setHours(hh, mm, 0, 0);
    if (m.frequency === 'weekly') { due.setDate(due.getDate() - ((due.getDay() - m.weekday + 7) % 7)); }
    if (due > now) { if (m.frequency === 'daily') due.setDate(due.getDate() - 1); else due.setDate(due.getDate() - 7); }
    if ((m.last || 0) >= due.getTime()) return null;
    const since = m.last || due.getTime() - 86400000;
    this.store.data.settings.meeting = { ...m, last: now.getTime() }; this.store.save();
    const ran = [];
    for (const root of Object.values(this.agents).filter((a) => !a.parentId && this.stageOf(a) !== 'closed')) {
      if (this._roster(root).length < 1 || (root.kind !== 'general' && !this.memory.items.some((e) => e.project === this._pkey(root) && e.ts >= since))) continue;
      try { ran.push(await this.runMeeting(root.id, { since })); } catch (e) { this._log(root, `! team meeting failed: ${e.message}`); }
    }
    return ran;
  }

  // ---------- secrets ----------
  _leaseEnv(agent) {
    const mp = this.leases.get(agent.id);
    const us = this.userLeases.get(agent.id);
    return { ...(this.metaLeases.get(agent.id) || {}), ...(mp ? Object.fromEntries([...mp].map(([name, v]) => [envName(name), v])) : {}), ...(us ? Object.fromEntries([...us].map(([name, v]) => [envName(name) + '_USER', v])) : {}) };
  }
  // An agent asked for secrets with apiary-secret. Needs: vault unlocked, secret assigned to this agent, and the human's yes.
  async _secrets(agent, reqs, notes) {
    for (const r of reqs) {
      const it = this.vault.byName(r.name);
      if (!this.vault.unlocked) { notes.push(`The secrets vault is locked, so "${r.name}" is not available. Ask the human to unlock it (Secrets page).`); continue; }
      if (!it || !(agent.member || !agent.parentId)) { notes.push(`There is no secret called "${r.name}" that you can use.`); continue; }
      const key = this._mkey(agent), asg = it.assigned?.[key] || it.assigned?.[agent.memKey || slug(agent.name)];   // the second is how it was assigned before projects were led by the CEO
      let asgd = asg;
      if (!asg) {
        // Not assigned to this agent yet (for example you gave it to the CEO and the project's lead is asking). Ask the human on the spot.
        this._setStatus(agent, 'waiting');
        this.emit('event', { type: 'activity', agentId: agent.id, text: 'Waiting for your approval to use a secret' });
        const d = await this._ask(agent, { kind: 'secret', title: `${agent.name} wants to use the secret "${it.name}"`, detail: `${it.name} is NOT assigned to ${agent.name} yet. "Allow once" lets it use the secret this one time. "Always allow" also gives it permanent access (you can take it away on the Secrets page).${r.why ? ` Reason given: ${r.why}` : ''}`, secret: it.name, unassigned: true });
        if (d.decision === 'deny') { notes.push(`The human did not give you access to "${it.name}"${d.note ? ': ' + d.note : ''}. Do not look for it elsewhere.`); continue; }
        if (d.mode === 'always') this.vault.assign(it.id, key, this._agentLabel(agent), 'always');
        asgd = { grant: d.mode === 'always' ? 'always' : 'ask' };
      }
      let allowed = !asg || asg.grant === 'always';   // not assigned: the human just approved it above
      if (!allowed) {
        this._setStatus(agent, 'waiting');
        this.emit('event', { type: 'activity', agentId: agent.id, text: 'Waiting for your approval to use a secret' });
        const d = await this._ask(agent, { kind: 'secret', title: `${agent.name} wants to use the secret "${it.name}"`, detail: r.why ? `Reason given: ${r.why}` : 'No reason was given.', secret: it.name });
        if (d.decision === 'deny') { this.audit.add('secret', { actor: agent.name, project: this._pname(agent), action: `denied secret "${it.name}"` }); notes.push(`The human did not allow use of "${it.name}"${d.note ? ': ' + d.note : ''}.`); continue; }
        allowed = true;
        if (d.mode === 'always') this.vault.setGrant(it.id, key, 'always');
      }
      const val = this.vault.value(it.id);
      if (val === null) { notes.push(`"${it.name}" could not be read.`); continue; }
      (this.leases.get(agent.id) || this.leases.set(agent.id, new Map()).get(agent.id)).set(it.name, val);
      const uname = this.vault.user(it.id);
      if (uname) (this.userLeases.get(agent.id) || this.userLeases.set(agent.id, new Map()).get(agent.id)).set(it.name, uname);
      this.audit.add('secret', { actor: agent.name, project: this._pname(agent), action: `used secret "${it.name}"`, detail: asgd.grant === 'always' ? 'always allowed' : 'approved' });
      this._log(agent, `🔑 using secret "${it.name}"${asgd.grant === 'always' ? ' (always allowed)' : ''}`);
      const type = typeOf(it), EV = envName(it.name), meta = this.vault.list().find((x) => x.id === it.id) || {};
      if (type === 'ssh') { const mm = this.metaLeases.get(agent.id) || this.metaLeases.set(agent.id, {}).get(agent.id); Object.assign(mm, { [`${EV}_HOST`]: meta.host, [`${EV}_PORT`]: String(meta.port || 22), [`${EV}_AUTH`]: meta.auth || 'password' }); }
      if (type === 'ssh') notes.push(`"${it.name}" is an SSH login for ${uname}@${meta.host}:${meta.port || 22}. To use it run: apiary-ssh "${it.name}" -- <command on the server>   (leave out "-- <command>" for a shell). Add ssh options before the "--", for example -L 8080:localhost:80. The helper handles the ${meta.auth === 'key' ? 'private key' : 'password'} and the server's fingerprint for you. Do not call ssh, sshpass or ssh-keygen yourself, and never print the secret. It is available for this task only.`);
      else if (type === 'token') notes.push(`The secret "${it.name}" (an API key or token) is available to your commands as the environment variable $${EV} for this task only. Use it in commands, for example in an Authorization header. Never print it, write it to a file or put it in your reply.`);
      else notes.push(`The login "${it.name}" is available to your commands as the environment variable $${EV} (the password)${uname ? ` (the username is in $${EV}_USER)` : ''} for this task only. Use it in commands; never print it, write it to a file or put it in your reply.`);
    }
  }
  // Tells an agent which secrets it may ask for (names only, never values) and, for a lead, who else holds which.
  _secretsNote(agent) {
    if (!this.vault.unlocked) return 'The secrets vault is locked right now. If a task needs a secret, tell the human to unlock it (Secrets page).\n';
    const key = this._mkey(agent), items = this.vault.list(), holds = (x, k) => (x.assigned || []).some((a) => a.key === k), mine = items.filter((x) => holds(x, key));
    let n = mine.length ? `Secrets assigned to you (ask for them by exactly this name): ${mine.map((x) => `"${x.name}" (${TYPE_LABEL[typeOf(x)]})`).join(', ')}.\n` : 'No secret is assigned to you yet.\n';
    if (agent.kind === 'general' || !agent.parentId) {
      const others = this.eligibleAgents().filter((e) => e.key !== key).map((e) => ({ e, names: items.filter((x) => holds(x, e.key)).map((x) => `"${x.name}"`) })).filter((o) => o.names.length);
      if (others.length) n += `Secrets assigned to your teammates: ${others.map((o) => `${o.e.label}: ${o.names.join(', ')}`).join('; ')}. Hand the job to the teammate who holds the secret; they ask for it themselves.\n`;
    }
    return n;
  }
  _clearLease(id) { this.leases.delete(id); this.userLeases.delete(id); this.metaLeases.delete(id); }
  // Who can be given a secret: the CEO, project leads and standing team members, by role (so renaming does not break access).
  _agentLabel(a) {
    const t = a.title && a.title !== a.name ? a.title : '';
    if (a.kind === 'general') return a.name === 'CEO' ? 'CEO' : `${a.name} (CEO)`;
    if (a.member) return t ? `${a.name} (${t})` : a.name;
    return `${a.name} (project lead)`;
  }
  eligibleAgents() {
    const seen = new Map();
    for (const a of Object.values(this.agents)) if (a.member || (!a.parentId && !this._isProject(a))) { const k = this._mkey(a); if (!seen.has(k)) seen.set(k, { key: k, label: this._agentLabel(a) }); }
    return [...seen.values()].sort((x, y) => x.label.localeCompare(y.label));
  }

  // ---------- teams ----------
  get teams() { return this.store.data.teams; }
  seedTeams() {
    if (this.store.data.settings.teamsSeeded) return;
    this.store.data.settings.teamsSeeded = true;
    this.saveTeam({
      name: 'Operations team', description: 'A CEO who hands work to the right specialist, who first checks with the others.',
      lead: { name: 'CEO', role: 'Chief executive: understands the request, picks the right specialist, and reports back', instructions: 'You decide who should do the work and never do specialist work yourself. When a report comes back, give the human a short, clear summary.' },
      members: [
        { name: 'Networking', role: 'Network engineer: firewalls, DNS, VPN, routing, reverse proxies', instructions: 'Make careful, reversible network changes and say how to roll back.', consult: true },
        { name: 'Security', role: 'Security engineer: reviews risk, hardening, access, secrets, exposure', instructions: 'Review changes for security risk. If something must be fixed or checked before a change goes ahead, list it as a prerequisite. Block only changes that should not happen at all.', consult: true },
        { name: 'Research', role: 'Researcher: finds facts, compares options, reads documentation', instructions: 'Find reliable facts and say how sure you are.', consult: true },
      ],
    });
  }
  saveTeam(f, id = null) {
    const name = String(f.name || '').trim().slice(0, 40);
    if (!name) throw httpErr(400, 'Give the team a name');
    const dup = Object.values(this.teams).find((t) => t.name.toLowerCase() === name.toLowerCase() && t.id !== id);
    if (dup) throw httpErr(409, `You already have a team called "${name}"`);
    const person = (x, what) => {
      const n = String(x?.name || '').trim().slice(0, 40);
      if (!n) throw httpErr(400, `Every ${what} needs a name`);
      if (x.provider && !['claude', 'codex', 'mock'].includes(x.provider)) throw httpErr(400, 'Unknown provider');
      return { name: n, role: String(x.role || '').slice(0, 300), instructions: String(x.instructions || '').slice(0, 4000), provider: x.provider || '', model: String(x.model || '').slice(0, 100), consult: x.consult !== false };
    };
    const lead = person(f.lead, 'lead');
    const members = (Array.isArray(f.members) ? f.members : []).map((m) => person(m, 'member'));
    if (!members.length) throw httpErr(400, 'Add at least one team member');
    if (members.length > 8) throw httpErr(400, 'A team can have up to 8 members');
    const names = [lead.name, ...members.map((m) => m.name)].map((n) => n.toLowerCase());
    if (new Set(names).size !== names.length) throw httpErr(400, 'Names within a team must be different');
    const t = { id: id || id8(), name, description: String(f.description || '').slice(0, 300), lead, members };
    this.teams[t.id] = t; this.store.save();
    return t;
  }
  removeTeam(id) { if (!this.teams[id]) throw httpErr(404, 'No such team'); delete this.teams[id]; this.store.save(); }
  _roster(lead) { return Object.values(this.agents).filter((a) => a.parentId === lead.id && a.member); }

  // ---------- public API ----------
  async createLead({ name, provider, model, cwd, access, goal, source, base, approvals, team }) {
    const tdef = team === 'org' ? this._orgTeamDef() : team ? this.teams[team] : null;
    if (team && !tdef) throw httpErr(400, 'That team no longer exists');
    if (!this.available.some((p) => p.id === provider)) throw httpErr(400, `Provider "${provider}" is not available. Connect it first.`);
    const method = this.resolveMethod(provider);
    const id = id8();
    const title = (name || goal || 'New project').trim().split('\n')[0].slice(0, 48);
    const pslug = slug(title);
    const fields = { id, name: title, role: 'Lead agent', provider, method, model: model || this.defaultModel(provider), access: access === 'full' ? 'full' : 'safe', parentId: null, depth: 0, ownerId: this.orgDone ? this._ceo()?.id : undefined, approvals: approvals === undefined ? this.approvalsDefault : !!approvals };

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
      fields.own = true;   // a folder Apiary made for this project
    }
    mkdirSync(fields.cwd, { recursive: true });
    if (fields.own) for (const d of ['documents', 'data']) mkdirSync(path.join(fields.cwd, d), { recursive: true });
    if (tdef) Object.assign(fields, { role: tdef.lead.role || 'Team lead', instructions: tdef.lead.instructions, department: 'leadership', memKey: slug(tdef.lead.name), team: { id: tdef.id, name: tdef.name, leadName: tdef.lead.name } });
    const agent = this._add(fields);
    if (tdef) {
      for (const m of tdef.members) {
        const prov = this.available.some((p) => p.id === m.provider) ? m.provider : provider;
        await this._makeMember(agent, { title: m.title || m.name, name: m.title ? m.name : undefined, role: m.role, department: m.department, instructions: m.instructions, reason: `${tdef.name} needs a ${(m.title || m.name).toLowerCase()} specialist`, provider: prov, model: m.model || undefined, consult: m.consult !== false, reportsTo: agent.id });
      }
    }
    if (goal) this.send(agent.id, goal).catch(() => {});
    return agent;
  }

  send(agentId, text, from = null) {
    const agent = this.agents[agentId];
    if (!agent) throw httpErr(404, 'No such agent');
    const rt = this.rootOf(agent);
    if (rt.kind !== 'general' && this.stageOf(rt) === 'closed') throw httpErr(409, 'This project is closed. Reopen it (Projects page) to continue. Nothing has been deleted.');
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
    if (this.agents[agentId]?.kind === 'general') throw httpErr(400, 'The main chat cannot be deleted');
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
    const was = agent.status;
    if (status === 'working' && was !== 'working' && was !== 'waiting') this._workStart.set(agent.id, Date.now());
    else if ((status === 'idle' || status === 'error') && (was === 'working' || was === 'waiting') && this._workStart.has(agent.id)) {
      const ms = Date.now() - this._workStart.get(agent.id); this._workStart.delete(agent.id);
      this.emit('task-done', { agent, ms, failed: status === 'error' });
    }
    agent.status = status;
    this.emit('event', { type: 'agent', agent });
    this.store.save();
  }
  _redact(text) {
    const extra = [...this.leases].flatMap(([, mp]) => [...mp]);
    return this.vault.exists ? this.vault.redact(text, extra) : redactPairs(text, extra);
  }
  _msg(agent, m) {
    if (typeof m.text === 'string') m = { ...m, text: this._redact(m.text) };
    const msg = { id: id8(), ts: Date.now(), ...m };
    this.messages(agent.id).push(msg);
    this.emit('event', { type: 'message', agentId: agent.id, message: msg });
    this.store.save();
    return msg;
  }
  _log(agent, line) {
    line = this._redact(line);
    try { this.audit.fromLog(agent.name, this._pname(agent), line); } catch {}
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
    const who = this._persona(agent), proj = this._isProject(agent) ? agent : null;
    let s = `You are "${who.name}" (${who.role}), one agent in a small team coordinated by Apiary. Work in your current directory unless told otherwise.\n`;
    if (proj) s += `You are leading the project "${proj.name}". Its folder is your current directory. ${who.id !== proj.id && who.kind === 'general' ? 'You are the CEO: you decide who does each part. ' : ''}Messages in this chat come from the human.\n`;
    if (this.plainEnglish) s += '\nWRITING STYLE: Write in plain, simple English by default. Short sentences, everyday words, no jargon or buzzwords. If a technical term is needed, explain it in a few words the first time. Say what you did and what happens next. Code, commands and file contents stay exact.\n';
    const standing = this._standing(agent);
    if (standing) s += `\nStanding instructions for you:\n${standing}\n`;
    if (agent.method === 'api') s += 'You are connected through a web API: you cannot read files or run commands. Answer in text only.\n';
    if (agent.git) s += `You are working on git branch ${agent.git.branch} in your own checkout. Your changes are committed for you after each turn; do not switch branches or push.\n`;
    s += agent.parentId
      ? 'Your reply goes back to the agent that gave you this task, not to a human. Be concrete and concise: say what you did, what you found, and where any files are.\n'
      : 'Your replies go to the human you are working for. Be clear and concise.\n';
    s += 'If a message is marked "Message from teammate", your reply goes back to that teammate.\n';
    if (this.memoryEnabled) s += 'You have a long-term memory, shown below as MEMORY when there is something to show. To keep something for next time, put ```apiary-remember\n{"text":"what to remember","scope":"agent"}\n``` in your reply (scope: "agent" for you alone, "project" for the whole team on this project, "global" for everyone). Save lasting facts, decisions and preferences, not chatter.\n';
    const roster = this._roster(this._teamRoot(agent));
    if (roster.length && !agent.parentId) {
      s += `\nYou lead the team "${this._teamRoot(agent).team?.name || 'your team'}". Its members stay on this project, remember past work and talk to each other:\n` + roster.map((m) => `- ${m.name}${m.title ? ` (${m.title})` : ''}: ${m.role}`).join('\n') +
        '\n\nDo not do the specialists\' work yourself. Decide which member is best placed and hand it over with:\n\n```apiary-assign\n{"to":"Member name","task":"Complete instructions that stand alone"}\n```\n\n' +
        'Apiary then makes that member check with the other members first. If a teammate needs something done before the work can start, it is done first; if one blocks the work, you are told why and nothing is changed. You then get the member\'s report to summarise for the human. Hand independent jobs to different members in the same reply; otherwise one at a time. If no member fits, say so or do it yourself.\n';
    }
    if (agent.org || (proj && who.kind === 'general')) s += '\nYou are the CEO of this person\'s organisation. Questions you can answer yourself; real jobs go to the right team member.\n' + (orgfiles.readCompany() ? `\nAbout the human\'s setup (written during setup; the human may edit it):\n${orgfiles.readCompany()}\n` : '');
    else if (agent.kind === 'general') s += '\nYou are the person\'s everyday assistant: answer questions, think things through and do quick tasks here. When something is a real piece of work with its own files and goals (a website, an app, a report series), suggest they create a project for it in Projects so it gets its own space, team and documents.\n';
    if (!agent.parentId) {
      s += '\nYou can propose permanent hires when this project needs a specialist that the team lacks. Apiary shows your proposal to the human with your reasons, writes each hire\'s profile and guardrails from its department, and adds approved people to the team (visible in the organisation chart). Propose like this:\n\n' +
        '```apiary-hire\n{"title":"Job title","role":"What they do","department":"engineering|marketing|design|security|networking|research|data|product|operations|finance|legal","reason":"Why this project needs them","instructions":"Optional specifics for this role","complexity":"simple|normal|hard","reportsTo":"Optional existing member name or title"}\n```\n\n' +
        'Every hire automatically gets a comic-book style codename (the human can change it), so give a job title, not a name. Say how hard the work is ("complexity"): Apiary then suggests the right AI model for the role. Hire only when the work justifies a standing role, and give a real reason. Use apiary-spawn instead for a one-off helper.\n';
    }
    if (agent.kind === 'general' || agent.org || (proj && who.kind === 'general') || !agent.parentId) {
      const known = this.infra.summary();
      s += '\nINFRASTRUCTURE MAP: the person keeps a map of their devices, servers, VMs, websites and how they connect (Infrastructure page). When they mention a device, server, VM, website or service, or you learn one while working, propose it and Apiary shows it to them as an "Is this right?" card; nothing is added until they confirm. Guess sensible details from your own knowledge (type, what it runs on, what it connects to), say why in "why", and when something important is unknown ask in "question" (for example where it is stored, its address, or which secret in the vault logs in to it). Only ask when it matters. Never put passwords in the map: name the vault secret in "notes" instead.\n```apiary-infra\n{"items":[{"name":"pve1","type":"proxmox|server|vm|container|pi|nas|router|switch|website|service|database|cloud|device|other","address":"10.0.0.5","hostedOn":"Existing item name","connectsTo":["Other item name"],"notes":"Optional","why":"Why you think so","question":"Optional question for the person"}]}\n```\n' + (known ? 'Already on the map:\n' + known + '\n' : '');
    }
    if (agent.kind === 'general' || agent.org || !agent.parentId || agent.member) {
      const rb = this.runbooks.promptText();
      s += '\nRUNBOOKS: when you solve a problem that could come back (a fix, a setup, a recovery), save the steps so they can be followed next time. Add a block ```apiary-runbook\n{"title":"Short name","problem":"When this applies","steps":["Step one","Step two"],"tags":["server"]}\n```. Never put passwords, keys or tokens in a runbook; say which secret to use by name. It is saved as a draft that the human must read and approve before it is trusted.\n' +
        (rb ? 'APPROVED RUNBOOKS (the human has approved these; follow them when the problem matches, and say which one you used):\n' + rb + '\n' : 'There are no approved runbooks yet.\n');
    }
    if (this._planOwner(agent) && (!agent.parentId || agent.member)) {
      const lead = !agent.parentId;
      s += this._planContext(agent);
      if (lead && !this._planOwner(agent).plan) s += '\nBIG PROJECTS: this is a project, so the work is usually large and long. Do not start building straight away. First propose a phased plan the human can approve: ```apiary-plan\n{"goal":"What done looks like","phases":[{"title":"Short phase name","goal":"What this phase achieves","steps":["Concrete step","Another step"]}]}\n```. Use 3 to 7 phases (for example research and requirements, design, build, test, launch), each with concrete steps. Small one-off questions do not need a plan.\n';
      s += '\nProgress: when you finish a step (or get stuck), tell Apiary so the human can see where the project stands: ```apiary-progress\n{"phase":1,"step":2,"status":"done","note":"Optional short note"}\n```. "phase" and "step" are numbers or exact names; status is done, active or blocked. Omit "step" to update the whole phase.' + (lead ? ' If the plan needs to change, send a new apiary-plan block; finished work is kept.' : '') + '\n';
    }
    s += '\nTasks: you can add to the human\'s task board, or move a task, with ```apiary-task\n{"title":"Short task title","notes":"Optional detail","status":"todo|backburner|inprogress|blocked|done"}\n```. Use the same title to update a task. "backburner" is for ideas that are not ready yet.\n';
    if ((agent.member || !agent.parentId) && this.vault.exists) s += '\nSecrets: you never see passwords or keys. If a task needs one, ask with a block like ```apiary-secret\n{"name":"Name of the secret","why":"what you need it for"}\n```. If it is not assigned to you yet, the human is asked right then whether to allow it. The human approves each use unless they chose always. If approved, it is available to your shell commands as an environment variable named in the reply; use it there and never print or save it.\n';
    if ((agent.member || !agent.parentId) && this.vault.exists) s += this._secretsNote(agent);
    if (agent.member || !agent.parentId) s += this._ownerNote(agent);
    if (agent.member) {
      const lead = this.agents[agent.parentId];
      s += `\nYou are a standing member of the team "${lead?.team?.name || 'team'}" led by ${lead?.name || 'the lead'}. Before a teammate does a task, Apiary may ask you for a pre-check from your area. Then reply in exactly this shape and do no work yet:\nVERDICT: GO | CONDITIONS | BLOCK\nREASON: one or two sentences\nPREREQUISITE: something that must be done first (one line per item, only with CONDITIONS)\n` +
        'Use CONDITIONS when something in your area must be done or checked first; use BLOCK only if the task should not happen at all. If you are asked to complete a prerequisite, do it fully now and begin your reply with DONE or FAILED. Your work is on your own branch; Apiary merges it into the lead\'s.\n';
    }
    const mates = [...new Set([...this.tree(this.rootOf(agent).id), ...(!agent.parentId ? this._roster(this._teamRoot(agent)).map((m) => m.id) : [])])].map((i) => this.agents[i]).filter((a) => a && a.id !== agent.id);
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

  // Run a specialist's turn on a project that lives in another folder, then forget it again.
  _onProject(workerId, root, fn) {
    if (!root) return fn();
    this.projectFor.set(workerId, root.id);
    return Promise.resolve().then(fn).finally(() => { if (this.projectFor.get(workerId) === root.id) this.projectFor.delete(workerId); });
  }
  _projectDirs(agent) { const r = this.agents[this.projectFor.get(agent.id)]; return r?.cwd && r.cwd !== agent.cwd ? [r.cwd] : []; }
  _projectNote(agent) {
    const r = this.agents[this.projectFor.get(agent.id)];
    return r ? `\nYou are working on the project "${r.name}". Its folder is ${r.cwd} (you have been given access to it). Make the project's changes there. Your own folder is only for your notes.\n` : '';
  }
  async _exec(agent, prompt) {
    const ctl = new AbortController();
    this.ctls.set(agent.id, ctl);
    this._setStatus(agent, 'working');
    this._log(agent, `── ${new Date().toLocaleTimeString()} ${agent.name} (${agent.provider}, ${agent.method === 'api' ? 'web' : 'terminal'}) ──`);
    try {
      const runner = providers.pick(agent);
      const system = this._system(agent) + this._projectNote(agent) + this.repos.contextFor(agent) + (this.memoryEnabled ? this.memory.context(this._mkey(agent), this._pkey(agent), prompt) : '');
      const res = await runner.run({
        agent, prompt, system, dirs: [...this.repos.dirsFor(agent), ...this._projectDirs(agent)], signal: ctl.signal,
        history: agent.history || [], conn: agent.method === 'api' ? this.connections.get(agent.provider) : null,
        onText: (text) => this.emit('event', { type: 'delta', agentId: agent.id, text: this._redact(text) }),
        onActivity: (text) => this.emit('event', { type: 'activity', agentId: agent.id, text }),
        onLog: (line) => this._log(agent, line), env: this._leaseEnv(agent),
      });
      this._usage(agent, res, system, prompt);
      if (res.sessionId) agent.sessionId = res.sessionId;
      if (agent.method === 'api') {
        agent.history = [...(agent.history || []), { role: 'user', content: prompt }, { role: 'assistant', content: res.text }].slice(-40);
      }
      return res.text;
    } catch (e) {
      if (e.name !== 'AbortError') { this.health.noteLoginFailure(agent.provider, e.message); this._log(agent, `! ${e.message}`); if (looksLikeLimit(e.message)) { this.usage.markLimit(agent.provider); this._log(agent, `! ${agent.provider} looks like it has reached its usage limit. See Usage.`); } }
      throw e;
    } finally {
      this.ctls.delete(agent.id);
      this.emit('event', { type: 'activity', agentId: agent.id, text: '' });
    }
  }

  _usage(agent, res, system, prompt) {
    this.health.noteSuccess(agent.provider);
    const u = res.usage;
    if (u && (u.input || u.output)) this.usage.record({ agentId: agent.id, name: agent.name, provider: agent.provider, model: agent.model, input: u.input, output: u.output });
    else this.usage.record({ agentId: agent.id, name: agent.name, provider: agent.provider, model: agent.model, input: estimateTokens(system, prompt), output: estimateTokens(res.text), estimated: true });
  }

  // ----- project stages: Building, then Maintenance, finally Closed (nothing is ever deleted) -----
  stageOf(root) { return root.stage || 'building'; }
  // The agent responsible for a project (its lead does the work). The CEO unless you choose someone else.
  ownerOf(root) { return (root.ownerId && this.agents[root.ownerId]) || (this.orgDone ? this._ceo() : null); }
  projectsOwnedBy(agent) { return Object.values(this.agents).filter((r) => !r.parentId && r.kind !== 'general' && r.id !== agent.id && this.ownerOf(r)?.id === agent.id); }
  setOwner(rootId, agentId) {
    const root = this.agents[rootId];
    if (!root || root.parentId || root.kind === 'general') throw httpErr(404, 'No such project');
    const who = this.agents[agentId];
    if (!who || !this.assignable().some((a) => a.id === agentId) || who.id === root.id) throw httpErr(400, 'Choose an agent from the list');
    if (this.ownerOf(root)?.id === who.id && root.ownerId) return root;
    root.ownerId = who.id;
    this._msg(root, { role: 'system', text: `${who.name} is now responsible for this project` });
    this.emit('event', { type: 'agent', agent: root }); this.store.save();
    return root;
  }
  _ownerNote(agent) {
    const owned = this.projectsOwnedBy(agent);
    return owned.length ? `\nYou lead these projects: ${owned.map((r) => r.name).join(', ')}. When a message arrives in a project you work in its folder. You can also tell someone else about a project with an apiary-send block.\n` : '';
  }
  setStage(rootId, stage, note = '', by = 'you') {
    const root = this.agents[rootId];
    if (!root || root.parentId) throw httpErr(404, 'No such project');
    if (root.kind === 'general') throw httpErr(400, 'The main chat has no stage');
    if (!STAGES[stage]) throw httpErr(400, 'Stage must be building, maintenance or closed');
    const was = this.stageOf(root);
    if (was === stage) return root;
    root.stage = stage; root.stageNote = String(note || '').slice(0, 300);
    (root.stageLog ||= []).push({ stage, from: was, at: Date.now(), by, note: root.stageNote });
    if (stage === 'closed') { this.stop(rootId); root.closedAt = Date.now(); }
    else delete root.closedAt;
    this._msg(root, { role: 'system', text: `Project moved to ${STAGES[stage].label}${by === 'you' ? '' : ' (' + by + ')'}${root.stageNote ? ': ' + root.stageNote : ''}. ${stage === 'closed' ? 'Everything is kept. Reopen it any time.' : ''}`.trim() });
    this.emit('event', { type: 'agent', agent: root }); this.store.save();
    return root;
  }
  _planDone(root) {
    const plan = root?.plan;
    if (plan && plan.phases.length && plan.phases.every((p) => p.status === 'done') && this.stageOf(root) === 'building') this.setStage(root.id, 'maintenance', 'All phases are done. From now on it is kept up to date: fixes, security updates and small changes.', 'automatic');
  }
  // ----- project plans: big projects are done in phases, and the human can see where they stand -----
  _planOwner(agent) { const r = this.rootOf(agent); return r.kind === 'general' ? null : r; }
  _planFix(plan) {
    // finished phases stay finished; exactly one unfinished phase is current
    for (const p of plan.phases) {
      const all = p.steps.length > 0 && p.steps.every((x) => x.done);
      if (all && p.status !== 'done') { p.status = 'done'; p.doneAt = Date.now(); }
      if (!all && p.status === 'done' && p.steps.length) { p.status = 'pending'; delete p.doneAt; }
    }
    if (!plan.phases.some((p) => p.status === 'active' || p.status === 'blocked')) { const next = plan.phases.find((p) => p.status !== 'done'); if (next) { next.status = 'active'; next.startedAt ||= Date.now(); } }
    plan.updatedAt = Date.now();
  }
  planStats(plan) {
    if (!plan) return null;
    const total = plan.phases.reduce((n, p) => n + p.steps.length, 0) || plan.phases.length, done = plan.phases.reduce((n, p) => n + (p.steps.length ? p.steps.filter((x) => x.done).length : p.status === 'done' ? 1 : 0), 0);
    const cur = plan.phases.find((p) => p.status === 'active' || p.status === 'blocked');
    return { total, done, pct: total ? Math.round((done / total) * 100) : 0, current: cur?.title || null, phasesDone: plan.phases.filter((p) => p.status === 'done').length, phases: plan.phases.length };
  }
  async _plan(agent, np, notes) {
    const root = this._planOwner(agent);
    if (!root) { notes.push('Plans belong to projects. For something big, suggest the human creates a project for it.'); return; }
    if (agent.id !== root.id) { notes.push('Only the project lead makes the plan. Tell the lead what you think the plan should include.'); return; }
    if (this._needsApproval(agent)) {
      this._setStatus(agent, 'waiting');
      this.emit('event', { type: 'activity', agentId: agent.id, text: 'Waiting for your approval of the plan' });
      const r = await this._ask(agent, { kind: 'plan', title: `${agent.name} proposes a plan with ${np.phases.length} phase${np.phases.length > 1 ? 's' : ''}`, detail: np.goal, phases: np.phases });
      if (r.decision === 'deny') { notes.push(`The human did not approve the plan${r.note ? ': ' + r.note : ''}. Change it and propose it again.`); return; }
      if (r.note) notes.push(`Human note on the plan: ${r.note}`);
    }
    const old = root.plan, now = Date.now();
    root.plan = { goal: np.goal, createdAt: old?.createdAt || now, updatedAt: now, phases: np.phases.map((p, i) => { const prev = old?.phases.find((o) => o.title.toLowerCase() === p.title.toLowerCase()); return { id: i + 1, title: p.title, goal: p.goal, status: prev?.status || 'pending', startedAt: prev?.startedAt, doneAt: prev?.doneAt, steps: p.steps.map((t) => ({ text: t, done: !!prev?.steps.find((x) => x.text.toLowerCase() === t.toLowerCase() && x.done) })) }; }) };
    this._planFix(root.plan); this._planDone(root);
    this._msg(root, { role: 'system', text: `Project plan ${old ? 'updated' : 'created'}: ${root.plan.phases.map((p) => p.title).join(' → ')}` });
    this.emit('event', { type: 'agent', agent: root }); this.store.save();
    notes.push('The plan is saved and the human can see it. Work phase by phase, and report progress with apiary-progress.');
  }
  _progress(agent, list, notes) {
    const root = this._planOwner(agent), plan = root?.plan;
    if (!plan) { notes.push('There is no plan yet, so progress was not recorded. Make a plan with apiary-plan first.'); return; }
    for (const x of list.slice(0, 20)) {
      const key = String(x.phase).trim().toLowerCase(), ph = /^\d+$/.test(key) ? plan.phases[Number(key) - 1] : plan.phases.find((p) => p.title.toLowerCase() === key);
      if (!ph) { notes.push(`There is no phase "${x.phase}" in the plan.`); continue; }
      const status = ['pending', 'active', 'done', 'blocked'].includes(x.status) ? x.status : (x.step != null ? 'done' : 'active');
      if (x.step != null) {
        const k = String(x.step).trim().toLowerCase(), st = /^\d+$/.test(k) ? ph.steps[Number(k) - 1] : ph.steps.find((t) => t.text.toLowerCase() === k);
        if (!st) { notes.push(`There is no step "${x.step}" in phase "${ph.title}".`); continue; }
        st.done = status === 'done';
        if (status === 'blocked') ph.status = 'blocked';
      } else if (status === 'done') { ph.steps.forEach((t) => (t.done = true)); ph.status = 'done'; ph.doneAt = Date.now(); }
      else { ph.status = status; if (status === 'active') ph.startedAt ||= Date.now(); }
      if (x.note) ph.note = x.note;
      if (status === 'blocked') ph.status = 'blocked'; else if (ph.status === 'blocked' && status !== 'blocked') ph.status = 'active';
    }
    this._planFix(plan); this._planDone(root);
    this.emit('event', { type: 'agent', agent: root }); this.store.save();
  }
  // The human can tick steps and set phases by hand; the plan is theirs too.
  editPlan(rootId, { phase, step, done, status, note } = {}) {
    const root = this.agents[rootId], plan = root?.plan;
    if (!plan) throw httpErr(404, 'This project has no plan yet');
    const ph = plan.phases[Number(phase) - 1];
    if (!ph) throw httpErr(400, 'No such phase');
    if (step != null) { const st = ph.steps[Number(step) - 1]; if (!st) throw httpErr(400, 'No such step'); st.done = !!done; }
    if (status !== undefined) { if (!['pending', 'active', 'done', 'blocked'].includes(status)) throw httpErr(400, 'Unknown status'); ph.status = status; if (status === 'done') { ph.steps.forEach((t) => (t.done = true)); ph.doneAt = Date.now(); } }
    if (note !== undefined) ph.note = String(note).slice(0, 300);
    this._planFix(plan); this._planDone(root);
    this.emit('event', { type: 'agent', agent: root }); this.store.save();
    return plan;
  }
  clearPlan(rootId) { const root = this.agents[rootId]; if (!root) throw httpErr(404, 'No such project'); delete root.plan; this.emit('event', { type: 'agent', agent: root }); this.store.save(); }
  askPlan(rootId, text = '') {
    const root = this.agents[rootId];
    if (!root || root.parentId) throw httpErr(404, 'No such project');
    if (root.kind === 'general') throw httpErr(400, 'Plans belong to projects');
    this.send(root.id, `Please make a phased plan for this project${text ? `: ${text}` : ''}. Propose it with apiary-plan (clear phases, concrete steps), then start on the first phase.`).catch(() => {});
    return { started: true };
  }
  _planContext(agent) {
    const root = this._planOwner(agent), plan = root?.plan;
    const stage = root && this.stageOf(root) === 'maintenance' ? '\nPROJECT STAGE: Maintenance. The project is built. Only do fixes, security updates and small changes. Do not start big new work without telling the human.\n' : '';
    if (!plan) return stage;
    const st = this.planStats(plan);
    return stage + `\nPROJECT PLAN (where the project stands: ${st.pct}% done${st.current ? `, now in "${st.current}"` : ''}):\n${plan.goal ? 'Goal: ' + plan.goal + '\n' : ''}` + plan.phases.map((p, i) => `${i + 1}. ${p.title} [${p.status}]${p.note ? ' (' + p.note + ')' : ''}${p.steps.length ? '\n' + p.steps.map((t, j) => `   ${j + 1}. [${t.done ? 'x' : ' '}] ${t.text}`).join('\n') : ''}`).join('\n') + '\nStay inside the current phase. When you finish a step, record it with apiary-progress.\n';
  }

  // What the AI providers themselves report about subscription usage (cached; refreshed hourly or on request).
  async refreshLimits(only = null, force = false) {
    const out = {};
    for (const p of this.available) {
      if (p.id === 'mock' || (only && p.id !== only) || !['claude', 'codex'].includes(p.id)) continue;
      if (p.method === 'api') { this.providerLimits.cache.set(p.id, { id: p.id, ok: false, reason: 'api-key', error: 'This uses a pay-per-use key, which has no subscription limit. Usage shown is counted by Apiary only.', windows: [], fetchedAt: Date.now() }); continue; }
      out[p.id] = await this.providerLimits.refresh(p.id, { force });
    }
    return out;
  }
  limitsView() {
    const now = Object.fromEntries(this.available.filter((p) => ['claude', 'codex'].includes(p.id)).map((p) => [p.id, this.providerLimits.cached(p.id)]));
    return { limits: Object.fromEntries(Object.entries(now).filter(([, v]) => v)), pending: Object.entries(now).filter(([, v]) => !v).map(([k]) => k) };
  }

  // ----- task board, tickets, model advice -----
  _modelList(provider) { return this.connections.known(provider); }
  adviseModel(agentId) {
    const a = this.agents[agentId];
    if (!a) throw httpErr(404, 'No such agent');
    const adv = suggestModel({ provider: a.provider, department: a.department || '', role: a.role, models: this._modelList(a.provider) });
    return { ...adv, current: a.model || '', differs: !!adv.model && adv.model !== (a.model || '') && a.provider !== 'mock', options: this._modelList(a.provider) };
  }
  setModel(agentId, model) {
    const a = this.agents[agentId];
    if (!a) throw httpErr(404, 'No such agent');
    a.model = String(model || '').trim().slice(0, 80); a.sessionId = null; // a different model starts a fresh conversation
    this.emit('event', { type: 'agent', agent: a }); this.store.save();
    return a;
  }
  _agentTasks(agent, list) {
    const project = this.rootOf(agent).id;
    for (const t of list.slice(0, 10)) {
      const status = TASK_STATUSES.includes(t.status) ? t.status : null;
      const same = this.tasks.list.find((x) => x.title.toLowerCase() === t.title.trim().toLowerCase() && (x.project === project || x.project == null));
      try {
        if (same) this.tasks.update(same.id, { ...(status ? { status } : {}), ...(t.notes ? { notes: t.notes } : {}) }, agent.name);
        else this.tasks.add({ title: t.title, notes: t.notes, status: status || 'todo', assignee: { id: agent.id, name: agent.name }, project, source: agent.name });
      } catch { /* ignore a bad task from an agent */ }
    }
  }
  // Every task has an agent. Without a choice it is the CEO, who can hand it to a specialist.
  _ceo() { return Object.values(this.agents).find((a) => a.kind === 'general'); }
  assignable() {
    const ok = (a) => a.kind === 'general' || (a.member && this.rootOf(a).kind === 'general');
    return Object.values(this.agents).filter(ok).map((a) => ({ id: a.id, label: this._agentLabel(a), ceo: a.kind === 'general' }))
      .sort((x, y) => Number(y.ceo) - Number(x.ceo) || x.label.localeCompare(y.label));
  }
  _assignee(id) {
    const a = (id && this.agents[id]) || this._ceo();
    return a ? { id: a.id, name: a.name } : null;
  }
  createTask(b = {}) {
    return this.tasks.add({ title: b.title, notes: b.notes, status: ['todo', 'backburner'].includes(b.status) ? b.status : 'todo', labels: b.labels, project: b.project || null, assignee: this._assignee(b.assignee) });
  }
  updateTask(id, b = {}) {
    const patch = { ...b };
    if (patch.assignee !== undefined) patch.assignee = this._assignee(patch.assignee);
    return this.tasks.update(id, patch);
  }
  // Hand the task to its agent now.
  startTask(id) {
    const t = this.tasks.get(id), who = (t.assignee && this.agents[t.assignee.id]) || this._ceo();
    if (!who) throw httpErr(409, 'There is no agent to do this yet. Set up your CEO first.');
    if (t.status === 'done') throw httpErr(409, 'This task is already done. Move it back to To do first.');
    if (t.status !== 'inprogress') this.tasks.update(id, { status: 'inprogress', assignee: { id: who.id, name: who.name } }, 'you');
    const prompt = `Task from the board: ${t.title}\n\n${t.notes || '(no more detail given)'}\n\nDo it, or hand it to the right teammate. Keep the task's status up to date with an apiary-task block.`;
    this.send(who.id, prompt).catch(() => {});
    return { started: true, agent: who.name };
  }
  tasksView() { return this.tasks.list.map((t) => ({ ...t, projectName: t.project ? this.agents[t.project]?.name || '' : '' })); }

  // A ticket goes to the chosen agent, or to the CEO (who can pass it to the right specialist).
  ticketHandler(t) {
    const given = t.assignee && this.agents[t.assignee];
    if (given) return given;
    return Object.values(this.agents).find((a) => a.kind === 'general');
  }
  async runTicket(id, extra = '') {
    const t = this.tickets.get(id);
    const agent = this.ticketHandler(t);
    if (!agent) throw httpErr(409, 'There is no agent to handle this yet. Set up your CEO first.');
    if (t.status === 'working') throw httpErr(409, 'An agent is already working on this ticket');
    this.tickets.setStatus(id, 'working');
    let task = this.tasks.byRef(`ticket:${id}`);
    if (!task) task = this.tasks.add({ title: `Ticket #${t.num}: ${t.title}`, notes: t.description, status: 'inprogress', assignee: { id: agent.id, name: agent.name }, source: 'ticket', ref: `ticket:${id}`, labels: ['ticket'] });
    else this.tasks.update(task.id, { status: 'inprogress' }, 'Apiary');
    const thread = t.comments.map((c) => `${c.who}: ${c.text}`).join('\n\n');
    const prompt = `Support ticket #${t.num} (priority ${t.priority}): ${t.title}\n\n${t.description || '(no more detail given)'}\n${thread ? `\nConversation so far:\n${thread}\n` : ''}${extra ? `\nNew message from the human:\n${extra}\n` : ''}\nWork on this now. Fix what you can yourself, or hand it to the right team member. Reply in plain, simple English. Begin your reply with RESOLVED: (what you did and what the human should check) or NEEDS HUMAN: (the one thing you need from the human).`;
    const done = this.send(agent.id, prompt, null).then((text) => {
      const resolved = /^\W*RESOLVED/i.test(text || '');
      this.tickets.comment(id, agent.name, String(text || '(no reply)').replace(/^\W*(RESOLVED|NEEDS HUMAN):?\s*/i, ''), resolved ? 'resolution' : 'question');
      this.tickets.setStatus(id, resolved ? 'resolved' : 'open');
      this.tasks.update(task.id, { status: resolved ? 'done' : 'blocked', reason: resolved ? '' : 'Waiting for your answer' }, agent.name);
    }).catch((e) => {
      this.tickets.comment(id, 'Apiary', `The agent could not finish: ${e.message}`, 'error');
      this.tickets.setStatus(id, 'open');
      this.tasks.update(task.id, { status: 'blocked', reason: e.message }, 'Apiary');
    });
    return { started: true, agent: agent.name, done };
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
    let prompt = from && from.id !== agent.parentId && from.id !== 'meeting' ? `Message from teammate ${from.name}:\n\n${userText}` : userText, final = '';
    try {
      for (let round = 0; round <= this.limits.maxRounds; round++) {
        const raw = await this._exec(agent, prompt);
        const mem = parseRemember(raw);
        if (this.memoryEnabled) for (const n of mem.notes) this.memory.add({ kind: 'note', text: this._redact(n.text), who: agent.name, agent: n.scope === 'agent' ? this._mkey(agent) : null, project: n.scope === 'project' ? this._pkey(agent) : null });
        const { clean, spawns, sends, assigns, hires, secrets, tasks, plans, progress, infra, runbooks, errors } = parseSpawns(mem.clean);
        final = clean || final;
        if (clean) this._msg(agent, { role: 'agent', text: clean });
        if (tasks.length) this._agentTasks(agent, tasks);
        if (infra.length) this._infra(agent, infra);
        for (const rb of runbooks) { try { const r = this.runbooks.propose(agent.name, this._pname(agent), rb); this._msg(agent, { role: 'system', text: `Saved the runbook "${r.title}" as a draft for you to review (Runbooks page).` }); } catch (e) { this._msg(agent, { role: 'system', text: `Runbook not saved: ${e.message}`, error: true }); } }
        const planNotes = [];
        if (plans.length) await this._plan(agent, plans.at(-1), planNotes);
        if (progress.length) this._progress(agent, progress, planNotes);
        if ((!spawns.length && !sends.length && !assigns.length && !hires.length && !secrets.length && !errors.length && !plans.length) || round === this.limits.maxRounds) break;

        const notes = [...errors, ...planNotes];
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
        if (hires.length) await this._hire(agent, hires, notes);
        if (secrets.length) await this._secrets(agent, secrets, notes);
        if (agent.git) await this._commit(agent, 'work before delegating');
        this._setStatus(agent, 'waiting');

        // Messages to teammates run alongside the sub-agents.
        const jobs = runnable.map((s) => this._runChild(agent, s).then((r) => ({ kind: 'report', ...r })));
        for (const m of sends) {
          const job = await this._peerJob(agent, m, notes);
          if (job) jobs.push(job);
        }
        for (const a of assigns) {
          const job = this._assignJob(agent, a, notes);
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
      this._clearLease(agent.id);   // a secret lasts for one task only
      await this._commit(agent, userText);
      this._record(agent, userText, from, final);
      this._setStatus(agent, 'idle');
      return final;
    } catch (e) {
      this._clearLease(agent.id);
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

  // ----- @mentions: the person tags an agent in a chat to call it -----
  // Who can be tagged from this chat: its own team, the CEO and the lead of every open project.
  mentionables(agentId) {
    const me = this.agents[agentId];
    if (!me) throw httpErr(404, 'No such agent');
    const root = this.rootOf(me), out = new Map();
    const add = (a) => { if (a && a.id !== me.id && !out.has(a.id)) out.set(a.id, { id: a.id, name: a.name, title: a.title || (a.kind === 'general' ? 'CEO' : a.role || '') }); };
    for (const id of this.tree(root.id)) add(this.agents[id]);
    for (const a of Object.values(this.agents)) if (!a.parentId && (a.kind === 'general' || this.stageOf(a) !== 'closed')) add(a);
    if (root.kind !== 'general') for (const a of Object.values(this.agents)) if (a.kind === 'general') add(a);
    return [...out.values()].filter((c) => { const r = this.rootOf(this.agents[c.id]); return r.kind === 'general' || this.stageOf(r) !== 'closed' || r.id === root.id; });
  }

  // Finds "@Name" (names may have spaces, so the longest match wins). Titles work too (@CTO).
  findMentions(text, cands) {
    const found = [], problems = [], re = /(^|[\s(,;:])@/g;
    const keys = cands.flatMap((c) => [[c.name, c], ...(c.title ? [[c.title, c]] : [])]).filter(([k]) => k).sort((a, b) => b[0].length - a[0].length);
    let m, clean = '', rest = '', last = 0;
    while ((m = re.exec(text))) {
      const start = m.index + m[1].length + 1, low = text.slice(start).toLowerCase();
      const hit = keys.find(([k]) => low.startsWith(k.toLowerCase()) && !/[\w]/.test(text[start + k.length] || ' '));
      if (!hit) continue;
      const same = cands.filter((c) => c.name.toLowerCase() === hit[0].toLowerCase() || (c.title || '').toLowerCase() === hit[0].toLowerCase());
      if (same.length > 1) { problems.push(`More than one agent is called "${hit[0]}". Use a more specific name.`); continue; }
      if (!found.some((f) => f.id === hit[1].id)) found.push(hit[1]);
      const gap = text.slice(last, m.index + m[1].length); clean += gap + hit[0]; rest += gap; last = start + hit[0].length;
    }
    return { found, problems, clean: clean + text.slice(last), rest: rest + text.slice(last) };
  }

  // The person's message in a chat. With no @tag it goes to this chat's agent as usual.
  // With tags, the tagged agents get it (in their own chats) and each answer is also shown here.
  tag(agentId, text) {
    const me = this.agents[agentId];
    if (!me) throw httpErr(404, 'No such agent');
    const { found, problems, clean, rest } = this.findMentions(String(text), this.mentionables(agentId));
    if (problems.length) throw httpErr(400, problems[0]);
    if (!found.length) { this.send(agentId, text).catch(() => {}); return { tagged: [] }; }
    if (!rest.replace(/[\s,;:.!?-]/g, '')) throw httpErr(400, `Say what ${found.map((f) => f.name).join(' and ')} should do, for example "@${found[0].name} please look at this".`);
    for (const t of found) {
      const peer = this.agents[t.id], rt = this.rootOf(peer);
      if (rt.kind !== 'general' && this.stageOf(rt) === 'closed') throw httpErr(409, `${peer.name}'s project is closed. Reopen it (Projects page) first.`);
    }
    this._msg(me, { role: 'user', text: String(text) });
    const also = found.length > 1 ? `\n\n(The same message was sent to: ${found.map((f) => f.name).join(', ')}.)` : '';
    for (const t of found) {
      this._msg(me, { role: 'system', text: `Sent to ${t.name}`, agentId: t.id });
      this.send(t.id, clean + also).then(
        (reply) => this._msg(me, { role: 'agent', text: reply || '(no reply)', by: { id: t.id, name: t.name } }),
        (e) => this._msg(me, { role: 'system', text: `${t.name} could not finish: ${e.message}`, error: true }),
      );
    }
    return { tagged: found.map((f) => f.name) };
  }

  // ----- agent-to-agent messages -----
  async _findPeer(agent, to) {
    const root = this.rootOf(agent);
    const t = String(to || '').trim().toLowerCase();
    for (let tries = 0; tries < 10; tries++) {   // a just-spawned teammate may not exist yet
      if (t === 'parent' && agent.parentId) return { peer: this.agents[agent.parentId] };
      if (t === 'lead') return { peer: root };
      const pool = [...new Set([...this.tree(root.id), ...this._roster(this._teamRoot(agent)).map((m) => m.id), ...this.projectsOwnedBy(agent).map((r) => r.id)])];
      const hits = pool.map((i) => this.agents[i]).filter((a) => a && a.id !== agent.id && (a.id === to || a.name.toLowerCase() === t || (a.title || '').toLowerCase() === t));
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
    const proj = this._isProject(this.rootOf(agent)) && this.rootOf(peer).id !== this.rootOf(agent).id ? this.rootOf(agent) : null;
    if (!m.wait) {
      this._onProject(peer.id, proj, () => this.send(peer.id, m.text, agent)).catch(() => {});
      notes.push(`Message delivered to ${peer.name} (no reply awaited).`);
      return null;
    }
    this._edge(agent.id, peer.id);
    return this._onProject(peer.id, proj, () => this.send(peer.id, m.text, agent)).then((text) => ({ kind: 'reply', name: peer.name, text: text || '(no reply)' }), (e) => ({ kind: 'reply', name: peer.name, text: `FAILED: ${e.message}` }))
      .finally(() => this.waitingOn.get(agent.id)?.delete(peer.id));
  }
  _edge(a, b) { (this.waitingOn.get(a) || this.waitingOn.set(a, new Set()).get(a)).add(b); }

  _findDef(name) {
    return Object.values(this.defs).find((d) => d.name.toLowerCase() === String(name).toLowerCase());
  }

  // Create an agent under `parent` (own checkout in git projects) without giving it work yet.
  async _makeChild(parent, spec) {
    const def = spec.agent ? this._findDef(spec.agent) : null;
    const wanted = spec.provider || def?.provider;
    const provider = this.available.some((p) => p.id === wanted) ? wanted : parent.provider;
    const method = this.resolveMethod(provider);
    const fields = {
      id: id8(), name: def?.name || spec.name, role: def?.role || spec.role, instructions: def?.instructions || spec.instructions || '',
      provider, method, model: def?.model || spec.model || (provider === parent.provider ? parent.model : this.defaultModel(provider)),
      cwd: parent.cwd, access: parent.access, parentId: parent.id, depth: parent.depth + 1,
    };
    if (spec.member) Object.assign(fields, { title: spec.title, member: true, consult: spec.consult !== false, memKey: spec.memKey, department: spec.department, profile: spec.profile, reportsTo: spec.reportsTo || parent.id, hiredAt: spec.hiredAt });
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
    return this._add(fields);
  }

  async _runChild(parent, spec) {
    const child = await this._makeChild(parent, spec);
    this._edge(parent.id, child.id);
    this._msg(parent, { role: 'system', text: `Created sub-agent ${child.name} (${child.provider})`, agentId: child.id });
    try {
      const text = await this.send(child.id, spec.task, parent);
      return { name: child.name, text: text || '(no output)', child };
    } catch (e) {
      return { name: child.name, text: `FAILED: ${e.message}`, child };
    } finally { this.waitingOn.get(parent.id)?.delete(child.id); }
  }

  // ----- team workflow: assign -> pre-check by the others -> prerequisites -> the job -----
  async _assignJob(lead, a, notes) {
    const roster = this._roster(this._teamRoot(lead));
    const projRoot = this._isProject(this.rootOf(lead)) ? this.rootOf(lead) : null;
    const want = String(a.to).trim().toLowerCase();
    const worker = roster.find((m) => m.id === a.to || m.name.toLowerCase() === want || (m.title || '').toLowerCase() === want);
    if (!worker) { notes.push(roster.length ? `No team member called "${a.to}". Your team: ${roster.map((m) => `${m.name} (${m.title || m.role})`).join(', ')}.` : 'You have no team members to assign work to.'); return null; }
    this._edge(lead.id, worker.id);
    this._msg(lead, { role: 'system', text: `Assigned to ${worker.name}: ${a.task.slice(0, 160)}${a.task.length > 160 ? '…' : ''}`, agentId: worker.id });
    const task = this.tasks.add({ title: clipText(a.task, 100), notes: a.task, status: 'inprogress', assignee: { id: worker.id, name: worker.name }, project: this.rootOf(lead).id, source: 'system', labels: [worker.department || 'team'] });
    const finish = (text) => {
      this.waitingOn.get(lead.id)?.delete(worker.id);
      const ok = !/^\W*(NOT STARTED|FAILED)/i.test(text || '');
      try { this.tasks.update(task.id, { status: ok ? 'done' : 'blocked', reason: ok ? '' : clipText(text, 160) }, 'Apiary'); } catch { /* task removed meanwhile */ }
      return { kind: 'report', name: worker.name, text };
    };
    try {
      // 1. The assignee checks with everyone else before it starts.
      const advisers = roster.filter((m) => m.id !== worker.id && m.consult !== false);
      const checks = await Promise.all(advisers.map((adv) => this._consult(worker, adv, a.task)));
      if (this.stopped.has(lead.id)) throw Object.assign(new Error('stopped'), { name: 'AbortError' });
      const summary = checks.map((c) => `- ${c.adviser.name} (${c.adviser.title || c.adviser.role}): ${c.verdict}${c.reason ? ' — ' + c.reason : ''}${c.prerequisites.length ? ` (prerequisites: ${c.prerequisites.join('; ')})` : ''}`);
      this._msg(lead, { role: 'system', text: `Pre-check for ${worker.name}'s task:\n${summary.join('\n') || '(no one to consult)'}` });
      const blockers = checks.filter((c) => c.verdict === 'BLOCK');
      if (blockers.length) return finish(`NOT STARTED. ${blockers.map((c) => `${c.adviser.name} blocked it: ${c.reason || 'no reason given'}`).join(' ')}\nNothing was changed. Pre-check results:\n${summary.join('\n')}\nDecide whether to change the plan or ask the human.`);

      // 2. Whatever the others need done first happens now, by them, and is brought into the lead's branch.
      const done = [];
      for (const c of checks.filter((x) => x.prerequisites.length)) {
        const adv = c.adviser;
        this._edge(worker.id, adv.id);
        this._msg(worker, { role: 'system', text: `Waiting for ${adv.name} to finish prerequisites first`, agentId: adv.id });
        let r;
        try { r = await this._onProject(adv.id, projRoot, () => this.send(adv.id, `Prerequisite for ${worker.name}'s task (do this now, before ${worker.name} starts):\n${c.prerequisites.map((p) => '- ' + p).join('\n')}\n\nThe task is:\n${a.task}\n\nWhen finished, begin your reply with DONE or FAILED.`, worker)); }
        catch (e) { r = `FAILED: ${e.message}`; }
        finally { this.waitingOn.get(worker.id)?.delete(adv.id); }
        if (!/^\W*DONE/i.test(r || '')) return finish(`NOT STARTED. ${adv.name} could not complete a prerequisite: ${clipText(r, 300)}\nNothing further was done. Pre-check results:\n${summary.join('\n')}`);
        const note = lead.git && adv.branch ? await this._mergeChild(lead, adv, true) : '';
        done.push(`- ${adv.name}: ${clipText(r.replace(/^\W*DONE:?\s*/i, ''), 300)}${note ? ' ' + note.trim() : ''}`);
      }

      // 3. The assignee does the job, with the prerequisites in its checkout.
      if (lead.git && worker.branch) await this._sync(lead, worker);
      const prompt = `Task from ${lead.name}:\n\n${a.task}\n\n` +
        (summary.length ? `Pre-check by your teammates (already done):\n${summary.join('\n')}\n\n` : '') +
        (done.length ? `Prerequisites already completed${lead.git ? ' and merged into your branch' : ''}:\n${done.join('\n')}\n\n` : '') +
        'Now carry out the task. Respect any conditions above.';
      const text = await this._onProject(worker.id, projRoot, () => this.send(worker.id, prompt, lead));
      let note = '';
      if (lead.git && worker.branch) { note = await this._mergeChild(lead, worker, true); await this._sync(lead, worker); }
      return finish(`${text || '(no output)'}${note}\n\nPre-check results:\n${summary.join('\n') || '(none)'}${done.length ? '\nPrerequisites done first:\n' + done.join('\n') : ''}`);
    } catch (e) {
      this.waitingOn.get(lead.id)?.delete(worker.id);
      if (e.name === 'AbortError') throw e;
      return finish(`FAILED: ${e.message}`);
    }
  }

  // The assignee asks one teammate for a verdict on the task. Unclear or missing replies are reported as such, never silently approved.
  async _consult(worker, adv, task) {
    const root = this.rootOf(worker).id;
    const res = { adviser: adv, verdict: 'NO ANSWER', reason: '', prerequisites: [] };
    if ((this.peerCounts.get(root) || 0) >= this.limits.maxPeerMessages) { res.reason = 'not consulted: the project reached its limit of agent-to-agent messages'; return res; }
    if (this._wouldDeadlock(worker.id, adv.id)) { res.reason = `not consulted: ${adv.name} is waiting on ${worker.name}`; return res; }
    this.peerCounts.set(root, (this.peerCounts.get(root) || 0) + 1);
    this._edge(worker.id, adv.id);
    this._msg(worker, { role: 'system', text: `Asked ${adv.name} for a pre-check`, agentId: adv.id });
    try {
      const text = await this.send(adv.id, `Pre-check requested by ${worker.name} before they start this task:\n\n${task}\n\nLook at it from your area (${adv.role || adv.name}). Do no work yet. Reply in this shape:\nVERDICT: GO | CONDITIONS | BLOCK\nREASON: one or two sentences\nPREREQUISITE: something that must be done first, before ${worker.name} starts (one line per item, only with CONDITIONS)`, worker);
      Object.assign(res, parseVerdict(text));
    } catch (e) { res.reason = `could not be consulted (${e.message})`; }
    finally { this.waitingOn.get(worker.id)?.delete(adv.id); }
    return res;
  }

  // Bring the lead's latest work into a member's checkout (best effort; a conflict is aborted and logged).
  async _sync(lead, member) {
    try {
      const r = await git.merge(member.cwd, lead.git.branch);
      if (!r.ok) this._log(member, `! could not bring in the lead's latest work (conflicts in ${r.conflicts.join(', ') || 'some files'})`);
    } catch (e) { this._log(member, `! sync failed: ${e.message}`); }
  }

  // Bring a child's branch into its parent's. A conflict is aborted and reported, never left half-done.
  async _mergeChild(parent, child, keep = false) {
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
    if (!keep) await this._lock(parent.git.repo, () => git.worktreeRemove(parent.git.repo, child.cwd)).catch(() => {});
    return note;
  }
}

export function parseSpawns(reply) {
  const spawns = [], sends = [], assigns = [], hires = [], secrets = [], tasks = [], plans = [], progress = [], infra = [], runbooks = [], errors = [];
  reply = reply.replace(PLAN_RE, (_, body) => {
    try {
      const o = JSON.parse(body.trim()), ph = [].concat(o.phases || []).filter((p) => p && String(p.title || '').trim());
      if (!ph.length) errors.push('An apiary-plan block needs "phases", each with a "title".');
      else plans.push({ goal: String(o.goal || '').slice(0, 400), phases: ph.slice(0, 12).map((p) => ({ title: String(p.title).trim().slice(0, 80), goal: String(p.goal || '').slice(0, 300), steps: [].concat(p.steps || []).map((x) => String(typeof x === 'string' ? x : x?.text || '').trim().slice(0, 160)).filter(Boolean).slice(0, 15) })) });
    } catch (err) { errors.push(`An apiary-plan block was not valid JSON (${err.message}).`); }
    return '';
  });
  reply = reply.replace(PROGRESS_RE, (_, body) => {
    try { for (const x of [].concat(JSON.parse(body.trim()))) { if (!x || x.phase == null) { errors.push('An apiary-progress block needs a "phase".'); continue; } progress.push({ phase: x.phase, step: x.step, status: x.status, note: String(x.note || '').slice(0, 300) }); } }
    catch (err) { errors.push(`An apiary-progress block was not valid JSON (${err.message}).`); }
    return '';
  });
  reply = reply.replace(RUNBOOK_RE, (_, body) => {
    try { for (const x of [].concat(JSON.parse(body.trim()))) runbooks.push(x); }
    catch (err) { errors.push(`An apiary-runbook block was not valid JSON (${err.message}).`); }
    return '';
  });
  reply = reply.replace(INFRA_RE, (_, body) => {
    try { const o = JSON.parse(body.trim()); for (const x of [].concat(Array.isArray(o) ? o : o.items || o)) infra.push(x); }
    catch (err) { errors.push(`An apiary-infra block was not valid JSON (${err.message}).`); }
    return '';
  });
  reply = reply.replace(TASK_RE, (_, body) => {
    try { for (const x of [].concat(JSON.parse(body.trim()))) { if (!x || !String(x.title || '').trim()) { errors.push('An apiary-task block needs a "title".'); continue; } tasks.push({ title: String(x.title), notes: String(x.notes || ''), status: x.status }); } }
    catch (err) { errors.push(`An apiary-task block was not valid JSON (${err.message}).`); }
    return '';
  });
  reply = reply.replace(SECRET_RE, (_, body) => {
    try { for (const x of [].concat(JSON.parse(body.trim()))) { if (!x || !String(x.name || '').trim()) { errors.push('An apiary-secret block needs a "name".'); continue; } secrets.push({ name: String(x.name), why: String(x.why || '').slice(0, 300) }); } }
    catch (err) { errors.push(`An apiary-secret block was not valid JSON (${err.message}).`); }
    return '';
  });
  reply = reply.replace(HIRE_RE, (_, body) => {
    try {
      for (const h of [].concat(JSON.parse(body.trim()))) {
        if (!h || !String(h.title || h.name || '').trim()) { errors.push('An apiary-hire block needs a "title".'); continue; }
        hires.push({ name: String(h.name || h.title), title: h.title, role: h.role, department: h.department, reason: h.reason, instructions: h.instructions, guardrails: h.guardrails, provider: h.provider, reportsTo: h.reportsTo, complexity: h.complexity });
      }
    } catch (err) { errors.push(`An apiary-hire block was not valid JSON (${err.message}).`); }
    return '';
  });
  reply = reply.replace(ASSIGN_RE, (_, body) => {
    try {
      for (const s of [].concat(JSON.parse(body.trim()))) {
        if (!s || !s.to || typeof s.task !== 'string' || !s.task.trim()) { errors.push('An apiary-assign block needs "to" and "task".'); continue; }
        assigns.push({ to: String(s.to), task: s.task });
      }
    } catch (err) { errors.push(`An apiary-assign block was not valid JSON (${err.message}).`); }
    return '';
  });
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
  return { clean, spawns, sends, assigns, hires, secrets, tasks, plans, progress, infra, runbooks, errors };
}

const clipText = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// Reads the VERDICT / REASON / PREREQUISITE lines of a pre-check reply.
export function parseVerdict(text) {
  const t = String(text || '');
  const v = /^\W*VERDICT\W*(GO|CONDITIONS?|BLOCK)\b/im.exec(t);
  const reason = /^\W*REASON\W*(.+)$/im.exec(t)?.[1]?.trim() || '';
  const prerequisites = [...t.matchAll(/^\W*PREREQUISITES?\W*(.+)$/gim)].map((m) => m[1].trim()).filter(Boolean);
  if (!v) return { verdict: 'UNCLEAR', reason: clipText(t, 200) || 'no reply', prerequisites: [] };
  let verdict = v[1].toUpperCase().replace('CONDITIONS', 'CONDITIONS');
  if (verdict === 'CONDITION') verdict = 'CONDITIONS';
  if (verdict === 'CONDITIONS' && !prerequisites.length) verdict = 'GO';
  return { verdict, reason, prerequisites: verdict === 'GO' ? [] : prerequisites };
}

export function httpErr(status, message) { return Object.assign(new Error(message), { status }); }

// Used when the AI cannot be reached or answers unusably: fixed questions and a team picked by keywords.
const FALLBACK_QS = [
  ['What do you mainly want help with?', ['My home network and servers', 'Websites and content', 'Software projects', 'Research and planning']],
  ['What does your infrastructure look like (network, servers, hosting)?', ['Home lab / self-hosted', 'Cloud servers', 'Mostly laptops and cloud apps', 'Not much yet']],
  ['Which tools and services do you already use?', ['Proxmox or Docker', 'WordPress', 'GitHub', 'Home automation']],
  ['How much may the agents change without asking you?', ['Nothing: always ask', 'Small, reversible things', 'Most things, tell me after']],
  ['How would you like to be kept informed?', ['A daily summary', 'Only when something needs me', 'Everything as it happens']],
];
export function fallbackInterview(answers, force = false) {
  if (!force && answers.length < FALLBACK_QS.length) return { question: FALLBACK_QS[answers.length][0], choices: FALLBACK_QS[answers.length][1] };
  const text = answers.map((a) => a.a).join(' ').toLowerCase();
  const team = [];
  const add = (title, department, role, reason) => team.push({ title, department, role, reason, instructions: '' });
  if (/network|server|proxmox|docker|home ?lab|infra|hosting|vpn|firewall|dns/.test(text)) { add('Network Engineer', 'networking', 'Looks after the network, DNS, VPN and reverse proxies', 'You run your own network and servers'); add('Security Engineer', 'security', 'Reviews every change for risk before it happens', 'Infrastructure changes need a second pair of eyes'); }
  if (/website|wordpress|content|blog|marketing/.test(text)) { add('Web Developer', 'engineering', 'Builds and maintains websites', 'You maintain websites'); add('Content Writer', 'marketing', 'Writes and edits content', 'Your sites need regular content'); }
  if (/software|code|github|app|programming/.test(text)) add('Software Engineer', 'engineering', 'Writes, tests and reviews code', 'You work on software');
  if (!team.length || /research|plan/.test(text)) add('Researcher', 'research', 'Finds facts and compares options', 'Good decisions need good information');
  const overview = answers.map((a) => `**${a.q}** ${a.a}`).join('\n\n');
  return { done: true, overview, team: team.slice(0, 6) };
}
