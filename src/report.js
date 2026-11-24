// Weekly report: a plain-English summary of the week, plus how many tokens were used compared with last week.
// Built from Apiary's own records (no AI call, so writing it costs nothing). Saved so past weeks stay readable.
import { dayKey } from './usage.js';
import { lastDue } from './backup.js';

const DAY = 86400000;
const DEFAULTS = { enabled: false, weekday: 1, time: '08:00', telegram: false };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n));
const err = (status, message) => Object.assign(new Error(message), { status });
const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

export class Reports {
  constructor(engine) { this.engine = engine; this.running = false; }
  get st() { return (this.engine.store.data.settings.report ||= {}); }
  get config() { return { ...DEFAULTS, ...(this.st.config || {}) }; }
  get all() { return (this.engine.store.data.reports ||= []); }
  setConfig(b = {}) {
    const c = { ...this.config };
    if (b.enabled !== undefined) c.enabled = !!b.enabled;
    if (b.telegram !== undefined) c.telegram = !!b.telegram;
    if (b.weekday !== undefined) { const n = Number(b.weekday); if (!Number.isInteger(n) || n < 0 || n > 6) throw err(400, 'Pick a day of the week'); c.weekday = n; }
    if (b.time !== undefined) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.time))) throw err(400, 'Type the time like 08:00'); c.time = b.time; }
    this.st.config = c; this.engine.store.save(); return c;
  }
  list() { return this.all.map(({ id, createdAt, weekStart, weekEnd }) => ({ id, createdAt, weekStart, weekEnd })).sort((a, b) => b.createdAt - a.createdAt); }
  get(id) { const r = this.all.find((x) => x.id === id); if (!r) throw err(404, 'No such report'); return r; }

  // Tokens per week for `n` weeks ending with the 7 days that end on `endDay` (a local midnight timestamp).
  weeks(endDay, n = 8) {
    const u = this.engine.usage, out = [];
    for (let k = n - 1; k >= 0; k--) {
      const last = endDay - k * 7 * DAY, first = last - 6 * DAY, byProvider = {}, byAgent = {};
      for (let t = first; t <= last; t += DAY) {
        const day = u.d.days[dayKey(t + 3600000)];   // +1h so a daylight-saving change cannot slip the day
        if (!day) continue;
        for (const [p, v] of Object.entries(day.providers)) byProvider[p] = (byProvider[p] || 0) + v.input + v.output;
        for (const [id, a] of Object.entries(day.agents)) { const x = (byAgent[id] ||= { name: a.name, provider: a.provider, tokens: 0 }); x.name = a.name; x.tokens += a.input + a.output; }
      }
      const hits = u.limitHits().filter((h) => h.t >= first && h.t < last + DAY);
      out.push({ start: first, end: last, total: Object.values(byProvider).reduce((a, b) => a + b, 0), byProvider, byAgent, limitHit: [...new Set(hits.map((h) => h.provider))] });
    }
    return out;
  }

  build(end = Date.now()) {
    const e = this.engine, endDay = dayStart(end), start = end - 7 * DAY;
    const weeks = this.weeks(endDay), cur = weeks[weeks.length - 1], prev = weeks[weeks.length - 2];
    const roots = Object.values(e.agents).filter((a) => !a.parentId && a.kind !== 'general');
    const tasks = e.tasks.list, inWeek = (t) => t && t >= start && t <= end;
    const doneTasks = tasks.filter((t) => t.status === 'done' && inWeek(t.doneAt));
    const stuck = tasks.filter((t) => t.status === 'blocked' || (t.status === 'inprogress' && t.updatedAt < end - 7 * DAY));
    const moved = [], nextPlan = [];
    for (const r of roots) {
      const ph = r.plan?.phases || [], finished = ph.filter((p) => inWeek(p.doneAt));
      const total = ph.reduce((n, p) => n + (p.steps.length || 1), 0) || 0, done = ph.reduce((n, p) => n + (p.steps.length ? p.steps.filter((x) => x.done).length : p.status === 'done' ? 1 : 0), 0);
      const pct = total ? Math.round((done / total) * 100) : null, active = ph.find((p) => p.status === 'active' || p.status === 'blocked');
      if (finished.length || ph.some((p) => inWeek(p.startedAt))) moved.push({ project: r.name, finished: finished.map((p) => p.title), current: active?.title || null, pct });
      if (e.stageOf(r) === 'building' && active) nextPlan.push({ project: r.name, phase: active.title, steps: active.steps.filter((x) => !x.done).slice(0, 3).map((x) => x.text), blocked: active.status === 'blocked' });
    }
    const approvals = e.approvals(), pending = approvals.filter((a) => a.status === 'pending'), decided = approvals.filter((a) => a.status !== 'pending' && inWeek(a.decidedAt));
    const warnings = e.health.state.items.filter((i) => i.level === 'warn' || i.level === 'err').map((i) => i.title);
    const down = e.infra.items.filter((i) => i.status && !i.status.ok).map((i) => i.name);
    const open = tasks.filter((t) => t.status === 'todo' || t.status === 'inprogress');
    const change = prev && prev.total ? Math.round(((cur.total - prev.total) / prev.total) * 100) : null;
    const topAgents = Object.values(cur.byAgent).sort((a, b) => b.tokens - a.tokens).slice(0, 5);
    const lines = [];
    lines.push(`Week ${new Date(start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} to ${new Date(end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.`);
    lines.push(moved.length ? `Progress: ${moved.map((m) => `${m.project}${m.finished.length ? ' finished ' + m.finished.join(', ') : ' started a new phase'}${m.current ? `, now on ${m.current}` : ''}${m.pct !== null ? ` (${m.pct}% done)` : ''}`).join('; ')}.` : 'Progress: no project moved to a new phase this week.');
    lines.push(`Tasks: ${plural(doneTasks.length, 'task')} finished${stuck.length ? `, ${plural(stuck.length, 'task')} stuck or blocked` : ', none stuck'}.`);
    lines.push(`Approvals: ${pending.length ? `${plural(pending.length, 'request')} waiting for you` : 'nothing waiting for you'}${decided.length ? `, ${decided.length} answered this week` : ''}.`);
    lines.push(warnings.length ? `Health: ${plural(warnings.length, 'warning')}: ${warnings.join('; ')}.` : 'Health: no warnings.');
    lines.push(down.length ? `Servers down: ${down.join(', ')}.` : e.infra.items.length ? 'Servers: all answering.' : 'Servers: none on the map yet.');
    lines.push(cur.total ? `Tokens used: ${fmt(cur.total)} this week${prev?.total ? `, ${change >= 0 ? 'up' : 'down'} ${Math.abs(change)}% from ${fmt(prev.total)} last week` : ''}.${cur.limitHit.length ? ` A usage limit was hit (${cur.limitHit.join(', ')}).` : ''}` : 'Tokens used: none recorded this week.');
    lines.push(nextPlan.length ? `Next week: ${nextPlan.map((n) => `${n.project} continues ${n.phase}${n.steps.length ? ` (${n.steps.join('; ')})` : ''}${n.blocked ? ' [blocked]' : ''}`).join('. ')}.` : `Next week: ${open.length ? plural(open.length, 'open task') + ' on the board' : 'nothing planned yet'}.`);
    return {
      weekStart: start, weekEnd: end, summary: lines,
      stats: { tasksDone: doneTasks.map((t) => t.title), tasksStuck: stuck.map((t) => t.title), moved, approvalsPending: pending.length, approvalsAnswered: decided.length, warnings, down, nextPlan, openTasks: open.length },
      usage: { thisWeek: cur.total, lastWeek: prev?.total || 0, changePct: change, byProvider: cur.byProvider, lastByProvider: prev?.byProvider || {}, topAgents, weeks: weeks.map(({ start, total, byProvider, limitHit }) => ({ start, total, byProvider, limitHit })) },
    };
  }

  async generate({ at = Date.now(), reason = 'manual' } = {}) {
    const e = this.engine, r = { id: Math.random().toString(36).slice(2, 10), createdAt: Date.now(), reason, ...this.build(at) };
    this.all.unshift(r); this.all.length = Math.min(this.all.length, 26);
    this.st.lastRun = Math.max(this.st.lastRun || 0, reason === 'schedule' ? at : this.st.lastRun || 0);
    e.store.save(); e.emit('event', { type: 'report' });
    e.audit?.add('system', { actor: reason === 'schedule' ? 'Schedule' : 'You', action: 'weekly report made' });
    if (reason === 'schedule' && this.config.telegram) e.telegram?.alert(this.digest(r)).catch(() => {});
    return r;
  }
  // A short version for Telegram: counts and token totals only, no titles of tasks or files.
  digest(r) {
    const s = r.stats, u = r.usage;
    return `📋 Weekly report: ${plural(s.tasksDone.length, 'task')} finished, ${s.tasksStuck.length} stuck, ${s.approvalsPending} approval${s.approvalsPending === 1 ? '' : 's'} waiting, ${plural(s.warnings.length, 'health warning')}, ${s.down.length} server${s.down.length === 1 ? '' : 's'} down. Tokens: ${fmt(u.thisWeek)}${u.changePct !== null ? ` (${u.changePct >= 0 ? '+' : ''}${u.changePct}% vs last week)` : ''}. Open Apiary > Weekly report.`;
  }
  async tick(now = new Date()) {
    const c = this.config;
    if (!c.enabled || this.running) return null;
    const due = lastDue({ every: 'weekly', time: c.time, weekday: c.weekday }, now);
    if ((this.st.lastRun || 0) >= due.getTime()) return null;
    this.running = true;
    try { return await this.generate({ at: due.getTime(), reason: 'schedule' }); } catch { return null; } finally { this.running = false; }
  }
}
