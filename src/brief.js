// The morning brief: one short, plain-words summary of the last 24 hours and what needs you now.
// It only reads what Apiary already knows. Nothing here changes anything.
import { dayKey } from './usage.js';

const DAY = 86400000, cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function buildBrief(engine, now = Date.now()) {
  const since = now - DAY, sections = [];
  const add = (id, title, tone, items) => { if (items.length) sections.push({ id, title, tone, items }); };

  // What needs you right now
  const pending = engine.approvals().filter((a) => a.status === 'pending');
  const warns = (engine.health?.state?.items || []).filter((i) => i.level === 'warn' || i.level === 'err');
  const down = engine.infra.items.filter((d) => d.state !== 'proposed' && d.status && d.status.ok === false);
  const needs = [
    ...pending.slice(0, 5).map((a) => `Approval waiting: ${cut(a.title || 'a request', 90)}`), pending.length > 5 ? `and ${pending.length - 5} more approvals` : '',
    ...down.slice(0, 5).map((d) => `${d.name} is not reachable`), down.length > 5 ? `and ${down.length - 5} more devices are down` : '',
    ...warns.slice(0, 4).map((w) => `Health: ${cut(w.title, 90)}`),
  ].filter(Boolean);
  add('needs', 'Needs you', 'warn', needs);

  // Devices that came back on their own
  const back = engine.infra.items.filter((d) => d.status?.ok && d.status.since >= since && d.status.since < now - 60000 && d.trouble);
  add('devices', 'Devices', 'info', back.map((d) => `${d.name} is back up`));

  // Work finished and still open
  const tasks = engine.tasks.list, done = tasks.filter((t) => t.doneAt && t.doneAt >= since && !t.parent);
  const open = tasks.filter((t) => t.status !== 'done' && !t.parent);
  const work = done.slice(0, 6).map((t) => `${t.assignee?.name || 'Someone'} finished: ${cut(t.title, 90)}`);
  if (done.length > 6) work.push(`and ${done.length - 6} more tasks`);
  if (open.length) work.push(`${plural(open.length, 'task is', 'tasks are')} still open`);
  add('work', 'Work', 'ok', work);

  // Things Apiary did
  const a = (kind) => engine.audit.search({ from: since, kind, limit: 1 }).total;
  const saved = a('commit'), infra = engine.audit.search({ from: since, kind: 'infra', limit: 500 }).items.filter((e) => /repair|started/.test(e.action)).length;
  const did = [saved ? `${plural(saved, 'change was', 'changes were')} saved to repositories` : '', infra ? `${plural(infra, 'repair was', 'repairs were')} run on devices` : ''].filter(Boolean);
  add('did', 'What Apiary did', 'info', did);

  // AI used yesterday
  const used = engine.usage.d.days[dayKey(now - DAY)]?.providers || {}, name = (p) => (p === 'claude' ? 'Claude Code' : p === 'codex' ? 'Codex' : p);
  add('ai', 'AI used yesterday', 'info', Object.entries(used).map(([p, u]) => `${name(p)}: ${fmtTok((u.input || 0) + (u.output || 0))} tokens${u.estimated ? ' (estimate)' : ''}`));

  const calm = !needs.length;
  const headline = calm ? 'All quiet. Nothing needs you right now.' : `${plural(pending.length + down.length + warns.length, 'thing needs', 'things need')} you.`;
  const date = new Date(now).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const short = [`☀️ Morning brief, ${date}`, headline, ...needs.slice(0, 3).map((x) => `• ${x}`), done.length ? `${plural(done.length, 'task', 'tasks')} finished in the last day.` : ''].filter(Boolean).join('\n');
  return { at: now, day: dayKey(now), date, headline, calm, sections, short };
}

export const briefSettings = (store) => ({ enabled: false, time: '07:30', telegram: true, ...(store.data.settings.brief || {}) });

// Called every minute. Sends at most one brief a day, and a restart never repeats it (the day is saved).
export async function briefTick(engine, now = new Date()) {
  const s = briefSettings(engine.store), d = engine.store.data;
  if (!s.enabled || d.briefLast === dayKey(now.getTime())) return null;
  const [h, m] = s.time.split(':').map(Number); if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return null;
  d.briefLast = dayKey(now.getTime());
  return deliver(engine, now.getTime(), s.telegram);
}

export async function deliver(engine, at = Date.now(), telegram = false) {
  const b = buildBrief(engine, at), list = (engine.store.data.briefs ||= []);
  list.unshift(b); list.length = Math.min(list.length, 14); engine.store.save();
  engine.emit('event', { type: 'brief' });
  if (telegram) { try { await engine.telegram.alert(b.short); } catch { /* Telegram is optional */ } }
  return b;
}

export function setBrief(engine, body = {}) {
  const cur = briefSettings(engine.store), s = (engine.store.data.settings.brief ||= {}), bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (body.time !== undefined) { if (!TIME_RE.test(String(body.time))) throw bad('Use a time like 07:30'); s.time = String(body.time); }
  if (body.telegram !== undefined) s.telegram = !!body.telegram;
  if (body.enabled !== undefined) {
    s.enabled = !!body.enabled;
    // Turning it on after today's time has passed means the first brief is tomorrow, not a surprise right now.
    if (s.enabled && !cur.enabled) { const n = new Date(), [h, m] = (s.time || cur.time).split(':').map(Number); if (n.getHours() * 60 + n.getMinutes() >= h * 60 + m) engine.store.data.briefLast = dayKey(n.getTime()); }
  }
  engine.store.save(); return briefSettings(engine.store);
}
