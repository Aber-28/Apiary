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
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdirSync, realpathSync, existsSync, statSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { providers, which } from './providers.js';
import { HOME } from './store.js';
import { Images, KEEP_CHOICES, DEFAULT_DAYS } from './images.js';
import { Handover } from './handover.js';
import { judge, modelForTier, tierOfModel, WINDOW, COOL_MS, DECLINED_MS } from './modelwatch.js';
import { Connections } from './connections.js';
import { git } from './git.js';
import { github, validateSource } from './github.js';
import { Memory, parseRemember } from './memory.js';
import { buildProfile, DEPARTMENTS, pickName, inferDepartment } from './roles.js';
import { Infra } from './infra.js';
import { probe as discoveryProbe, sshRun, explainSsh } from './discovery.js';
import { byId as libraryEntry, view as libraryView, iconFor } from './library.js';
import { UP_MS, gatherFacts, basicAdvice, parseFix, stripFix, isSafeFix, triedFromFacts, parseReport, SYSTEM as TROUBLE_SYSTEM } from './troubleshoot.js';
import { verifyCloudflare, verifyGoogle, verifyApi, apiInfo, parseGoogleKey } from './cloud.js';
import { Audit } from './audit.js';
import { Health, LOGIN_RE } from './health.js';
import { Telegram } from './telegram.js';
import { Templates } from './templates.js';
import { Reports } from './report.js';
import { Runbooks } from './runbooks.js';
import { Policy } from './policy.js';
import { parseCommand, isDangerous, levelAllows, TRUST_LEVELS } from './command-rules.js';
import { Backups } from './backup.js';
import { Vault, envName, redactPairs, typeOf } from './vault.js';
import * as orgfiles from './orgfiles.js';
import { Usage, estimateTokens, looksLikeLimit } from './usage.js';
import { Tasks, STATUS_LABELS, STATUSES as TASK_STATUSES } from './tasks.js';
import { Tickets } from './tickets.js';
import os from 'node:os';
import { Repos } from './repos.js';
import { suggestModel } from './models.js';
import { Limits } from './limits.js';
import { GhLogin } from './ghlogin.js';
import { AiLogin } from './aiLogin.js';
import { ToolInstaller } from './tools.js';

const ENV_LIMITS = {
  maxDepth: Number(process.env.APIARY_MAX_DEPTH || 2),     // lead = depth 0
  maxAgents: Number(process.env.APIARY_MAX_AGENTS || 12),  // per whole tree
  maxRounds: Number(process.env.APIARY_MAX_ROUNDS || 4),   // delegate/report cycles per turn
  maxPeerMessages: Number(process.env.APIARY_MAX_PEER_MESSAGES || 30), // agent-to-agent messages per project
  maxRetries: Number(process.env.APIARY_MAX_RETRIES || 2),  // retries of a stuck or briefly failing run
};
const PROVIDER_LABEL = { claude: 'Claude', codex: 'Codex', mock: 'The test agent' };
const abortError = () => Object.assign(new Error('stopped'), { name: 'AbortError' });
const LIMIT_RANGE = { maxDepth: [0, 4], maxAgents: [1, 40], maxRounds: [0, 10], maxPeerMessages: [0, 200], maxRetries: [0, 5] };
const SPAWN_RE = /```apiary-spawn\s*([\s\S]*?)```/g;
const SEND_RE = /```apiary-send\s*([\s\S]*?)```/g;
const HIRE_RE = /```apiary-hire\s*([\s\S]*?)```/g;
const TYPE_LABEL = { login: 'login', ssh: 'SSH login', token: 'API key or token' };
const SECRET_RE = /```apiary-secret\s*([\s\S]*?)```/g;
const NEWSECRET_RE = /```apiary-newsecret\s*([\s\S]*?)```/g;
const PLAN_RE = /```apiary-plan\s*([\s\S]*?)```/g;
const PROGRESS_RE = /```apiary-progress\s*([\s\S]*?)```/g;
const INFRA_RE = /```apiary-infra\s*([\s\S]*?)```/g;
const RUNBOOK_RE = /```apiary-runbook\s*([\s\S]*?)```/g;
const TASK_RE = /```apiary-task\s*([\s\S]*?)```/g;
const ASSIGN_RE = /```apiary-assign\s*([\s\S]*?)```/g;
// Shortens a name to a maximum length, at a word boundary where possible. Reports whether it changed.
function fitName(raw, max) {
  const s = String(raw || '').trim();
  if (s.length <= max) return { name: s, cut: false };
  let cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  if (sp > 10) cut = cut.slice(0, sp);
  return { name: cut.trim(), cut: true };
}
const MAX_LOG = 1000;
const id8 = () => randomUUID().slice(0, 8);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'agent';
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export const STAGES = { building: { label: 'Building', hint: 'Being made for the first time' }, maintenance: { label: 'Maintenance', hint: 'Finished. Fixes, security updates and small changes' }, closed: { label: 'Closed', hint: 'Finished for good. Kept, but not worked on' } };
const plabel = (id) => PROVIDER_LABEL[id] || id;
export class Engine extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.connections = new Connections(store);
    this.handover = new Handover(path.join(HOME, 'handover')); this.handover.prune(); setInterval(() => this.handover.prune(), 6 * 3600e3).unref?.();
    this.images = new Images(path.join(HOME, 'images')); this.pruneImages(); setInterval(() => this.pruneImages(), 6 * 3600e3).unref?.();
    this.ctls = new Map();     // agentId -> AbortController of the running provider call
    this.chains = new Map();   // agentId -> promise chain (one turn at a time per agent)
    this.stopped = new Set();  // agents asked to stop mid-delegation
    this.locks = new Map();    // repo dir -> promise chain (git worktree operations are serialised)
    this.pending = new Map();  // approvalId -> { resolve, reject }
    this.approvalRuns = new Map(); // one-time token -> { agent, signal } for each safe-mode run's approval bridge
    this.baseUrl = '';         // where this Apiary is reachable on this machine (set by the server when it starts)
    this.waitingOn = new Map();// agentId -> Set of agentIds it is waiting for (deadlock check)
    this.peerLog = new Map();   // project id -> times of agent-to-agent messages (only the last hour counts)
    this.replyTurns = new Set(); // agents whose current turn was started by a teammate's reply (they cannot start new replies)
    this.memory = new Memory(path.join(path.dirname(store.file), 'memory.json'));
    this.backups = new Backups(this);
    this.infra = new Infra(path.join(path.dirname(store.file), 'infra.json'));
    this.discovering = new Set();
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
    this.ghLogin = new GhLogin({ onChange: (st) => { if (st.state === 'done') this.connections._cache.clear(); this.emit('event', { type: 'github-login' }); } });
    this.aiLogin = new AiLogin({ onChange: (st) => { if (st.state === 'done') this.connections._cache.clear(); this.emit('event', { type: 'ai-login', provider: st.provider }); } });
    this.tasks = new Tasks(store);
    this.tasks.backfill();
    this.curTask = new Map();   // agent id -> the task it is working on right now
    this.tickets = new Tickets(store);
    this.repos = new Repos(store, () => this.connections.get('github'), path.join(path.dirname(store.file), 'repos'));
    this.userLeases = new Map(); // agentId -> Map(secret name -> username), same lifetime as leases
    this.projectFor = new Map(); // agentId -> project id, while a specialist is working on a project from another folder
    this.metaLeases = new Map(); // agentId -> { ENV_NAME: value } for the non-secret details of a lease (host, port, how to log in)
    this.leases = new Map();   // agentId -> Map(secret name -> value), only for the turn that was approved
    for (const a of Object.values(store.data.agents)) if (a.status !== 'idle') a.status = 'idle'; // interrupted by a restart
    for (const a of Object.values(store.data.agents)) if (!a.parentId && a.role === 'Lead agent') a.role = `Leads the ${a.name} project`; // older projects get the clearer wording
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

  // Finished team work is checked by another teammate before it counts as done. On by default.
  get reviewWork() { return this.store.data.settings.reviewWork !== false; }
  setReviewWork(v) { this.store.data.settings.reviewWork = !!v; this.store.save(); return this.reviewWork; }
  get approvalsDefault() { return this.store.data.settings.approvalsDefault !== false; }
  setApprovalsDefault(v) { this.store.data.settings.approvalsDefault = !!v; this.store.save(); return this.approvalsDefault; }

  // ---------- approvals ----------
  // Decisions stay in view for 3 hours, then count as archived.
  // Every approval gets a short ID (AP-0001), counted up and never reused. Older ones are numbered oldest first.
  _approvalNo(rec) { if (!rec.num) { const n = (this.store.data.approvalSeq = (this.store.data.approvalSeq || 0) + 1); rec.num = n; } return rec; }
  _stampApprovals() { for (const r of Object.values(this.store.data.approvals).filter((x) => !x.num).sort((a, b) => a.createdAt - b.createdAt)) this._approvalNo(r); }
  approvals() {
    this._stampApprovals();
    const cut = Date.now() - 3600000;
    return Object.values(this.store.data.approvals).sort((a, b) => b.createdAt - a.createdAt).map((r) => ({ ...r, archived: r.status !== 'pending' && (r.decidedAt || r.createdAt) < cut }));
  }
  _needsApproval(agent) { return this.rootOf(agent).approvals !== false; }
  _ask(agent, fields, ctx = {}) {
    const id = id8();
    const rec = this._approvalNo({ id, agentId: agent.id, agentName: agent.name, projectId: this.rootOf(agent).id, status: 'pending', createdAt: Date.now(), ...fields });
    const rule = this.policy.match({ kind: fields.kind, title: fields.title, secret: fields.secret, project: rec.projectId, agent: agent.id, command: ctx.command });
    if (rule) {   // one of your rules decides, so nobody is asked
      const allow = rule.action === 'allow';
      Object.assign(rec, { status: allow ? 'approved' : 'denied', decidedAt: Date.now(), auto: true, rule: rule.id, note: allow ? `Allowed automatically by your rule. ${this.policy.describe(rule)}` : `Blocked by your rule. ${this.policy.describe(rule)}`, ...(allow && fields.kind === 'secret' ? { mode: 'once' } : {}) });
      this.store.data.approvals[id] = rec;
      this.audit.add('approval', { actor: 'Rule', project: this._pname(agent), action: `${rec.status} automatically: ${rec.title}`, detail: this.policy.describe(rule) });
      this.emit('event', { type: 'approval', approval: rec });
      this._log(agent, `${allow ? '✔' : '!'} ${allow ? 'allowed' : 'blocked'} by your rule: ${rec.title}`);
      this._msg(agent, { role: 'system', text: `${allow ? 'Allowed' : 'Blocked'} automatically by your rule: ${rec.title}` });
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
  decide(id, { decision, note, only, names, mode, models, secret, phases } = {}) {
    const rec = this.store.data.approvals[id];
    if (!rec) throw httpErr(404, 'No such approval');
    if (rec.status !== 'pending' || !this.pending.has(id)) throw httpErr(409, 'This request was already answered or has expired');
    if (!['approve', 'deny'].includes(decision)) throw httpErr(400, 'decision must be approve or deny');
    let editedPhases = null;   // you may edit a plan while approving it; checked before anything changes
    if (decision === 'approve' && rec.kind === 'plan' && Array.isArray(phases)) { editedPhases = cleanPhases(phases); if (!editedPhases.length) throw httpErr(400, 'The plan needs at least one phase with a title'); }
    if (only !== undefined && (!Array.isArray(only) || only.some((i) => !Number.isInteger(i) || i < 0 || i >= (rec.items?.length || 0)))) throw httpErr(400, 'Bad selection');
    if (decision === 'approve' && rec.kind === 'newsecret') {
      // Saved first: if this fails the request stays pending. The value is not kept on the request or in the chat.
      const sv = secret && typeof secret === 'object' ? secret : {};
      const name = String(sv.name || rec.secretName || '').trim().slice(0, 80);
      const type = ['login', 'token', 'ssh'].includes(sv.type) ? sv.type : (rec.secretType || 'login');
      const meta = type === 'ssh' ? { type, host: String(sv.host || rec.host || ''), port: sv.port, auth: sv.auth === 'key' ? 'key' : 'password' } : { type };
      this.vault.add(name, String(sv.value || ''), `Saved for ${rec.agentName || 'an agent'}`, type === 'token' ? '' : String(sv.username || rec.username || ''), meta);
      rec.secretName = name;
      note = `Saved to the vault as "${name}".`;
    }
    rec.status = decision === 'approve' ? 'approved' : 'denied';
    rec.note = String(note || '').slice(0, 1000);
    if (decision === 'approve' && only) rec.only = only;
    if (decision === 'approve' && rec.kind === 'secret') rec.mode = mode === 'always' ? 'always' : 'once';
    if (decision === 'approve' && rec.kind === 'command') rec.mode = ['exact', 'program', 'readonly', 'agent'].includes(mode) ? mode : 'once';
    if (decision === 'approve' && rec.kind === 'hire' && names && typeof names === 'object') {
      rec.names = {};
      for (const [i, n] of Object.entries(names)) { const t = String(n || '').trim().slice(0, 40); if (t && rec.items?.[Number(i)]) rec.names[Number(i)] = t; }
    }
    if (decision === 'approve' && rec.kind === 'hire' && models && typeof models === 'object') {
      rec.models = {};
      for (const [i, m] of Object.entries(models)) if (rec.items?.[Number(i)]) rec.models[Number(i)] = String(m || '').trim().slice(0, 80);
    }
    if (editedPhases) { rec.edited = JSON.stringify(editedPhases) !== JSON.stringify(cleanPhases(rec.phases)); rec.phases = editedPhases; }
    rec.decidedAt = Date.now();
    const p = this.pending.get(id); this.pending.delete(id);
    this.audit.add('approval', { actor: 'You', project: this.agents[rec.agentId] ? this._pname(this.agents[rec.agentId]) : '', action: `${rec.status}: ${rec.title}`, detail: `${rec.agentName || ''}${rec.mode === 'always' ? ' (always)' : ''}`.trim() });
    this.emit('event', { type: 'approval', approval: rec });
    this.store.save();
    if (decision === 'deny' && ['plan', 'merge', 'spawn', 'hire'].includes(rec.kind) && this.agents[rec.agentId]) this.noteRun(this.agents[rec.agentId], false);
    p.resolve({ decision, note: rec.note, only: rec.only, names: rec.names, mode: rec.mode, models: rec.models, phases: rec.kind === 'plan' ? rec.phases : undefined, edited: rec.edited });
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
  get modelAutoOn() { return this.store.data.settings.modelAuto === true; }
  get handoverOn() { return this.store.data.settings.handover !== false; }
  get plainEnglish() { return this.store.data.settings.plainEnglish !== false; }
  setSettings({ defaultProvider, onboardingDone, autoUpdate, updateCheck, meeting, plainEnglish, usageLimits, handover, modelAuto, modelAutoAck }) {
    if (modelAuto !== undefined) {
      if (modelAuto && modelAutoAck !== true) throw httpErr(400, 'Please confirm that you understand Apiary may change models without asking, which can use more or fewer tokens');
      this.store.data.settings.modelAuto = !!modelAuto; this.audit.add('settings', { actor: 'You', action: `automatic model changes ${modelAuto ? 'turned on' : 'turned off'}`, detail: '' }); this.store.save();
    }
    if (handover !== undefined) { this.store.data.settings.handover = !!handover; this.store.save(); }
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
  // How long attached pictures stay on this machine (days; 0 = never delete). Checked at start and every few hours.
  get imageKeepDays() { const v = this.store.data.settings.imageKeepDays; return KEEP_CHOICES.includes(v) ? v : DEFAULT_DAYS; }
  setImageKeepDays(v) { v = Number(v); if (!KEEP_CHOICES.includes(v)) throw httpErr(400, `Choose ${KEEP_CHOICES.filter(Boolean).join(', ')} days or never delete`); this.store.data.settings.imageKeepDays = v; this.store.save(); this.pruneImages(); return v; }
  pruneImages() { try { return this.images.prune(this.imageKeepDays); } catch { return 0; } }
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
    // Names being handed out right now count as taken too: two hires at the same moment must not pick the same codename.
    const claimed = (this._claimedNames ||= new Map()); if (!claimed.has(root.id)) claimed.set(root.id, new Set());
    const mine = claimed.get(root.id);
    const taken = new Set([root.name, ...roster.map((m) => m.name), ...this.tree(root.id).map((id) => this.agents[id]?.name), ...mine].filter(Boolean).map((n) => n.toLowerCase()));   // everyone in this team: a name must point to one person
    const title = String(spec.title || spec.name || 'Specialist').trim().slice(0, 60);
    const dept = DEPARTMENTS[spec.department] ? spec.department : inferDepartment(title, spec.role);
    let name = String(spec.name || '').trim().slice(0, 40) || pickName(dept, taken);
    if (taken.has(name.toLowerCase())) { let i = 2; while (taken.has(`${name} ${i}`.toLowerCase())) i++; name = `${name} ${i}`; }
    mine.add(name);
    try {
    const profile = buildProfile({ name, title, role: spec.role, department: dept, reason: spec.reason, instructions: spec.instructions, guardrails: spec.guardrails });
    const boss = this.agents[spec.reportsTo] || root;
    const child = await this._makeChild(root, { name, title, role: profile.role, instructions: profile.instructions, provider: spec.provider || root.provider, model: spec.model, member: true, consult: spec.consult !== false, memKey: slug(title), department: profile.department, profile, reportsTo: boss.id, hiredAt: Date.now() });
    child.mdFile = orgfiles.writeAgent(this._scope(root), child.memKey, { name, title, department: profile.departmentLabel, reportsTo: boss.name, reason: spec.reason, instructions: profile.instructions, hired: child.hiredAt });
    this.store.save();
    return child;
    } finally { mine.delete(name); }
  }

  // A proposal is turned into complete profiles (instructions + guardrails), shown for approval, then the agents join the team.
  // Discovery: read what a host runs (VMs, containers) over SSH and offer each new find as an "Is this right?" card.
  // Read-only on the host. The person pressing the button is the approval; the login comes from the vault.
  // ---------- the Library ----------
  icon(id) { return iconFor(path.join(path.dirname(this.store.file), 'icons'), id, this.iconFetch || fetch); }
  library() { return { entries: libraryView(), vault: { exists: this.vault.exists, unlocked: this.vault.unlocked } }; }
  // Makes the login in the vault and the device on the map, already linked. The password is never kept on the map.
  addFromLibrary(libId, b = {}) {
    const bad = (status, message) => Object.assign(new Error(message), { status });
    const e = libraryEntry(libId); if (!e) throw bad(404, 'No such library entry');
    const m = e.methods.find((x) => x.id === b.method) || e.methods[0];
    const name = String(b.name || e.name).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60);
    if (!name) throw bad(400, 'Give it a name');
    const address = e.fixed ? e.fixed.address : String(b.address || '').trim();
    if (!address) throw bad(400, e.id === 'website' ? 'Enter the web address' : 'Enter its address (a name or IP like 10.0.0.5)');
    if (this.infra.byName(name)) throw bad(409, `You already have "${name}"`);
    const port = b.port === undefined || b.port === '' ? m.port : Number(b.port);
    let url = '', host = address;
    if (e.id === 'website') { if (!/^https?:\/\/[^\s]+$/i.test(address)) throw bad(400, 'The web address must start with http:// or https://'); url = address; host = ''; }
    else if (e.fixed) { url = e.fixed.url; host = ''; }
    else if (e.web && m.id !== 'ssh') url = `${e.web.scheme}://${address}:${port || e.web.port}`;
    let secret = '';
    if (m.secret) {
      const value = String(b.secret || ''); if (!value) throw bad(400, m.secret === 'ssh' && b.auth === 'key' ? 'Paste the private key' : `Enter the ${m.secret === 'token' ? 'token' : 'password'}`);
      let user = String(b.username || m.user || '').trim();
      if (e.id === 'google') { const gk = parseGoogleKey(value); if (!gk) throw bad(400, 'That is not a Google service-account key. Paste the whole JSON file from the Google Cloud console.'); user = gk.client_email; }
      if (m.secret !== 'token' && !user) throw bad(400, 'Enter the username');
      let n = `${name} login`, k = 2; while (this.vault.byName(n)) n = `${name} login ${k++}`;
      this.vault.add(n, value, `Made from the Library (${e.name})`, user, m.secret === 'ssh' ? { type: 'ssh', host, port: port || 22, auth: b.auth === 'key' ? 'key' : 'password' } : { type: m.secret });
      secret = n;
    }
    const it = this.infra.add({ name, type: e.type, address: host, port: Number.isInteger(port) ? port : 0, url, secret, lib: e.id, via: m.id, notes: `${e.name}, connected with ${m.label.toLowerCase()}.` });
    this.audit.add('infra', { actor: 'You', action: 'added a device from the Library', detail: `${it.name} (${e.name})` });
    this.emit('event', { type: 'infra' });
    return it;
  }
  // Reachability, and for an SSH login also a real sign-in with a harmless command, so "works" means it works.
  async testDevice(id) {
    const it = await this.infra.test(id);
    if (it.status?.ok && it.secret && this.vault.unlocked && (it.lib === 'cloudflare' || it.lib === 'google')) {
      try {
        const sec = this.vault.byName(it.secret), value = sec && this.vault.value(sec.id);
        if (value) {
          const r = await (it.lib === 'cloudflare' ? verifyCloudflare : verifyGoogle)(value, this.cloudFetch || fetch);
          it.status = { ...it.status, ok: r.ok, detail: this.vault.redact(r.detail) }; this.infra._save();
        }
      } catch { /* leave the plain result */ }
    } else if (it.status?.ok && it.secret && this.vault.unlocked && apiInfo(it.lib) && this.vault.list().find((x) => x.name === it.secret)?.type === 'token') {
      try {
        const sec = this.vault.byName(it.secret), value = sec && this.vault.value(sec.id);
        const scheme = (it.url || '').startsWith('http://') ? 'http' : 'https';
        if (value) { const r = await verifyApi(it.lib, { host: it.address, port: it.port, scheme }, value, this.apiGet); if (r) { it.status = { ...it.status, ok: r.ok, detail: this.vault.redact(r.detail) }; this.infra._save(); } }
      } catch { /* leave the plain result */ }
    } else if (it.status?.ok && it.secret && this.vault.unlocked) {
      try {
        const sec = this.vault.byName(it.secret), meta = sec && this.vault.list().find((x) => x.id === sec.id);
        if (meta && meta.type === 'ssh') {
          const EV = envName(sec.name), user = this.vault.user(sec.id), value = this.vault.value(sec.id);
          const env = { [EV]: value, [`${EV}_USER`]: user, [`${EV}_HOST`]: meta.host || it.address, [`${EV}_PORT`]: String(meta.port || 22), [`${EV}_AUTH`]: meta.auth || 'password' };
          const r = await (this.discoveryRun || sshRun)({ name: sec.name, env, shell: 'sh', script: 'echo apiary-ok\n', timeoutMs: 20000 });
          const ok = r.code === 0 && /apiary-ok/.test(r.stdout || '');
          it.status = { ...it.status, ok, detail: ok ? `${it.status.detail}, and the login works` : `${it.status.detail}, but the login was refused: ${this.vault.redact(explainSsh(r.stderr, r.code))}` };
          this.infra._save();
        }
      } catch { /* leave the plain result */ }
    }
    return it;
  }
  // ---- troubleshooting a device that is down ----
  // One "case" per outage. You approve repairs once for the case; it closes after the device has been back up for 15 minutes.
  _sshTarget(it) {
    if (!this.vault.unlocked) return null;
    for (const x of [it, it.parentId && this.infra.get(it.parentId)]) {
      if (!x?.secret) continue;
      const sec = this.vault.byName(x.secret), meta = sec && this.vault.list().find((m) => m.id === sec.id);
      if (meta?.type === 'ssh') { const EV = envName(sec.name); return { item: x, name: sec.name, env: { [EV]: this.vault.value(sec.id), [`${EV}_USER`]: this.vault.user(sec.id), [`${EV}_HOST`]: meta.host || x.address, [`${EV}_PORT`]: String(meta.port || 22), [`${EV}_AUTH`]: meta.auth || 'password' } }; }
    }
    return null;
  }
  async troubleshoot(id) {
    const it = this.infra.get(id), bad = (status, message) => Object.assign(new Error(message), { status });
    if (!it) throw bad(404, 'No such device');
    if (this.troubling?.has(id)) return it;
    await this.testDevice(id);
    const now = Date.now(), up = !!it.status?.ok;
    if (it.trouble && up && now - (it.status.since || now) >= UP_MS) delete it.trouble;   // stable again: the case is over
    if (up && !it.trouble) { it.trouble = { openedAt: now, state: 'done', healthy: true, report: { basic: { summary: `${it.name} is reachable and has been for ${Math.max(1, Math.round((now - (it.status.since || now)) / 60000))} minute(s). Nothing to fix.`, checks: [] } }, log: [] }; this.infra._save(); this.emit('event', { type: 'infra' }); return it; }
    const t = (it.trouble ||= { openedAt: now, approved: false, log: [] });
    t.healthy = false; t.state = 'working'; t.report = null; this.infra._save(); this.emit('event', { type: 'infra' });
    (this.troubling ||= new Set()).add(id);
    this._troubleRun(it).catch((e) => { t.state = 'done'; t.report = { ...(t.report || {}), error: this.vault.redact(String(e.message)) }; }).finally(() => { this.troubling.delete(id); this.infra._save(); this.emit('event', { type: 'infra' }); });
    return it;
  }
  // Wipes the steps and report so the device is clean again. Not while it is being looked at.
  clearTrouble(id) {
    const it = this.infra.get(id); if (!it) throw Object.assign(new Error('No such device'), { status: 404 });
    if (this.troubling?.has(id)) throw Object.assign(new Error('It is still being looked at. Clear it when it has finished.'), { status: 409 });
    delete it.trouble; this.infra._save(); this.emit('event', { type: 'infra' }); return it;
  }
  // Asks the machine this one runs on (the hypervisor or Docker host) what state it is in, using its saved login, and starts it if it is simply stopped.
  async _hostCheck(it, report, t) {
    const red = (x) => this.vault.redact(String(x)), ref = String(it.found?.key || ''), [tag, id] = [ref.split(':')[0], ref.slice(ref.indexOf(':') + 1)];
    const cmds = { 'proxmox-vm': [`qm status ${id}`, `qm start ${id}`], 'proxmox-ct': [`pct status ${id}`, `pct start ${id}`], docker: [`docker ps -a`, `docker start ${id}`] }[tag];
    const parent = it.parentId && this.infra.get(it.parentId);
    if (!parent) { report.couldnt.push('This device is not placed inside a host on the map, so I could only check it from the network.'); return false; }
    if (!cmds || !isSafeFix(cmds[0]) || !isSafeFix(cmds[1])) { report.couldnt.push(`I do not know how to ask ${parent.name} about this kind of machine, so I could only check it from the network.`); return false; }
    const target = this._sshTarget(parent);
    if (!target) { report.couldnt.push(this.vault.unlocked ? `I have no saved login for ${parent.name}, so I could not ask it what state ${it.name} is in.` : `The secrets vault is locked, so I could not use the saved login for ${parent.name}. Unlock it and press Troubleshoot again.`); return false; }
    const run = (cmd) => (this.discoveryRun || sshRun)({ name: target.name, env: target.env, shell: 'sh', script: cmd + '\n', timeoutMs: 60000 });
    const r = await run(cmds[0]), out = red((r.stdout || r.stderr || '').trim());
    t.log.push({ at: Date.now(), cmd: cmds[0], code: r.code, out: out.slice(0, 600) });
    const mine = tag === 'docker' ? out.split('\n').find((l) => new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(l)) || '' : out;
    report.tried.push(`Asked ${parent.name} what state ${it.name} is in ("${cmds[0]}"): ${r.code === 0 ? (mine.split('\n')[0].slice(0, 120) || 'no answer') : 'that did not work'}.`);
    if (r.code !== 0) { report.couldnt.push(`${parent.name} would not answer: ${out.split('\n')[0].slice(0, 140) || 'no reason given'}.`); return false; }
    if (!/\b(stopped|exited|created|shut ?off)\b/i.test(mine)) return false;
    // A machine that is simply stopped is started again straight away: starting never takes anything away.
    this.audit.add('infra', { actor: 'Troubleshooter', action: `started ${it.name} (it was stopped)`, detail: cmds[1] });
    const s = await run(cmds[1]);
    t.log.push({ at: Date.now(), cmd: cmds[1], code: s.code, out: red((s.stdout || s.stderr || '').trim().slice(0, 600)) });
    report.tried.push(`It was stopped, so I started it ("${cmds[1]}"): ${s.code === 0 ? 'done' : 'that did not work'}.`);
    if (s.code !== 0) { report.couldnt.push(`Starting it failed: ${red((s.stderr || s.stdout || '').trim().split('\n')[0].slice(0, 140))}.`); return false; }
    await new Promise((x) => setTimeout(x, Number(process.env.APIARY_FIX_WAIT_MS ?? 20000)));
    await this.testDevice(it.id);
    return !!it.status?.ok;
  }
  // Who investigates: the agent that mapped the device (it knows it best), else an infrastructure specialist, else the CEO.
  async _troubleAgent(it) {
    const live = Object.values(this.agents).filter((a) => !this._isProject(a) && !a.removed && a.provider && a.id !== 'interview');
    const proposer = it.by && live.find((a) => a.name.toLowerCase() === String(it.by).toLowerCase());
    if (proposer) return { agent: proposer, why: `${proposer.name} mapped this device and knows it best.` };
    const re = /infra|devops|sysadmin|sre\b|network|systems|platform|server|home ?lab|operations|\bops\b/i;
    const word = `${it.name} ${it.type} ${it.lib || ''}`.toLowerCase();
    const spec = live.filter((a) => re.test(`${a.title || ''} ${a.role || ''}`)).sort((a, b) => (word.includes('network') || ['router', 'switch'].includes(it.type) ? /network/i.test(`${b.title} ${b.role}`) - /network/i.test(`${a.title} ${a.role}`) : 0))[0];
    if (spec) return { agent: spec, why: `${spec.name} is the infrastructure specialist.` };
    try { const g = await this.general(); return g ? { agent: g, why: 'No infrastructure specialist yet, so the CEO took it.' } : null; } catch { return null; }
  }
  async _troubleRun(it) {
    const t = it.trouble, red = (x) => this.vault.redact(String(x));
    const facts = await gatherFacts(this.infra, it, this.troubleProbe || {});
    const report = t.report = { at: Date.now(), basic: basicAdvice(facts), ai: '', manual: [], tried: triedFromFacts(facts), couldnt: [], needYou: [] };
    this.infra._save(); this.emit('event', { type: 'infra' });
    try {
      if (await this._hostCheck(it, report, t)) { report.outcome = `${it.name} is reachable again after I started it.`; report.basic = { summary: `${it.name} had simply stopped. I started it and it is back.`, checks: [] }; t.state = 'done'; return; }
    } catch (e) { report.couldnt.push(`Checking the host failed: ${red(e.message).slice(0, 140)}.`); }
    this.infra._save(); this.emit('event', { type: 'infra' });
    let fix = null;
    try {
      // The agent that knows this device investigates it: it has the device's notes, login and what it runs on.
      const who = await this._troubleAgent(it);
      report.by = who ? who.agent.name : ''; report.byWhy = who?.why || ''; this.infra._save(); this.emit('event', { type: 'infra' });
      const facts2 = `Facts (read-only checks made from the Apiary computer just now):\n${JSON.stringify(facts)}`;
      let text;
      if (who && this.troubleViaAgent !== false) {
        const brief = `TROUBLESHOOTING REQUEST. The person pressed Troubleshoot on "${it.name}" (${it.type}${it.address ? ', ' + it.address : ''}) because it is ${it.status?.ok ? 'reported healthy but they want it checked' : 'not reachable or has a problem'}.\n\nYou know this device best, so investigate it properly like an engineer would, then report back. Look at: the service or VM itself (status, recent logs, disk, memory), the machine it runs on if it is a VM, container or service, and neighbouring devices on the Infrastructure map it depends on (network, DNS, storage). Use your saved logins for READ-ONLY checks only (status, logs, listings); change nothing yourself. Do the checking yourself: never ask the person to look at something you can look at with a login you have. Only list a step for the person when you genuinely cannot do it (no login, physical access, a power cable).\n\n${facts2}\n\n${TROUBLE_SYSTEM}\n\nAnswer in plain words for a non-expert, under exactly these four headings, each on its own line:\nTRIED: what you checked, one line each, with what you saw.\nFOUND: what is wrong and the evidence, plain explanation first.\nCOULD NOT: what you could not check and why (for example, no login for it). Write None if nothing.\nYOU NEED TO: only the steps a person must do. Write None if nothing.`;
        text = await this.send(who.agent.id, brief, null, {});
        if (!text || /^\(stopped\)/.test(text)) throw new Error('The agent gave no answer');
      } else {
        text = await this._oneShot(TROUBLE_SYSTEM, `${facts2}\n\nExplain what is probably wrong and what to check.`);
      }
      const pr = parseReport(stripFix(text));
      if (pr) { report.tried.push(...pr.tried.map(red)); report.couldnt.push(...pr.couldnt.map(red)); report.needYou = pr.needYou.map(red); report.ai = red(pr.found); report.structured = true; } else report.ai = red(stripFix(text));
      fix = parseFix(text);
    } catch (e) { report.aiNote = 'No agent could investigate, so this is the built-in analysis only.'; }
    this.infra._save(); this.emit('event', { type: 'infra' });
    if (!fix) return finish();
    const safe = fix.commands.filter(isSafeFix); report.manual = fix.commands.filter((c) => !isSafeFix(c)).map(red);
    const target = fix.on === 'host' && it.parentId ? this._sshTarget(this.infra.get(it.parentId)) : this._sshTarget(it);
    if (!safe.length || !target) { if (safe.length) report.manual.push(...safe.map(red)); report.note = safe.length ? 'Apiary has no SSH login it can use for these, so they are listed for you to run.' : ''; return finish(); }
    if (t.approved === undefined || t.approved === false) {
      if (t.denied) { report.manual.push(...safe.map(red)); report.note = 'You declined repairs for this problem, so they are listed for you to run.'; return finish(); }
      const d = await this._ask(await this.general(), { kind: 'troubleshoot', title: `Let the troubleshooter try to fix ${it.name}`, detail: `It would run on ${target.item.name} (through its saved login):\n${safe.map((c) => '• ' + c).join('\n')}\n\nWhy: ${fix.why || 'to bring it back'}.\nOnly restarting or starting things, rebooting and read-only checks are ever allowed. You are asked once for this problem; it ends after ${it.name} has been back up for 15 minutes.` });
      if (d.decision === 'deny') { t.denied = true; report.manual.push(...safe.map(red)); report.note = 'You declined, so the repairs are listed for you to run.'; return finish(); }
      t.approved = true; t.approvedAt = Date.now();
    }
    this.audit.add('infra', { actor: 'Troubleshooter', action: `tried to repair ${it.name}`, detail: safe.join('; ') });
    for (const cmd of safe) {
      const r = await (this.discoveryRun || sshRun)({ name: target.name, env: target.env, shell: 'sh', script: cmd + '\n', timeoutMs: 60000 });
      t.log.push({ at: Date.now(), cmd, code: r.code, out: red((r.stdout || r.stderr || '').trim().slice(0, 600)) });
      this.infra._save(); this.emit('event', { type: 'infra' });
    }
    await new Promise((r) => setTimeout(r, Number(process.env.APIARY_FIX_WAIT_MS ?? 20000)));
    await this.testDevice(it.id);
    report.outcome = it.status?.ok ? `${it.name} is reachable again.` : `${it.name} is still not reachable after the repair. Follow the checks above.`;
    return finish();
    function finish() { t.state = 'done'; }
  }
  async discover(id) {
    const host = this.infra.get(id), bad = (status, message) => Object.assign(new Error(message), { status });
    if (!host) throw bad(404, 'No such device');
    if (!host.secret) throw bad(400, 'Link an SSH login to this device first (press Update and choose its login).');
    if (!this.vault.unlocked) throw bad(423, 'The vault is locked. Unlock it first (Secrets page).');
    const sec = this.vault.byName(host.secret); if (!sec) throw bad(400, `The login "${host.secret}" is not in the vault.`);
    const meta = this.vault.list().find((x) => x.id === sec.id) || {}, type = typeOf(meta), user = this.vault.user(sec.id), value = this.vault.value(sec.id);
    if (type === 'token' || value === null) throw bad(400, `Discover needs an SSH login or a username and password, and "${host.secret}" is an API token. The token is used for the official API only, so there is nothing to discover over SSH here. To also list its machines, press Update and add an SSH login.`);
    if (!user) throw bad(400, `The login "${host.secret}" needs a username.`);
    const addr = type === 'ssh' ? meta.host : host.address; if (!addr) throw bad(400, 'Give the device an address first.');
    if (this.discovering.has(id)) throw bad(409, 'Discovery is already running for this device.');
    this.discovering.add(id);
    try {
      const EV = envName(sec.name), env = { [EV]: value, [`${EV}_USER`]: user, [`${EV}_HOST`]: addr, [`${EV}_PORT`]: String(type === 'ssh' ? meta.port || 22 : 22), [`${EV}_AUTH`]: type === 'ssh' ? meta.auth || 'password' : 'password' };
      const redact = (t) => this.vault.redact(String(t));
      const { detected, found } = await discoveryProbe((shell, script) => (this.discoveryRun || sshRun)({ name: sec.name, env, shell, script }), redact);
      const now = Date.now(), added = [], waiting = [], known = [], seen = new Set(found.map((f) => f.key)), notes = [];
      const under = this.infra.items.filter((i) => i.parentId === host.id);
      for (const f of found) {
        const alt = `${f.name} (${host.name})`.slice(0, 60);
        const ex = under.find((i) => i.found?.key === f.key) || under.find((i) => [f.name, alt].some((n) => n.toLowerCase() === i.name.toLowerCase()));
        if (ex) { ex.found = { ...(ex.found || {}), key: f.key, status: f.status, at: now }; (ex.state === 'proposed' ? waiting : known).push(ex.name); continue; }
        if (added.length >= 200) { notes.push('More than 200 new items were found. Confirm these first, then press Discover again for the rest.'); break; }
        const name = this.infra.byName(f.name) ? alt : f.name;
        if (this.infra.byName(name)) { notes.push(`"${f.name}" was skipped because the name is already used elsewhere on the map.`); continue; }
        try {
          const it = this.infra.add({ name, type: f.kind, address: f.address || undefined, parentId: host.id, notes: `Found by Discovery on ${host.name}.`, why: `Found on ${host.name} (${f.label}). It was ${f.status} when found.` }, { proposed: true, by: 'Discovery' });
          it.found = { key: f.key, tag: f.tag, status: f.status, at: now }; added.push(it.name);
        } catch (e) { notes.push(`Could not add "${f.name}": ${e.message}`); }
      }
      const okTags = new Set(detected.filter((d) => d.ok).map((d) => d.tag));
      const missing = under.filter((i) => i.state !== 'proposed' && i.found?.key && okTags.has(i.found.tag || i.found.key.split(':')[0]) && !seen.has(i.found.key)).map((i) => i.name);
      this.infra._save();
      this.audit.add('infra', { actor: 'You', action: `ran Discovery on "${host.name}"`, detail: `${added.length} new, ${known.length + waiting.length} already known${missing.length ? `, ${missing.length} not found` : ''}` });
      if (added.length) this.emit('event', { type: 'infra' });
      return { host: host.name, detected, added, waiting, known: known.length, missing, notes, at: now, nothing: !detected.length };
    } finally { this.discovering.delete(id); }
  }

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
    const taken = new Set([root.name, ...roster.map((m) => m.name), ...this.tree(root.id).map((id) => this.agents[id]?.name)].filter(Boolean).map((n) => n.toLowerCase()));
    const ok = [];
    // Every hire that is not made says why, in the chat and the activity log, so nothing is dropped silently.
    const drop = (text) => { notes.push(text); this._log(proposer, `! ${text}`); this._msg(proposer, { role: 'system', text }); };
    this._log(proposer, `? hire proposal received: ${hires.map((h) => h.title || h.name).join(', ')}`);
    for (const h of hires.slice(0, 8)) {
      const title = String(h.title || h.name).trim().slice(0, 60);
      if (titles.has(title.toLowerCase())) { drop(`Not hired: there is already a ${title} on the team. Use apiary-assign to give them work.`); continue; }
      if (this.tree(root.id).length + ok.length >= this.limits.maxAgents) { drop(`Not hired: the team is at its size limit, so a ${title} cannot be added.`); continue; }
      titles.add(title.toLowerCase());
      const dept = DEPARTMENTS[h.department] ? h.department : inferDepartment(title, h.role);
      const fit = h.name ? fitName(h.name, 40) : { name: '', cut: false };
      if (fit.cut) this._msg(proposer, { role: 'system', text: `The name "${h.name}" is longer than 40 characters, so it was shortened to "${fit.name}". Ask for a shorter name if you prefer.` });
      const given = fit.name;
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
      this._msg(proposer, { role: 'system', text: `Proposed hire waiting for your approval on the Approvals page: ${ok.map((x) => x.title).join(', ')}.` });
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
  // MCP connectors this agent may use right now: a connected service whose login the person approved for this turn.
  _connectorsFor(agent) {
    const mp = this.leases.get(agent.id), out = {};
    if (!mp) return out;
    for (const it of this.infra.items) {
      const lib = it.lib && libraryEntry(it.lib);
      if (lib?.mcp && it.secret && mp.has(it.secret) && !out[lib.mcp.name]) out[lib.mcp.name] = { url: lib.mcp.url, envVar: envName(it.secret) };
    }
    return out;
  }
  _leaseEnv(agent) {
    const mp = this.leases.get(agent.id);
    const us = this.userLeases.get(agent.id);
    return { ...(this.metaLeases.get(agent.id) || {}), ...(mp ? Object.fromEntries([...mp].map(([name, v]) => [envName(name), v])) : {}), ...(us ? Object.fromEntries([...us].map(([name, v]) => [envName(name) + '_USER', v])) : {}) };
  }
  // An agent asked for secrets with apiary-secret. Needs: vault unlocked, secret assigned to this agent, and the human's yes.
  // An agent asks to save a secret it made. The person types the value on the approval card; the agent never sees it.
  async _newSecret(agent, reqs, notes) {
    for (const r of reqs.slice(0, 3)) {
      if (this.vault.exists && this.vault.byName(r.name)) { notes.push(`There is already a secret called "${r.name}". Use it by name, or ask to save this one under another name.`); continue; }
      const d = await this._ask(agent, { kind: 'newsecret', title: `${agent.name} wants to save a secret "${r.name}"`, detail: r.why || `A ${r.type} for ${agent.name}.`, secretName: r.name, secretType: r.type, username: r.username, host: r.host, port: r.port, auth: r.auth });
      if (d.decision === 'deny') notes.push(`The person did not save "${r.name}"${d.note ? ': ' + d.note : ''}.`);
      else notes.push(`The person saved "${r.name}" in the vault. Ask to use it by name when you need it.`);
    }
  }
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
    const fields = { id, name: title, role: `Leads the ${title} project`, provider, method, model: model || this.defaultModel(provider), access: access === 'full' ? 'full' : 'safe', parentId: null, depth: 0, ownerId: this.orgDone ? this._ceo()?.id : undefined, approvals: approvals === undefined ? this.approvalsDefault : !!approvals };

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

  // Work that is running or waiting on the person. An update waits for this to reach zero.
  busy() {
    const ids = new Set([...this.ctls.keys(), ...Object.values(this.agents).filter((a) => a.status === 'working' || a.status === 'waiting').map((a) => a.id)]);
    const pend = Object.values(this.store.data.approvals).filter((r) => r.status === 'pending');
    // An agent that is waiting for its own approval is one piece of work, not two.
    const extra = pend.filter((r) => !ids.has(r.agentId)).length;
    return { runs: ids.size, approvals: pend.length, total: ids.size + extra };
  }
  // While an update is queued, no new work starts: messages are refused with a clear reason until it is cancelled or installed.
  holdNewWork(on) { this.updateHold = !!on; }
  send(agentId, text, from = null, opts = {}) {
    const agent = this.agents[agentId];
    if (!agent) throw httpErr(404, 'No such agent');
    if (this.updateHold) throw httpErr(409, 'An update is waiting for the current work to finish, so new messages are held. Send it again after the update has installed.');
    const rt = this.rootOf(agent);
    if (rt.kind !== 'general' && this.stageOf(rt) === 'closed') throw httpErr(409, 'This project is closed. Reopen it (Projects page) to continue. Nothing has been deleted.');
    const prev = this.chains.get(agentId) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => this._converse(agent, text, from, opts));
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
    if (this.plainEnglish) s += '\nWRITING STYLE: Write in plain, simple English by default. Short sentences, everyday words, no jargon or buzzwords. If a technical term is needed, explain it in a few words the first time. Say what you did and what happens next. Code, commands and file contents stay exact.\n' +
      'PLAIN REPORTS: When you report back to the human, say what changed for them in a few short sentences, as you would to someone who does not write code: what now works, what does not, and what they need to decide or do. Leave out technical detail such as file names, function or variable names, header or protocol names, test internals and numbered lists of code changes, unless the human asks how it was done or asks for details. End with one short line offering the technical details if they want them. The only exception is something the human must copy and run; that stays exact, in a code block. This does not apply to instructions you give other agents, which stay complete.\n';
    const standing = this._standing(agent);
    if (standing) s += `\nStanding instructions for you:\n${standing}\n`;
    if (agent.method !== 'api' && agent.provider !== 'mock' && this.handoverOn) s += this.handover.instruction(agent.id);
    if (agent.method === 'api') s += 'You are connected through a web API: you cannot read files or run commands. Answer in text only.\n';
    if (agent.git) s += `You are working on git branch ${agent.git.branch} in your own checkout. Your changes are committed for you after each turn; do not switch branches or push.\n`;
    if (!agent.parentId) s += 'FORMATTING: Whenever you give the human something to copy and run or paste (a terminal or SSH command, a config line, a file path to type, a script, a key), put it in a fenced code block (three backticks, then the language such as bash) and nothing else inside it, one command per line, with no $ prompt in front. Short names, commands or file names inside a sentence go in single backticks.\n';
    s += 'LAYOUT: Never write one big block of text. Use short paragraphs (two or three sentences), one idea each. Put steps in a numbered list with one step per line, options in bullet lists, and start each section with a short label such as Goal:, Rules:, Steps:, Report:. This applies to everything you write, including instructions you give to other agents.\n';
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
    if (agent.kind === 'general' || agent.org || (proj && who.kind === 'general') || !agent.parentId || agent.member) {
      const known = this.infra.summary();
      s += '\nINFRASTRUCTURE MAP: the person keeps a map of their devices, servers, VMs, websites and how they connect (Infrastructure page). When they mention a device, server, VM, website or service, or you learn one while working, propose it and Apiary shows it to them as an "Is this right?" card; nothing is added until they confirm. Guess sensible details from your own knowledge (type, what it runs on, what it connects to), say why in "why", and when something important is unknown ask in "question" (for example where it is stored, its address, or which secret in the vault logs in to it). Only ask when it matters. Never put passwords in the map: name the vault secret in "notes" instead.\n```apiary-infra\n{"items":[{"name":"pve1","type":"proxmox|server|vm|container|pi|nas|router|switch|website|service|database|cloud|device|other","address":"10.0.0.5","hostedOn":"Existing item name","connectsTo":["Other item name"],"notes":"Optional","why":"Why you think so","question":"Optional question for the person"}]}\n```\n' + (known ? 'Already on the map:\n' + known + '\n' : '');
    }
    { const ct = this.tasks.all[this.curTask.get(agent.id)];
      if (ct) s += `\nCURRENT TASK: ${ct.code} "${ct.title}". Every piece of work has a task code. If you hand work to a teammate (apiary-assign, apiary-send or a sub-agent), Apiary opens a linked subtask for it, waits for the teammate, and the teammate closes it ("Closed by <name>. Refer to ${ct.code}"). You then get the result with its code and carry on, or close your own task by finishing. Mention task codes when you report.\n`; }
    if (agent.kind === 'general' || agent.org || !agent.parentId || agent.member) {
      const rb = this.runbooks.promptText();
      s += '\nRUNBOOKS: when you solve a problem that could come back (a fix, a setup, a recovery), save the steps so they can be followed next time. Add a block ```apiary-runbook\n{"title":"Short name","problem":"When this applies","steps":["Step one","Step two"],"tags":["server"]}\n```. Never put passwords, keys or tokens in a runbook; say which secret to use by name. It is saved as a draft that the human must read and approve before it is trusted.\n' +
        (rb ? 'APPROVED RUNBOOKS (the human has approved these; follow them when the problem matches, and say which one you used):\n' + rb + '\n' : 'There are no approved runbooks yet.\n');
    }
    if (this._planOwner(agent) && (!agent.parentId || agent.member)) {
      const lead = !agent.parentId;
      s += this._planContext(agent);
      if (lead && !this._planOwner(agent).plan) s += '\nBIG PROJECTS: this is a project, so the work is usually large and long. Do not start building straight away. First propose a phased plan the human can approve: ```apiary-plan\n{"goal":"What done looks like","phases":[{"title":"Short phase name","goal":"What this phase achieves","steps":["Concrete step",{"text":"Another step","owner":"Name of the teammate who does it"}]}]}\n```. A step may name its owner (a teammate on your team); steps without one are yours. Every step becomes a task with its own ID once the human approves. Use 3 to 7 phases (for example research and requirements, design, build, test, launch), each with concrete steps. Small one-off questions do not need a plan.\n';
      s += '\nProgress: when you finish a step (or get stuck), tell Apiary so the human can see where the project stands: ```apiary-progress\n{"phase":1,"step":2,"status":"done","note":"Optional short note"}\n```. "phase" and "step" are numbers or exact names; status is done, active or blocked. Omit "step" to update the whole phase.' + (lead ? ' If the plan needs to change, send a new apiary-plan block; finished work is kept.' : '') + '\n';
    }
    s += '\nTasks: you can add to the human\'s task board, or move a task, with ```apiary-task\n{"title":"Short task title","notes":"Optional detail","status":"todo|backburner|inprogress|blocked|done"}\n```. Use the same title to update a task. "backburner" is for ideas that are not ready yet.\n';
    if ((agent.member || !agent.parentId) && this.vault.exists) s += '\nSecrets: you never see passwords or keys. If a task needs one, ask with a block like ```apiary-secret\n{"name":"Name of the secret","why":"what you need it for"}\n```. If it is not assigned to you yet, the human is asked right then whether to allow it. The human approves each use unless they chose always. If approved, it is available to your shell commands as an environment variable named in the reply; use it there and never print or save it.\n';
    if ((agent.member || !agent.parentId) && this.vault.exists) s += this._secretsNote(agent);
    if ((agent.member || !agent.parentId) && this.vault.exists) s += '\nSECRETS YOU MAKE: if you create a password, key or token that must be kept, do not print it. Ask to save it with ```apiary-newsecret\n{"name":"Short name","type":"login|token|ssh","username":"","host":"","why":"What it is for"}\n```. Never include the value; the person types it on the Approvals page.\n';
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
        '"to" can also be "parent" or "lead". Anyone can message anyone on the team, in any direction. With "wait":true (default) the teammate\'s reply comes to you as a new message, and you are not held while they work; with "wait":false the message is delivered and no reply is expected. ' +
        'Keep it purposeful: do not chat for the sake of it.\nTeammates:\n' +
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
  // Safe-mode Claude runs ask the person before a shell command runs. The CLI calls the approval bridge,
  // which posts the request here with this run's one-time token; the answer comes from the Approvals page.
  beginApprovalBridge(agent, signal) {
    const token = randomBytes(24).toString('hex');
    this.approvalRuns.set(token, { agent, signal });
    return { url: `${this.baseUrl}/api/approval-bridge`, token, bridge: fileURLToPath(new URL('./approval-bridge.js', import.meta.url)) };
  }
  endApprovalBridge(approval) { if (approval) this.approvalRuns.delete(approval.token); }
  // The trust slider for one agent: 0 asks for every command, 5 runs everything without asking.
  setTrust(id, b = {}) {
    const agent = this.agents[id];
    if (!agent) throw httpErr(404, 'No such agent');
    const level = this._trustLevel(b);
    this._applyTrust(agent, level);
    this.audit.add('system', { actor: 'You', project: this._pname(agent), action: `set how much ${agent.name} may do without asking`, detail: TRUST_LEVELS[level] });
    this.store.save();
    return { id, trust: level, text: TRUST_LEVELS[level] };
  }
  // The master slider: sets every agent to the same position. Each agent can then be moved on its own.
  setTrustAll(b = {}) {
    const level = this._trustLevel(b);
    const agents = Object.values(this.agents);
    for (const a of agents) this._applyTrust(a, level);
    this.audit.add('system', { actor: 'You', action: `set how much all ${agents.length} agents may do without asking`, detail: TRUST_LEVELS[level] });
    this.store.save();
    return { trust: level, count: agents.length, text: TRUST_LEVELS[level] };
  }
  _trustLevel(b) {
    const raw = b.level;
    const level = typeof raw === 'number' || (typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)) ? Number(raw) : NaN;
    if (!Number.isInteger(level) || level < 0 || level > 5) throw httpErr(400, 'The level must be a whole number from 0 to 5');
    return level;
  }
  _applyTrust(agent, level) {
    agent.trust = level;
    this.emit('event', { type: 'agent', agent });
  }
  async requestCommandApproval(token, body = {}) {
    const run = this.approvalRuns.get(token);
    if (!run) return { behavior: 'deny', message: 'This run is no longer active.' };
    const { agent, signal } = run;
    const input = body.input && typeof body.input === 'object' ? body.input : {};
    const tool = String(body.tool_name || 'a tool').slice(0, 80);
    const command = typeof input.command === 'string' ? input.command : '';
    const isShell = tool === 'Bash' && !!command;
    const shown = this._redact(isShell ? command : JSON.stringify(input)).slice(0, 800);
    const title = isShell ? `${agent.name} wants to run a command` : `${agent.name} wants to use ${tool}`;
    const parsed = isShell ? parseCommand(command) : null;
    // "Always allow this exact command" is offered only when the text holds no secret value and is short.
    const canExact = !!parsed && shown === command && command.length <= 500;
    // If the run is stopped while the person is deciding, the request is denied rather than left hanging.
    const cancel = () => { for (const r of Object.values(this.store.data.approvals)) if (r.status === 'pending' && r.kind === 'command' && r.agentId === agent.id) this.decide(r.id, { decision: 'deny', note: 'The run was stopped.' }); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      // The trust slider allows a command before anyone is asked, unless a Deny rule blocks it.
      const denied = this.policy.match({ kind: 'command', title, project: this.rootOf(agent).id, agent: agent.id, command: isShell ? command : '' })?.action === 'deny';
      const level = Math.trunc(Number(agent.trust)) || 0;
      if (!denied && (isShell ? levelAllows(level, command) : level >= 5)) {
        this._recordAuto(agent, { title, detail: shown, status: 'approved', note: `Allowed automatically by the trust setting: ${TRUST_LEVELS[level]}.` });
        return { behavior: 'allow', updatedInput: input };
      }
      const fields = { kind: 'command', title, detail: shown, tool, canExact, program: parsed?.program || '' };
      const ans = await this._ask(agent, fields, { command: isShell ? command : '' });
      if (ans.decision !== 'approve') return { behavior: 'deny', message: ans.note || 'The person did not allow this command.' };
      if (ans.mode && ans.mode !== 'once' && isShell) this._rememberCommand(agent, ans.mode, command, parsed, canExact);
      return { behavior: 'allow', updatedInput: input };
    } catch {
      return { behavior: 'deny', message: 'The command was not approved.' };
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
  // A decision made without asking (trust setting or rule) is kept on the Approvals page and shown in the chat.
  _recordAuto(agent, { title, detail, status, note }) {
    const id = id8(), now = Date.now();
    this.store.data.approvals[id] = this._approvalNo({ id, agentId: agent.id, agentName: agent.name, projectId: this.rootOf(agent).id, status, kind: 'command', title, detail, auto: true, note, createdAt: now, decidedAt: now });
    const decided = Object.values(this.store.data.approvals).filter((r) => r.status !== 'pending').sort((a, b) => b.createdAt - a.createdAt);
    for (const r of decided.slice(500)) delete this.store.data.approvals[r.id];
    this.emit('event', { type: 'approval', approval: this.store.data.approvals[id] });
    this.audit.add('approval', { actor: 'Trust setting', project: this._pname(agent), action: `${status === 'approved' ? 'allowed' : 'blocked'} automatically: ${title}`, detail: note });
    this._msg(agent, { role: 'system', text: `${status === 'approved' ? 'Allowed' : 'Blocked'} automatically: ${title}` });
    return this.store.data.approvals[id];
  }
  // Saves an "always" choice as a rule, so the same kind of command is not asked about again.
  _rememberCommand(agent, mode, command, parsed, canExact) {
    try {
      if (mode === 'exact' && canExact) this.policy.add({ kind: 'command', action: 'allow', scope: 'exact', command: command.trim(), agent: agent.id });
      else if (mode === 'program' && parsed?.program && !isDangerous(command)) this.policy.add({ kind: 'command', action: 'allow', scope: 'program', command: parsed.program, agent: agent.id });
      else if (mode === 'readonly') this.policy.add({ kind: 'command', action: 'allow', scope: 'readonly', agent: agent.id });
      else if (mode === 'agent') this.policy.add({ kind: 'any', action: 'allow', agent: agent.id });
    } catch (e) {
      this._log(agent, `! could not save that rule: ${e.message}`);   // e.g. a duplicate: the answer still applies to this request
    }
  }
  async _exec(agent, prompt, images = []) {
    const ctl = new AbortController();
    this.ctls.set(agent.id, ctl);
    this._setStatus(agent, 'working');
    this._log(agent, `── ${new Date().toLocaleTimeString()} ${agent.name} (${agent.provider}, ${agent.method === 'api' ? 'web' : 'terminal'}) ──`);
    const approval = agent.provider === 'claude' && agent.method !== 'api' && agent.access !== 'full' ? this.beginApprovalBridge(agent, ctl.signal) : undefined;
    try {
      const runner = providers.pick(agent);
      const system = this._system(agent) + this._projectNote(agent) + this.repos.contextFor(agent) + (this.memoryEnabled ? this.memory.context(this._mkey(agent), this._pkey(agent), prompt) : '');
      const res = await this._runRecovering(agent, ctl, { prompt, system, approval, runner, images: this.images.files(images) });
      this._usage(agent, res, system, prompt);
      if (res.sessionId && !res.switchedProvider) agent.sessionId = res.sessionId;
      if (agent.method === 'api') {
        agent.history = [...(agent.history || []), { role: 'user', content: prompt }, { role: 'assistant', content: res.text }].slice(-40);
      }
      return res.text;
    } catch (e) {
      if (e.name !== 'AbortError' && !e.recorded) { this.health.noteLoginFailure(agent.provider, e.message); this._log(agent, `! ${e.message}`); if (looksLikeLimit(e.message)) { this.usage.markLimit(agent.provider); this._log(agent, `! ${agent.provider} looks like it has reached its usage limit. See Usage.`); } }
      throw e;
    } finally {
      this.endApprovalBridge(approval);
      this.ctls.delete(agent.id);
      this.emit('event', { type: 'activity', agentId: agent.id, text: '' });
    }
  }

  // ----- retries and recovery: a failed or stuck run is retried, handed to the other AI if that helps, and only then put to you -----
  _alternate(agent) {
    if (agent.provider === 'mock') return null;
    return this.available.find((p) => p.id !== agent.provider && p.id !== 'mock' && this.resolveMethod(p.id))?.id || null;
  }
  _failKind(e, stuck) {
    const m = String(e?.message || e);
    if (stuck) return 'stuck';
    if (LOGIN_RE.test(m)) return 'auth';
    if (/overloaded|\b50[234]\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network|connection (reset|closed|lost)|temporar/i.test(m)) return 'transient';
    if (looksLikeLimit(m)) return 'limit';
    return 'other';
  }
  _failWords(kind, who) {
    return { limit: `${who} has reached its usage limit`, auth: `${who} is not signed in any more`, stuck: `${who} stopped responding`, transient: `${who} could not be reached`, other: `${who} stopped with an error` }[kind] || `${who} failed`;
  }
  async _runRecovering(agent, ctl, { prompt, system, approval, runner, images = [] }) {
    const retryMs = Number(process.env.APIARY_RETRY_MS || 3000), stuckMs = Number(process.env.APIARY_STUCK_MS || 20 * 60 * 1000);
    const maxRetries = this.limits.maxRetries ?? 2;
    const label = (id) => PROVIDER_LABEL[id] || id;
    let cur = agent, attempt = 0, retries = 0, escalations = 0, switched = false, extra = null; const tried = [];
    for (;;) {
      if (ctl.signal.aborted) throw abortError();
      const rctl = new AbortController(), onAbort = () => rctl.abort(); ctl.signal.addEventListener('abort', onAbort, { once: true });
      let idle = null, stuck = false;
      const ping = () => { clearTimeout(idle); idle = setTimeout(() => { stuck = true; rctl.abort(); }, stuckMs); };
      ping();
      const bridge = cur.provider === agent.provider ? approval : (cur.provider === 'claude' && cur.method !== 'api' && cur.access !== 'full' ? this.beginApprovalBridge(cur, rctl.signal) : undefined);
      try {
        const run = cur.provider === agent.provider ? runner : providers.pick(cur);
        const res = await run.run({
          agent: cur, prompt, system: cur.switchedFrom && this.handoverOn ? system + this.handover.switchNote(agent.id, label(cur.switchedFrom)) : system, images, dirs: [...this.repos.dirsFor(agent), ...this._projectDirs(agent), ...(this.handoverOn ? [this.handover.dir] : []), ...(images.length ? [this.images.dir] : [])], signal: rctl.signal, approval: bridge, connectors: this._connectorsFor(agent),
          history: agent.history || [], conn: cur.method === 'api' ? this.connections.get(cur.provider) : null,
          onText: (text) => { ping(); this.emit('event', { type: 'delta', agentId: agent.id, text: this._redact(text) }); },
          onActivity: (text) => { ping(); this.emit('event', { type: 'activity', agentId: agent.id, text }); },
          onLog: (line) => { ping(); this._log(agent, line); }, env: this._leaseEnv(agent),
        });
        if (cur.provider !== agent.provider) res.switchedProvider = cur.provider;
        return res;
      } catch (e) {
        if (e.name === 'AbortError' && !stuck) throw e;
        e.recorded = true;
        const kind = this._failKind(e, stuck), why = stuck ? `no sign of life for ${Math.round(stuckMs / 60000) || '<1'} minute(s)` : String(e.message || e).slice(0, 200);
        if (!stuck) { this.health.noteLoginFailure(cur.provider, e.message); if (looksLikeLimit(e.message)) { this.usage.markLimit(cur.provider); this._log(agent, `! ${cur.provider} looks like it has reached its usage limit. See Usage.`); } }
        this._log(agent, `! ${why}`); tried.push(`${label(cur.provider)}: ${this._failWords(kind, label(cur.provider))}`);
        attempt++;
        if (kind === 'other') this.noteRun(agent, false);
        // 1. a short hiccup (network, overloaded, stuck): try the same AI again
        if ((kind === 'transient' || kind === 'stuck') && retries < maxRetries) {
          retries++;
          this._msg(agent, { role: 'system', text: `${this._failWords(kind, label(cur.provider))}. Trying again (${retries} of ${maxRetries}).` });
          await new Promise((r, j) => { const t = setTimeout(r, retryMs * retries); ctl.signal.addEventListener('abort', () => { clearTimeout(t); j(abortError()); }, { once: true }); });
          cur = { ...cur, attempt }; continue;
        }
        // 2. a limit, a lost login or a repeated failure: hand this step to the other AI
        const alt = !switched ? this._alternate(agent) : null;
        if (alt && (kind !== 'other')) {
          switched = true; cur = { ...agent, provider: alt, method: this.resolveMethod(alt), sessionId: null, model: '', switchedFrom: agent.provider, attempt };
          this._msg(agent, { role: 'system', text: `${this._failWords(kind, label(agent.provider))}, so ${label(alt)} takes over this step.` });
          this._log(agent, `↪ switching to ${alt} for this step`);
          continue;
        }
        // 3. nothing worked: put it to you, in plain words
        if (escalations >= 2 || this.stopped.has(agent.id)) throw e;
        escalations++;
        const r = await this._ask(agent, {
          kind: 'stuck', title: `${agent.name} cannot continue: ${this._failWords(kind, label(cur.provider))}`,
          detail: `What happened: ${why}.\nWhat Apiary tried: ${tried.join('; ')}${retries ? `; retried ${retries} time${retries > 1 ? 's' : ''}` : ''}${switched ? '; handed the step to the other AI' : ''}.\n${kind === 'limit' ? 'Usually this clears when the limit resets. ' : kind === 'auth' ? 'Sign in again on the Connections page, then try again. ' : ''}Choose "Try again" to run the step once more, or "Give up" to stop here and tell the team.`,
        });
        if (r.decision !== 'approve') throw Object.assign(new Error(`${this._failWords(kind, label(cur.provider))}; you chose to stop. ${why}`), { handled: true });
        retries = 0; switched = false; cur = { ...agent, attempt, humanOk: true };
      } finally {
        clearTimeout(idle); ctl.signal.removeEventListener('abort', onAbort);
        if (bridge && bridge !== approval) this.endApprovalBridge(bridge);
      }
    }
  }

  _usage(agent, res, system, prompt) {
    this.health.noteSuccess(agent.provider);
    this.noteRun(agent, true);
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
  // Each plan step becomes a task with its own ID, given to the teammate named as its owner (or to the lead).
  _planTasks(root) {
    const plan = root.plan; if (!plan) return;
    const members = Object.values(this.agents).filter((a) => this.rootOf(a).id === root.id);
    plan.phases.forEach((ph, i) => ph.steps.forEach((st) => {
      if (st.taskId && this.tasks.all[st.taskId]) return;
      const who = members.find((a) => st.owner && a.name.toLowerCase() === st.owner.toLowerCase()) || root;
      const t = this.tasks.add({ title: st.text, notes: `Phase ${i + 1}: ${ph.title}`, status: st.done ? 'done' : 'todo', labels: ['plan'], assignee: { id: who.id, name: who.name }, project: root.id, source: 'plan', ref: `plan:${root.id}` });
      st.task = t.code; st.taskId = t.id; if (st.owner && who === root && who.name.toLowerCase() !== st.owner.toLowerCase()) st.owner = '';
    }));
  }
  // A step that is done closes its task.
  _syncPlanTasks(plan) {
    for (const ph of plan.phases || []) for (const st of ph.steps) {
      const t = st.taskId && this.tasks.all[st.taskId];
      if (t && st.done && t.status !== 'done') { try { this.tasks.update(t.id, { status: 'done' }, 'Apiary'); } catch { /* task changed meanwhile */ } }
    }
  }
  _planFix(plan) {
    this._syncPlanTasks(plan);
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
  async _plan(agent, np0, notes) {
    let np = np0;
    const root = this._planOwner(agent);
    if (!root) { notes.push('Plans belong to projects. For something big, suggest the human creates a project for it.'); return; }
    if (agent.id !== root.id) { notes.push('Only the project lead makes the plan. Tell the lead what you think the plan should include.'); return; }
    let phases = np.phases;
    if (this._needsApproval(agent)) {
      this._setStatus(agent, 'waiting');
      this.emit('event', { type: 'activity', agentId: agent.id, text: 'Waiting for your approval of the plan' });
      const r = await this._ask(agent, { kind: 'plan', title: `${agent.name} proposes a plan with ${np.phases.length} phase${np.phases.length > 1 ? 's' : ''}`, detail: np.goal, phases: np.phases });
      if (r.decision === 'deny') { notes.push(`The human did not approve the plan${r.note ? ': ' + r.note : ''}. Change it and propose it again.`); return; }
      if (r.phases) phases = r.phases;
      if (r.edited) notes.push('The human edited the plan before approving it. Follow the approved version, not your draft.');
      if (r.note) notes.push(`Human note on the plan: ${r.note}`);
    }
    np = { ...np, phases };
    const old = root.plan, now = Date.now();
    root.plan = { goal: np.goal, createdAt: old?.createdAt || now, updatedAt: now, phases: np.phases.map((p, i) => { const prev = old?.phases.find((o) => o.title.toLowerCase() === p.title.toLowerCase()); return { id: i + 1, title: p.title, goal: p.goal, status: prev?.status || 'pending', startedAt: prev?.startedAt, doneAt: prev?.doneAt, steps: p.steps.map((t, k) => { const ps = prev?.steps.find((x) => x.text.toLowerCase() === t.toLowerCase()); return { text: t, done: !!ps?.done, owner: p.owners?.[k] || ps?.owner || '', task: ps?.task, taskId: ps?.taskId }; }) }; }) };
    this._planTasks(root);
    this._planFix(root.plan); this._planDone(root);
    this._msg(root, { role: 'system', text: `Project plan ${old ? 'updated' : 'created'}: ${root.plan.phases.map((p) => p.title).join(' → ')}` });
    this.emit('event', { type: 'agent', agent: root }); this.store.save();
    notes.push('The plan is saved and the human can see it. Every step is now a task with its own ID, shown in the plan. Work phase by phase, give each step to its owner, and report progress with apiary-progress (that closes the step\'s task).');
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
    return stage + `\nPROJECT PLAN (where the project stands: ${st.pct}% done${st.current ? `, now in "${st.current}"` : ''}):\n${plan.goal ? 'Goal: ' + plan.goal + '\n' : ''}` + plan.phases.map((p, i) => `${i + 1}. ${p.title} [${p.status}]${p.note ? ' (' + p.note + ')' : ''}${p.steps.length ? '\n' + p.steps.map((t, j) => `   ${j + 1}. [${t.done ? 'x' : ' '}] ${t.text}${t.task ? ` (${t.task}${t.owner ? ', ' + t.owner : ''})` : ''}`).join('\n') : ''}`).join('\n') + '\nStay inside the current phase. When you finish a step, record it with apiary-progress.\n';
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
  // ----- model nudges: too weak, or stronger than needed -----
  _watch(agent) { return ((this.store.data.modelWatch ||= {})[agent.id] ||= { runs: '', coolUntil: 0 }); }
  noteRun(agent, ok) {
    if (!agent || agent.provider === 'mock') return;
    const w = this._watch(agent); w.runs = (w.runs + (ok ? 'o' : 'b')).slice(-WINDOW);
    this.store.save();
    try { this._modelCheck(agent); } catch { /* a nudge must never break real work */ }
  }
  _roleTier(agent) { return suggestModel({ provider: agent.provider, department: agent.department || '', role: agent.role, models: this._modelList(agent.provider) }).tier; }
  _modelCheck(agent) {
    const w = this._watch(agent), models = this._modelList(agent.provider);
    const j = judge({ runs: w.runs, model: agent.model || '', roleTier: this._roleTier(agent), coolUntil: w.coolUntil || 0 });
    if (!j) return;
    const alreadyAsking = Object.values(this.store.data.approvals).some((r) => r.status === 'pending' && r.kind === 'model' && r.agentId === agent.id);
    if (alreadyAsking) return;
    const name = agent.name, now = agent.model ? agent.model : 'its default model';
    let change, title, detail;
    if (j.direction === 'other-ai') {
      const alt = this._alternate(agent); if (!alt) { w.coolUntil = Date.now() + COOL_MS; this.store.save(); return; }
      change = { provider: alt }; title = `${name} keeps struggling. Try ${plabel(alt)} instead of ${plabel(agent.provider)}?`;
      detail = `${name} has had trouble with several recent jobs, even on the most capable ${plabel(agent.provider)} model. A different AI sometimes does better. It would carry on from the handover note, in a fresh conversation.`;
    } else {
      const to = modelForTier(j.to, agent.provider, models); if (!to || to === agent.model) { w.coolUntil = Date.now() + COOL_MS; this.store.save(); return; }
      change = { model: to };
      if (j.direction === 'up') { title = `${name} may need a stronger model`; detail = `${name} has had trouble with several recent jobs on ${now}. Switching to ${to} usually helps, but it uses more of your ${plabel(agent.provider)} allowance.`; }
      else { title = `${name} can use a cheaper model`; detail = `${name} has done its last 10 jobs smoothly on ${now}, which is more powerful than this kind of work needs. Switching to ${to} would save usage. If the work gets harder, Apiary will suggest going back up.`; }
    }
    w.coolUntil = Date.now() + COOL_MS;
    if (this.modelAutoOn) { this._applyModelChange(agent, change, title, true); return; }
    this._ask(agent, { kind: 'model', title, detail: `${detail}\n\nNothing changes unless you approve. You can let Apiary do this automatically under Settings, Appearance.` })
      .then((r) => { if (r.decision === 'approve') this._applyModelChange(agent, change, title, false); else { this._watch(agent).coolUntil = Date.now() + DECLINED_MS; this.store.save(); } })
      .catch(() => {});
  }
  _applyModelChange(agent, change, title, auto) {
    const w = this._watch(agent);
    if (change.provider) this.setProvider(agent.id, change.provider); else this.setModel(agent.id, change.model);
    w.runs = ''; w.coolUntil = Date.now() + COOL_MS;
    const what = change.provider ? `${plabel(change.provider)}` : change.model;
    this._msg(agent, { role: 'system', text: auto ? `Apiary switched ${agent.name} to ${what} automatically (${title.replace(/\?$/, '')}). Automatic model changes are on, so this can use more or fewer tokens. You can turn it off under Settings, Appearance.` : `${agent.name} now uses ${what}.` });
    this.audit.add('agent', { actor: auto ? 'Apiary (automatic)' : 'You', project: this._pname(agent), action: `${agent.name} now uses ${what}`, detail: title });
    this.store.save();
  }
  setProvider(agentId, provider) {
    const a = this.agents[agentId];
    if (!a) throw httpErr(404, 'No such agent');
    if (!this.available.some((p) => p.id === provider)) throw httpErr(400, 'That AI is not connected');
    const from = a.provider;
    a.provider = provider; a.model = this.defaultModel(provider) || ''; a.sessionId = null; a.method = this.resolveMethod(provider);
    if (from !== provider) { this._msg(a, { role: 'system', text: `${a.name} now runs on ${PROVIDER_LABEL[provider] || provider} instead of ${PROVIDER_LABEL[from] || from}. You changed this by hand.` }); this._log(a, `↪ provider changed by hand: ${from} → ${provider}`); }
    this.emit('event', { type: 'agent', agent: a }); this.store.save();
    return a;
  }
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
    this._watch(a).runs = '';
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
    return this.tasks.add({ title: b.title, notes: b.notes, status: ['todo', 'backburner'].includes(b.status) ? b.status : 'todo', labels: b.labels, project: b.project || null, assignee: this._assignee(b.assignee), images: this.images.resolve(b.images) });
  }
  updateTask(id, b = {}) {
    const patch = { ...b };
    if (patch.images !== undefined) patch.images = this.images.resolve(patch.images);
    if (patch.assignee !== undefined) patch.assignee = this._assignee(patch.assignee);
    return this.tasks.update(id, patch);
  }
  // Hand the task to its agent now.
  startTask(id) {
    const t = this.tasks.get(id), who = (t.assignee && this.agents[t.assignee.id]) || this._ceo();
    if (!who) throw httpErr(409, 'There is no agent to do this yet. Set up your CEO first.');
    if (t.status === 'done') throw httpErr(409, 'This task is already done. Move it back to To do first.');
    if (t.status !== 'inprogress') this.tasks.update(id, { status: 'inprogress', assignee: { id: who.id, name: who.name } }, 'you');
    const prompt = `Task from the board: ${t.title}\n\n${t.notes || '(no more detail given)'}\n\nDo it, or hand it to the right teammate. Keep the task's status up to date with an apiary-task block.${t.images?.length ? `\n\n(${t.images.length === 1 ? 'A picture is' : `${t.images.length} pictures are`} attached to this task.)` : ''}`;
    this.send(who.id, prompt, null, t.images?.length ? { images: t.images } : {}).catch(() => {});
    return { started: true, agent: who.name };
  }
  // Everything that has a short ID, so the page can show each one as a small status chip. Secrets give their name only, never a value.
  refs() {
    const pad = (p, n) => `${p}-${String(n).padStart(4, '0')}`, out = {};
    for (const t of this.tasksView()) {
      const waiting = t.status === 'inprogress' && t.waitingFor?.length;
      out[t.code] = { kind: 'task', id: t.id, title: t.title, state: waiting ? 'waiting' : { done: 'done', blocked: 'blocked', inprogress: 'progress', todo: 'todo', backburner: 'later' }[t.status] || 'todo', label: waiting ? `Waiting for ${t.waitingFor.join(', ')}` : STATUS_LABELS[t.status] || t.status, href: `#/task/${t.id}` };
    }
    for (const t of Object.values(this.tickets.all || {})) {
      out[pad('TK', t.num)] = { kind: 'ticket', id: t.id, title: t.title, state: { open: 'todo', working: 'progress', resolved: 'done', closed: 'done' }[t.status] || 'todo', label: `${t.status[0].toUpperCase()}${t.status.slice(1)}`, href: '#/tickets' };
    }
    this._stampApprovals();
    for (const r of Object.values(this.store.data.approvals)) {
      out[pad('AP', r.num)] = { kind: 'approval', id: r.id, title: r.title || 'Approval', state: { pending: 'waiting', approved: 'done', denied: 'blocked', expired: 'cancelled' }[r.status] || 'todo', label: { pending: 'Waiting for you', approved: 'Approved', denied: 'Blocked', expired: 'Expired' }[r.status] || r.status, href: '#/approvals' };
    }
    if (this.vault.exists) for (const i of this.vault.list()) out[i.code] = { kind: 'secret', id: i.id, title: i.name, state: 'secret', label: 'Secret', href: '#/secrets' };
    return out;
  }
  // Everything the Dashboard page shows, in one call. Names and short titles only; never secrets or command output.
  dashboard() {
    const now = Date.now(), all = this.tasks.list, DAYS = 28 * 864e5;
    const finished = all.filter((t) => t.status === 'done' && t.doneAt && now - t.doneAt < DAYS).map((t) => t.doneAt);
    const helpers = Object.values(this.agents).filter((a) => !this._isProject(a));
    const who = (t) => t.closedBy || t.assignee?.name || '';
    const recent = all.filter((t) => ['done', 'blocked', 'inprogress'].includes(t.status)).sort((a, b) => (b.doneAt || b.updatedAt) - (a.doneAt || a.updatedAt)).slice(0, 8)
      .map((t) => ({ id: t.id, code: t.code, title: t.title, status: t.status, who: who(t), at: t.doneAt || t.updatedAt, project: t.project ? this.agents[t.project]?.name || '' : '', reason: t.status === 'blocked' ? t.reason || '' : '', pics: (t.images || []).length }));
    const projects = Object.values(this.agents).filter((a) => this._isProject(a) && a.kind !== 'general' && this.stageOf(a) !== 'closed').map((p) => {
      const mine = all.filter((t) => t.project === p.id); return { id: p.id, name: p.name, total: mine.length, done: mine.filter((t) => t.status === 'done').length, working: this.tree(p.id).some((id) => this.agents[id]?.status === 'working') };
    }).filter((p) => p.total || p.working).slice(0, 8);
    const offline = this.infra.items.filter((i) => i.state !== 'proposed' && i.status && i.status.ok === false).map((i) => ({ id: i.id, name: i.name, since: i.status.since || i.status.at, detail: i.status.detail || '' }));
    const u = this.usage.summary(7);
    return { now, finished, counts: this.tasks.counts(), agents: { working: helpers.filter((a) => a.status === 'working').length, total: helpers.length }, offline, recent, projects,
      usage: u.providers.filter((p) => p.id !== 'mock').map((p) => ({ id: p.id, today: p.today, week: p.week, daily: p.daily, weekly: p.weekly, pctDay: p.pctDay, pctWeek: p.pctWeek, hitAt: p.hitAt })) };
  }
  tasksView() { return this.tasks.list.map((t) => ({ ...this.tasks.view(t), projectName: t.project ? this.agents[t.project]?.name || '' : '' })); }

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

  // Every piece of work gets a task with its own code. Work handed over by another agent becomes a subtask of
  // the sender's task; when the receiver is done it closes the subtask ("Closed by X. Refer to T-0004") and the
  // sender carries on with the result.
  _openWork(agent, text, from, opts) {
    if (opts.taskId && this.tasks.all[opts.taskId]) {
      const t = this.tasks.all[opts.taskId]; this.curTask.set(agent.id, t.id); opts.onTask?.(t); return { task: t, own: false };
    }
    if (opts.noTask || (from && from.id === 'meeting')) return null;
    const sender = from && this.agents[from.id] ? this.agents[from.id] : null, root = this.rootOf(agent);
    const parent = opts.parent || (sender ? this.curTask.get(sender.id) : null) || null;
    const text0 = this._redact(String(text)), line = text0.replace(/^Task from [^:\n]+:\s*/i, '').split('\n').map((x) => x.trim()).find(Boolean) || 'Request';
    const task = this.tasks.add({ title: clipText(line, 100), notes: text0.slice(0, 4000), status: 'inprogress', assignee: { id: agent.id, name: agent.name }, project: root.kind === 'general' ? null : root.id, source: sender ? sender.name : 'chat', labels: [sender ? 'handover' : 'chat'], parent });
    this.curTask.set(agent.id, task.id); opts.onTask?.(task);
    this.audit.add('task', { actor: sender ? sender.name : 'You', project: this._pname(agent), action: `opened ${task.code} for ${agent.name}`, detail: clipText(line, 100) });
    return { task, own: true };
  }
  _closeWork(w, agent, ok, e) {
    if (!w) return;
    if (this.curTask.get(agent.id) === w.task.id) this.curTask.delete(agent.id);
    if (!w.own) return;
    const t = this.tasks.all[w.task.id]; if (!t || t.status === 'done' || t.status === 'blocked') return;
    const stopped = this.stopped.has(agent.id);
    if (ok && !stopped) { this.tasks.update(t.id, { status: 'done' }, agent.name); this.audit.add('task', { actor: agent.name, project: this._pname(agent), action: `closed ${t.code}`, detail: this.tasks.all[t.id].closure }); }
    else this.tasks.update(t.id, { status: 'blocked', reason: stopped ? 'Stopped' : clipText(e?.message || 'It did not finish', 160) }, 'Apiary');
  }
  async _converse(agent, userText, from, opts = {}) {
    const w = this._openWork(agent, userText, from, opts);
    if (opts.replyTo) this.replyTurns.add(agent.id);
    try { const r = await this._converseRun(agent, userText, from, opts.images); this._closeWork(w, agent, true); return r; }
    catch (e) { this._closeWork(w, agent, false, e); throw e; }
    finally { this.replyTurns.delete(agent.id); }
  }
  async _converseRun(agent, userText, from, images = []) {
    this.stopped.delete(agent.id);
    this._msg(agent, { role: 'user', text: userText, from: from ? { id: from.id, name: from.name } : null, ...(images?.length ? { images } : {}) });
    // A message from a teammate (not the parent handing over a task) is labelled so the agent knows who is asking.
    let prompt = from && from.id !== agent.parentId && from.id !== 'meeting' ? `Message from teammate ${from.name}:\n\n${userText}` : userText, final = '';
    try {
      for (let round = 0; round <= this.limits.maxRounds; round++) {
        const raw = await this._exec(agent, prompt, round === 0 ? images : []);
        const mem = parseRemember(raw);
        if (this.memoryEnabled) for (const n of mem.notes) this.memory.add({ kind: 'note', text: this._redact(n.text), who: agent.name, agent: n.scope === 'agent' ? this._mkey(agent) : null, project: n.scope === 'project' ? this._pkey(agent) : null });
        const { clean, spawns, sends, assigns, hires, secrets, newSecrets, tasks, plans, progress, infra, runbooks, errors } = parseSpawns(mem.clean);
        final = clean || final;
        if (clean) this._msg(agent, { role: 'agent', text: clean });
        if (tasks.length) this._agentTasks(agent, tasks);
        if (infra.length) this._infra(agent, infra);
        for (const rb of runbooks) { try { const r = this.runbooks.propose(agent.name, this._pname(agent), rb); this._msg(agent, { role: 'system', text: `Saved the runbook "${r.title}" as a draft for you to review (Runbooks page).` }); } catch (e) { this._msg(agent, { role: 'system', text: `Runbook not saved: ${e.message}`, error: true }); } }
        const planNotes = [];
        if (plans.length) await this._plan(agent, plans.at(-1), planNotes);
        if (progress.length) this._progress(agent, progress, planNotes);
        if ((!spawns.length && !sends.length && !assigns.length && !hires.length && !secrets.length && !newSecrets.length && !errors.length && !plans.length) || round === this.limits.maxRounds) break;

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
        if (newSecrets.length) await this._newSecret(agent, newSecrets, notes);
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
        if (reports.length) body += 'Reports from your sub-agents:\n\n' + reports.map((r) => `### ${r.name}${this._codeNote(r.code)}\n${r.text}`).join('\n\n');
        if (replies.length) body += (body ? '\n\n' : '') + 'Replies from teammates:\n\n' + replies.map((r) => `### ${r.name}${this._codeNote(r.code)}\n${r.text}`).join('\n\n');
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
  tag(agentId, text, images = []) {
    const me = this.agents[agentId];
    if (!me) throw httpErr(404, 'No such agent');
    const { found, problems, clean, rest } = this.findMentions(String(text), this.mentionables(agentId));
    if (problems.length) throw httpErr(400, problems[0]);
    if (!found.length) { this.send(agentId, text, null, images.length ? { images } : {}).catch(() => {}); return { tagged: [] }; }
    if (!rest.replace(/[\s,;:.!?-]/g, '')) throw httpErr(400, `Say what ${found.map((f) => f.name).join(' and ')} should do, for example "@${found[0].name} please look at this".`);
    for (const t of found) {
      const peer = this.agents[t.id], rt = this.rootOf(peer);
      if (rt.kind !== 'general' && this.stageOf(rt) === 'closed') throw httpErr(409, `${peer.name}'s project is closed. Reopen it (Projects page) first.`);
    }
    this._msg(me, { role: 'user', text: String(text), ...(images.length ? { images } : {}) });
    const also = found.length > 1 ? `\n\n(The same message was sent to: ${found.map((f) => f.name).join(', ')}.)` : '';
    for (const t of found) {
      this._msg(me, { role: 'system', text: `Sent to ${t.name}`, agentId: t.id });
      this.send(t.id, clean + also, null, images.length ? { images } : {}).then(
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
  // A message to a teammate. Nobody's turn waits for anybody: the message is delivered, and a reply (when asked for)
  // comes back to the sender as a new message in its own chat, so people can talk freely in any direction.
  // Agent-to-agent messages are limited per project per hour, so agents can keep talking but cannot run away.
  _peerAllowed(root) {
    const now = Date.now(), recent = (this.peerLog.get(root) || []).filter((t) => now - t < 3600000);
    this.peerLog.set(root, recent);
    return recent.length < this.limits.maxPeerMessages;
  }
  _peerCounted(root) { this.peerLog.set(root, [...(this.peerLog.get(root) || []), Date.now()]); }
  _peerLimitNote(agent) {
    const text = `This project has reached its limit of ${this.limits.maxPeerMessages} agent-to-agent messages in the last hour, so agents cannot message each other until it clears. You can still message agents yourself.`;
    const last = this.messages(agent.id).at(-1);
    if (!last || last.text !== text) this._msg(agent, { role: 'system', text });
    return text;
  }
  async _peerJob(agent, m, notes) {
    const root = this.rootOf(agent).id;
    if (!this._peerAllowed(root)) { notes.push(`Message to "${m.to}" not sent. ${this._peerLimitNote(agent)}`); return null; }
    const { peer, error } = await this._findPeer(agent, m.to);
    if (error) { notes.push(error); return null; }
    if (peer.id === agent.id) { notes.push('You cannot message yourself.'); return null; }
    this._peerCounted(root);
    this._msg(agent, { role: 'system', text: `${m.wait ? 'Asked' : 'Told'} ${peer.name}: ${m.text.slice(0, 160)}${m.text.length > 160 ? '…' : ''}`, agentId: peer.id });
    const proj = this._isProject(this.rootOf(agent)) && this.rootOf(peer).id !== this.rootOf(agent).id ? this.rootOf(agent) : null;
    // A reply cannot start another reply: a turn that began with a teammate's reply sends without waiting for an answer.
    const wait = m.wait && !this.replyTurns.has(agent.id);
    if (m.wait && !wait) notes.push(`Sent to ${peer.name} without waiting: a reply from a teammate cannot start another reply. Ask the person if you need an answer.`);
    const sent = this._onProject(peer.id, proj, () => this.send(peer.id, m.text, agent)).then((text) => text || '(no reply)', (e) => `(no reply: ${e.message})`);
    if (wait) {
      notes.push(`Sent to ${peer.name}. Their reply will come to you as a new message, so carry on with other work meanwhile.`);
      sent.then((text) => this._replyBack(agent, peer, text));
    } else {
      notes.push(`Message delivered to ${peer.name} (no reply awaited).`);
    }
    return null;
  }
  // Puts a teammate's reply into the asker's chat as a new message, so the asker picks it up on its next turn.
  _replyBack(asker, peer, text) {
    return this.send(asker.id, `Reply from ${peer.name} to your message:\n\n${text}`, peer, { replyTo: true }).catch(() => {});
  }
  _codeNote(code) { if (!code) return ''; const t = this.tasks.byCode(code); return ` (${code}${t?.status === 'done' ? ', closed' : t?.status === 'blocked' ? ', blocked' : ''})`; }
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
      let code = '';
      try { const text = await this.send(child.id, spec.task, parent, { onTask: (t) => { code = t.code; } }); return { name: child.name, code, text: text || '(no output)', child }; }
      catch (e) { return { name: child.name, code, text: `FAILED: ${e.message}`, child }; }
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
    const task = this.tasks.add({ title: clipText(a.task, 100), notes: a.task, status: 'inprogress', assignee: { id: worker.id, name: worker.name }, project: this.rootOf(lead).id, source: 'system', labels: [worker.department || 'team', 'handover'], parent: this.curTask.get(lead.id) || null });
    this.audit.add('task', { actor: lead.name, project: this._pname(lead), action: `handed ${task.code} to ${worker.name}`, detail: clipText(a.task, 100) });
    const finish = (text) => {
      this.waitingOn.get(lead.id)?.delete(worker.id);
      const ok = !/^\W*(NOT STARTED|FAILED)/i.test(text || '');
      try { this.tasks.update(task.id, { status: ok ? 'done' : 'blocked', reason: ok ? '' : clipText(text, 160) }, ok ? worker.name : 'Apiary'); if (ok) this.audit.add('task', { actor: worker.name, project: this._pname(lead), action: `closed ${task.code}`, detail: this.tasks.all[task.id]?.closure || '' }); } catch { /* task removed meanwhile */ }
      return { kind: 'report', name: worker.name, code: task.code, text };
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
        try { r = await this._onProject(adv.id, projRoot, () => this.send(adv.id, `Prerequisite for ${worker.name}'s task (do this now, before ${worker.name} starts):\n${c.prerequisites.map((p) => '- ' + p).join('\n')}\n\nThe task is:\n${a.task}\n\nWhen finished, begin your reply with DONE or FAILED.`, worker, { parent: task.id })); }
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
      const text = await this._onProject(worker.id, projRoot, () => this.send(worker.id, prompt, lead, { taskId: task.id }));
      let note = '';
      if (lead.git && worker.branch) { note = (await this._mergeResolving(lead, worker, projRoot, task)).note; await this._sync(lead, worker); }
      let final = text, reviewTxt = '';
      if (this.reviewWork && !/^\W*(NOT STARTED|FAILED)/i.test(text || '')) {
        const rv = await this._reviewLoop({ lead, worker, roster, task, a, projRoot, text });
        final = rv.text; reviewTxt = rv.summary ? `\n\nReview:\n${rv.summary}` : '';
        if (rv.failed) return finish(`FAILED REVIEW. ${rv.reviewer.name} still asks for changes after two rounds: ${clipText(rv.notes, 300)}\n\nThe work so far:\n${final || '(no output)'}${note}${reviewTxt}\nDecide whether to change the task, try another teammate, or ask the human.`);
      }
      return finish(`${final || '(no output)'}${note}${reviewTxt}\n\nPre-check results:\n${summary.join('\n') || '(none)'}${done.length ? '\nPrerequisites done first:\n' + done.join('\n') : ''}`);
    } catch (e) {
      this.waitingOn.get(lead.id)?.delete(worker.id);
      if (e.name === 'AbortError') throw e;
      return finish(`FAILED: ${e.message}`);
    }
  }

  // The assignee asks one teammate for a verdict on the task. Unclear or missing replies are reported as such, never silently approved.
  // ----- review: another teammate checks finished work; changes are sent back to the worker with notes, twice at most -----
  _pickReviewer(roster, worker) {
    const others = roster.filter((m) => m.id !== worker.id && m.consult !== false);
    return others.find((m) => /review|qa\b|quality|test|editor|audit|check/i.test(`${m.title || ''} ${m.role || ''} ${m.department || ''}`)) || others[0] || null;
  }
  _taskNote(task, text) { const t = this.tasks.all[task.id]; if (!t) return; t.log.push({ at: Date.now(), text }); t.updatedAt = Date.now(); this.store.save(); }
  async _reviewLoop({ lead, worker, roster, task, a, projRoot, text }) {
    const reviewer = this._pickReviewer(roster, worker); if (!reviewer) return { text, summary: '', failed: false };
    const root = this.rootOf(worker).id, lines = [];
    for (let round = 1; round <= 2; round++) {
      if (this.stopped.has(lead.id)) throw Object.assign(new Error('stopped'), { name: 'AbortError' });
      if (!this._peerAllowed(root)) { lines.push('Review skipped: the project reached its limit of agent-to-agent messages this hour.'); this._peerLimitNote(worker); return { text, summary: lines.join('\n'), failed: false }; }
      if (this._wouldDeadlock(worker.id, reviewer.id)) { lines.push(`Review skipped: ${reviewer.name} is waiting on ${worker.name}.`); return { text, summary: lines.join('\n'), failed: false }; }
      this._peerCounted(root); this._edge(worker.id, reviewer.id);
      this._msg(lead, { role: 'system', text: `${reviewer.name} is reviewing ${worker.name}'s work on ${task.code}${round > 1 ? ' (round 2)' : ''}`, agentId: reviewer.id });
      if (lead.git && reviewer.branch) await this._sync(lead, reviewer);
      const prompt = `Review requested by ${lead.name} for ${worker.name}'s work on ${task.code}${round > 1 ? ` (this is round ${round}: ${worker.name} changed things after your notes)` : ''}.\n\nThe task was:\n${a.task}\n\n${worker.name}'s report:\n${clipText(text, 3000)}\n\nCheck the actual work, not only the report. Do not change anything yourself. Reply in this shape:\nVERDICT: PASS or CHANGES NEEDED\nNOTES: what is good, or exactly what must change (short and specific)`;
      let out;
      try { out = await this._onProject(reviewer.id, projRoot, () => this.send(reviewer.id, prompt, lead)); }
      catch (e) { if (e.name === 'AbortError') throw e; lines.push(`Review could not be done (${e.message}).`); return { text, summary: lines.join('\n'), failed: false }; }
      finally { this.waitingOn.get(worker.id)?.delete(reviewer.id); }
      const r = parseReview(out);
      this._taskNote(task, `Review round ${round} by ${reviewer.name}: ${r.verdict === 'PASS' ? 'passed' : r.verdict === 'CHANGES' ? 'changes needed' : 'no clear verdict'}${r.notes ? ' - ' + clipText(r.notes, 200) : ''}`);
      lines.push(`Round ${round}, ${reviewer.name}: ${r.verdict === 'PASS' ? 'passed' : r.verdict === 'CHANGES' ? 'changes needed: ' + r.notes : 'no clear verdict, so it was accepted'}`);
      if (r.verdict === 'CHANGES') this.noteRun(worker, false);
      if (r.verdict !== 'CHANGES') return { text, summary: lines.join('\n'), failed: false, reviewer };
      if (round === 2) return { text, summary: lines.join('\n'), failed: true, notes: r.notes, reviewer };
      this._msg(lead, { role: 'system', text: `${reviewer.name} asked ${worker.name} for changes on ${task.code}: ${clipText(r.notes, 200)}`, agentId: worker.id });
      text = await this._onProject(worker.id, projRoot, () => this.send(worker.id, `${reviewer.name} reviewed your work on ${task.code} and asked for changes:\n\n${r.notes}\n\nMake these changes now. Reply with what you changed.`, lead, { taskId: task.id }));
      if (lead.git && worker.branch) { await this._mergeChild(lead, worker, true); await this._sync(lead, worker); }
    }
    return { text, summary: lines.join('\n'), failed: false };
  }
  async _consult(worker, adv, task) {
    const root = this.rootOf(worker).id;
    const res = { adviser: adv, verdict: 'NO ANSWER', reason: '', prerequisites: [] };
    if (!this._peerAllowed(root)) { res.reason = 'not consulted: the project reached its limit of agent-to-agent messages this hour'; this._peerLimitNote(worker); return res; }
    if (this._wouldDeadlock(worker.id, adv.id)) { res.reason = `not consulted: ${adv.name} is waiting on ${worker.name}`; return res; }
    this._peerCounted(root);
    this._edge(worker.id, adv.id);
    this._msg(worker, { role: 'system', text: `Asked ${adv.name} for a pre-check`, agentId: adv.id });
    try {
      const text = await this.send(adv.id, `Pre-check requested by ${worker.name} before they start this task:\n\n${task}\n\nLook at it from your area (${adv.role || adv.name}). Do no work yet. Reply in this shape:\nVERDICT: GO | CONDITIONS | BLOCK\nREASON: one or two sentences\nPREREQUISITE: something that must be done first, before ${worker.name} starts (one line per item, only with CONDITIONS)`, worker, { noTask: true });
      Object.assign(res, parseVerdict(text));
    } catch (e) { res.reason = `could not be consulted (${e.message})`; }
    finally { this.waitingOn.get(worker.id)?.delete(adv.id); }
    return res;
  }

  // Bring the lead's latest work into a member's checkout (best effort; a conflict is aborted and logged).
  _sync(lead, member) { return this._lock(`merge:${lead.id}`, () => this._syncNow(lead, member)); }
  async _syncNow(lead, member) {
    try {
      const r = await git.merge(member.cwd, lead.git.branch);
      if (!r.ok) this._log(member, `! could not bring in the lead's latest work (conflicts in ${r.conflicts.join(', ') || 'some files'})`);
    } catch (e) { this._log(member, `! sync failed: ${e.message}`); }
  }

  // Bring a child's branch into its parent's. A conflict is aborted and reported, never left half-done.
  async _mergeChild(parent, child, keep = false) { return (await this._mergeChildR(parent, child, keep)).note; }
  // Merges into one lead's branch go through a queue, one at a time in the order they finish, so parallel workers never collide.
  _mergeChildR(parent, child, keep = false) { return this._lock(`merge:${parent.id}`, () => this._mergeChildNow(parent, child, keep)); }
  // Merge a worker's branch; if it conflicts, ask the worker to bring the lead's latest work in and fix the clash, then merge once more.
  async _mergeResolving(lead, worker, projRoot, task) {
    let r = await this._mergeChildR(lead, worker, true);
    if (r.ok || !r.conflicts?.length || this.stopped.has(lead.id)) return r;
    const files = r.conflicts.join(', ');
    this._taskNote(task, `Merge conflict in ${files}: ${worker.name} is asked to resolve it`);
    this._msg(lead, { role: 'system', text: `${worker.name}'s work clashes with the lead's branch (${files}). ${worker.name} is resolving it.`, agentId: worker.id });
    try {
      await this._onProject(worker.id, projRoot, () => this.send(worker.id, `Your work on ${task.code} conflicts with the lead's latest work (branch ${lead.git.branch}) in: ${files}.\n\nBring the lead's work into your checkout (git merge ${lead.git.branch}), resolve the conflicts so both pieces of work are kept, and commit. Reply with what you did.`, lead, { taskId: task.id }));
    } catch (e) { if (e.name === 'AbortError') throw e; }
    const again = await this._mergeChildR(lead, worker, true);
    this._taskNote(task, again.ok ? `Conflict in ${files} resolved and merged` : `Conflict in ${files} was not resolved`);
    return { ...again, note: (r.note || '') + again.note };
  }
  async _mergeChildNow(parent, child, keep = false) {
    const parentBranch = parent.git.branch;
    let note, merge = true, mergeOk = false, conflicts = [];
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
      const res = await git.merge(parent.cwd, child.branch); mergeOk = !!res.ok; conflicts = res.conflicts || [];
      if (res.ok) note = (note || '') + `\n\n(Apiary merged ${child.name}'s changes into your branch.)`;
      else note = (note || '') + `\n\n(Apiary could NOT merge ${child.name}'s branch ${child.branch} into yours${res.conflicts.length ? `: conflicts in ${res.conflicts.join(', ')}` : ''}. Nothing was merged; the branch is kept. Resolve this yourself or ask the human.)`;
      this._log(parent, res.ok ? `✔ merged ${child.branch} into ${parentBranch}` : `! merge conflict with ${child.branch}`);
    } else this._log(parent, `✘ merge of ${child.branch} declined`);
    if (!keep) await this._lock(parent.git.repo, () => git.worktreeRemove(parent.git.repo, child.cwd)).catch(() => {});
    return { note, ok: mergeOk, conflicts };
  }
}

// A plan as phases of steps. Each step has a text and, optionally, the name of the teammate who does it.
export function cleanPhases(list) {
  const out = [];
  for (const p of [].concat(list || []).slice(0, 12)) {
    const title = String(p?.title || '').trim().slice(0, 80); if (!title) continue;
    const raw = [].concat(p.steps || []).map((x, i) => ({ text: String(typeof x === 'string' ? x : x?.text || '').trim().slice(0, 160), owner: String(typeof x === 'string' ? (p.owners || [])[i] || '' : x?.owner || (p.owners || [])[i] || '').trim().slice(0, 40) })).filter((x) => x.text).slice(0, 15);
    out.push({ title, goal: String(p.goal || '').slice(0, 300), steps: raw.map((x) => x.text), owners: raw.map((x) => x.owner) });
  }
  return out;
}
export function parseSpawns(reply) {
  const newSecrets = [], spawns = [], sends = [], assigns = [], hires = [], secrets = [], tasks = [], plans = [], progress = [], infra = [], runbooks = [], errors = [];
  reply = reply.replace(PLAN_RE, (_, body) => {
    try {
      const o = JSON.parse(body.trim()), ph = cleanPhases(o.phases);
      if (!ph.length) errors.push('An apiary-plan block needs "phases", each with a "title".');
      else plans.push({ goal: String(o.goal || '').slice(0, 400), phases: ph });
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
  reply = reply.replace(NEWSECRET_RE, (_, body) => {
    try {
      for (const x of [].concat(JSON.parse(body.trim()))) {
        if (!x || !String(x.name || '').trim()) { errors.push('An apiary-newsecret block needs a "name".'); continue; }
        if (['value', 'password', 'token', 'key', 'secret'].some((k) => k in x)) { errors.push(`Never put the value in an apiary-newsecret block. Ask to save "${x.name}" without it: the person types the value on the Approvals page.`); continue; }
        newSecrets.push({ name: String(x.name).trim().slice(0, 80), type: ['login', 'token', 'ssh'].includes(x.type) ? x.type : 'login', username: String(x.username || '').slice(0, 200), host: String(x.host || '').slice(0, 200), port: x.port, auth: x.auth === 'key' ? 'key' : 'password', why: String(x.why || '').slice(0, 300) });
      }
    } catch (err) { errors.push(`An apiary-newsecret block was not valid JSON (${err.message}).`); }
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
        hires.push({ name: h.name ? String(h.name) : '', title: h.title, role: h.role, department: h.department, reason: h.reason, instructions: h.instructions, guardrails: h.guardrails, provider: h.provider, reportsTo: h.reportsTo, complexity: h.complexity });
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
  return { clean, spawns, sends, assigns, hires, secrets, newSecrets, tasks, plans, progress, infra, runbooks, errors };
}

const clipText = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// Reads the VERDICT / REASON / PREREQUISITE lines of a pre-check reply.
// A reviewer answers "VERDICT: PASS" or "VERDICT: CHANGES NEEDED" with NOTES saying what must change.
export function parseReview(text) {
  const t = String(text || '');
  const v = /^\W*VERDICT\W*(PASS(?:ED)?|CHANGES(?:\s+NEEDED)?)\b/im.exec(t);
  const m = /^\W*NOTES?\W*([\s\S]+)$/im.exec(t), notes = (m ? m[1] : '').trim().slice(0, 1200);
  if (!v) return { verdict: 'UNCLEAR', notes: clipText(t, 300) };
  return { verdict: /^PASS/i.test(v[1]) ? 'PASS' : 'CHANGES', notes };
}
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
