// Token usage: how much each agent and each AI has used, per day.
// Real numbers are used when the AI reports them; otherwise a rough estimate (about 4 characters per token).
const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const estimateTokens = (...texts) => Math.max(1, Math.round(texts.map((t) => String(t || '')).join('').length / 4));
const LIMIT_RE = /usage limit|rate.?limit|quota|too many requests|limit (?:reached|exceeded)|\b429\b|credit balance|overloaded/i;
export const looksLikeLimit = (text) => LIMIT_RE.test(String(text || ''));

export class Usage {
  constructor(store) { this.store = store; }
  get d() { return (this.store.data.usage ||= { days: {}, hits: {} }); }
  get limits() { return (this.store.data.settings.usageLimits ||= {}); }

  record({ agentId, name, provider, model, input = 0, output = 0, estimated = false }) {
    input = Math.max(0, Math.round(input)); output = Math.max(0, Math.round(output));
    if (!input && !output) return;
    const day = (this.d.days[dayKey()] ||= { agents: {}, providers: {} });
    const a = (day.agents[agentId] ||= { name, provider, input: 0, output: 0 });
    a.name = name; a.provider = provider; a.input += input; a.output += output;
    const p = (day.providers[provider] ||= { input: 0, output: 0, estimated: false });
    p.input += input; p.output += output; if (estimated) p.estimated = true;
    const keep = Object.keys(this.d.days).sort().slice(-120);
    for (const k of Object.keys(this.d.days)) if (!keep.includes(k)) delete this.d.days[k];
    this.store.save();
  }

  markLimit(provider) { this.d.hits[provider] = Date.now(); this.store.save(); }
  setLimits(patch = {}) {
    for (const [prov, v] of Object.entries(patch)) {
      if (!/^\w+$/.test(prov) || typeof v !== 'object' || !v) continue;
      const num = (x) => { const n = Math.round(Number(x)); return Number.isFinite(n) && n > 0 ? n : 0; };
      this.limits[prov] = { daily: num(v.daily), weekly: num(v.weekly) };
    }
    this.store.save();
  }

  summary(days = 14) {
    days = Math.min(90, Math.max(1, Math.round(days) || 14));
    const series = [], totals = new Map();
    for (let i = days - 1; i >= 0; i--) {
      const date = dayKey(Date.now() - i * 86400000), day = this.d.days[date] || { agents: {}, providers: {} };
      const byAgent = {};
      for (const [id, a] of Object.entries(day.agents)) {
        byAgent[id] = a.input + a.output;
        const t = totals.get(id) || { id, name: a.name, provider: a.provider, input: 0, output: 0 };
        t.name = a.name; t.input += a.input; t.output += a.output; totals.set(id, t);
      }
      series.push({ date, total: Object.values(byAgent).reduce((x, y) => x + y, 0), byAgent });
    }
    const agents = [...totals.values()].map((t) => ({ ...t, total: t.input + t.output })).sort((a, b) => b.total - a.total);
    const sum = (prov, n) => { let t = 0; for (let i = 0; i < n; i++) { const p = this.d.days[dayKey(Date.now() - i * 86400000)]?.providers[prov]; if (p) t += p.input + p.output; } return t; };
    const ids = new Set([...Object.keys(this.limits), ...Object.values(this.d.days).flatMap((d) => Object.keys(d.providers))]);
    const providers = [...ids].map((id) => {
      const lim = this.limits[id] || { daily: 0, weekly: 0 }, today = sum(id, 1), week = sum(id, 7);
      const hitAt = this.d.hits[id] && Date.now() - this.d.hits[id] < 6 * 3600000 ? this.d.hits[id] : 0;
      const estimated = Object.values(this.d.days).some((d) => d.providers[id]?.estimated);
      return { id, today, week, daily: lim.daily, weekly: lim.weekly, pctDay: lim.daily ? today / lim.daily : null, pctWeek: lim.weekly ? week / lim.weekly : null, hitAt, estimated };
    });
    return { days, series, agents, providers };
  }
}
