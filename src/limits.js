// Real subscription usage, as reported by the AI provider itself (not guessed from what Apiary sent).
//
// Why: the same subscription is often used from other tools too, so counting only Apiary's own tokens would show
// the wrong number. Neither provider documents a public endpoint for this, so each source is read carefully and
// falls back to something honest:
//   Claude Code: the usage call Claude Code's own status line uses (needs the CLI login; read-only, the token is
//                never stored, logged or sent anywhere except that provider).
//   Codex:       the ChatGPT usage call with the CLI login; if that fails, the newest rate-limit record that
//                Codex wrote into its own session logs (shown with its age).
// Anything that cannot be read is reported as such and the page falls back to Apiary's own estimate.
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLAUDE_URL = () => process.env.APIARY_CLAUDE_USAGE_URL || 'https://api.anthropic.com/api/oauth/usage';
const CODEX_URL = () => process.env.APIARY_CODEX_USAGE_URL || 'https://chatgpt.com/backend-api/wham/usage';
const MIN_GAP = 15000;          // a manual refresh cannot hammer the provider
export const EVERY = 3600000;   // automatic refresh: once an hour

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const clampPct = (v) => { const n = num(v); return n == null ? null : Math.max(0, Math.min(100, Math.round(n * 10) / 10)); };
const iso = (v) => { if (v == null || v === '') return null; const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const winLabel = (mins, fallback) => { const m = num(mins); if (!m) return fallback; if (m >= 10000) return 'Weekly'; if (m % 60 === 0 && m < 1440) return `${m / 60}-hour`; if (m % 1440 === 0) return `${m / 1440}-day`; return fallback; };
const fail = (id, error, extra = {}) => ({ id, ok: false, error, windows: [], fetchedAt: Date.now(), ...extra });

async function getJson(url, headers) {
  const r = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(10000) });
  if (r.status === 401 || r.status === 403) { const e = new Error('The login is not accepted. Sign in again in the terminal.'); e.auth = true; throw e; }
  if (!r.ok) throw new Error(`The provider answered ${r.status}.`);
  return r.json();
}

export class Limits {
  constructor({ claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), codexDir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } = {}) {
    this.claudeDir = claudeDir; this.codexDir = codexDir;
    this.cache = new Map(); this.busy = new Map();
  }
  cached(id) { return this.cache.get(id) || null; }
  all() { return Object.fromEntries(this.cache); }

  async refresh(id, { force = false } = {}) {
    const old = this.cache.get(id);
    if (!force && old && Date.now() - old.fetchedAt < MIN_GAP) return old;
    if (this.busy.has(id)) return this.busy.get(id);
    const job = (async () => {
      let res;
      try {
        res = id === 'claude' ? await this._claude() : id === 'codex' ? await this._codex() : fail(id, 'No usage information is available for this one.');
      } catch (e) { res = fail(id, String(e.message || e).replace(/Bearer\s+\S+/gi, '').slice(0, 200)); }
      this.cache.set(id, res);
      return res;
    })().finally(() => this.busy.delete(id));
    this.busy.set(id, job);
    return job;
  }

  // ----- Claude Code -----
  _claudeToken() {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { token: process.env.CLAUDE_CODE_OAUTH_TOKEN };
    const f = path.join(this.claudeDir, '.credentials.json');
    if (!existsSync(f)) return null;
    try { const o = JSON.parse(readFileSync(f, 'utf8')).claudeAiOauth || {}; return o.accessToken ? { token: o.accessToken, expiresAt: num(o.expiresAt), plan: o.subscriptionType || '' } : null; } catch { return null; }
  }
  async _claude() {
    const c = this._claudeToken();
    if (!c) return fail('claude', 'Claude Code is not signed in with a subscription on this computer, so there is no subscription usage to read.', { reason: 'no-login' });
    if (c.expiresAt && c.expiresAt < Date.now() - 60000) return fail('claude', 'The Claude Code login has expired. Run Claude Code once in the terminal to renew it, then refresh.', { reason: 'expired' });
    let j;
    try { j = await getJson(CLAUDE_URL(), { authorization: `Bearer ${c.token}`, 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'apiary' }); }
    catch (e) { return fail('claude', e.message, { reason: e.auth ? 'auth' : 'unreachable' }); }
    const windows = [];
    const add = (key, label) => { const w = j?.[key]; if (w && clampPct(w.utilization) != null) windows.push({ key, label, pct: clampPct(w.utilization), resetsAt: iso(w.resets_at) }); };
    add('five_hour', '5-hour session'); add('seven_day', 'Weekly'); add('seven_day_opus', 'Weekly (Opus)'); add('seven_day_sonnet', 'Weekly (Sonnet)');
    if (!windows.length) return fail('claude', 'The provider returned no usage numbers for this account (some plans do not report them).', { reason: 'empty' });
    return { id: 'claude', ok: true, source: 'provider', plan: c.plan || '', windows, fetchedAt: Date.now() };
  }

  // ----- Codex -----
  _codexAuth() {
    const f = path.join(this.codexDir, 'auth.json');
    if (!existsSync(f)) return null;
    try { const o = JSON.parse(readFileSync(f, 'utf8')); const t = o.tokens || o; return t.access_token ? { token: t.access_token, account: t.account_id || o.account_id || '' } : null; } catch { return null; }
  }
  _codexWindows(rl) {
    const out = [];
    const win = (w, key, fallback) => { if (!w) return; const pct = clampPct(w.used_percent ?? w.usedPercent); if (pct == null) return; const mins = num(w.window_minutes ?? w.windowDurationMins) ?? (num(w.limit_window_seconds) ? num(w.limit_window_seconds) / 60 : null);
      out.push({ key, label: winLabel(mins, fallback), pct, resetsAt: iso(w.reset_at ?? w.resets_at ?? w.resetsAt) || (num(w.reset_after_seconds) != null ? new Date(Date.now() + num(w.reset_after_seconds) * 1000).toISOString() : null) }); };
    win(rl?.primary_window || rl?.primary, 'primary', '5-hour session'); win(rl?.secondary_window || rl?.secondary, 'secondary', 'Weekly');
    return out;
  }
  async _codex() {
    const a = this._codexAuth();
    let apiErr = '';
    if (a) {
      try {
        const j = await getJson(CODEX_URL(), { authorization: `Bearer ${a.token}`, 'user-agent': 'codex-cli', ...(a.account ? { 'chatgpt-account-id': a.account } : {}) });
        const windows = this._codexWindows(j?.rate_limit || j?.rate_limits || j);
        if (windows.length) return { id: 'codex', ok: true, source: 'provider', plan: j?.plan_type || '', windows, fetchedAt: Date.now() };
        apiErr = 'The provider returned no usage numbers.';
      } catch (e) { apiErr = e.message; }
    } else apiErr = 'Codex is not signed in with ChatGPT on this computer.';
    // fallback: what Codex last wrote into its own session logs
    const s = this._codexFromSessions();
    if (s) return { id: 'codex', ok: true, source: 'last-session', note: `${apiErr} Showing what Codex last recorded.`, plan: s.plan, windows: s.windows, fetchedAt: Date.now(), asOf: s.asOf };
    return fail('codex', apiErr || 'No usage information found.', { reason: a ? 'unreachable' : 'no-login' });
  }
  _codexFromSessions() {
    const root = path.join(this.codexDir, 'sessions');
    if (!existsSync(root)) return null;
    const files = [];
    const walk = (d, depth) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory() && depth < 4) walk(p, depth + 1); else if (e.isFile() && e.name.endsWith('.jsonl')) { try { files.push([p, statSync(p).mtimeMs]); } catch { /* skip */ } } } };
    walk(root, 0);
    files.sort((x, y) => y[1] - x[1]);
    for (const [p, mt] of files.slice(0, 6)) {
      let text; try { const fd = openSync(p, 'r'), size = statSync(p).size, len = Math.min(size, 400000), buf = Buffer.alloc(len); readSync(fd, buf, 0, len, size - len); closeSync(fd); text = buf.toString('utf8'); } catch { continue; }
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits"')) continue;
        try { const o = JSON.parse(lines[i]); const rl = o?.payload?.rate_limits || o?.rate_limits; const windows = this._codexWindows(rl);
          if (windows.length) { const now = Date.now(); for (const w of windows) if (w.resetsAt && Date.parse(w.resetsAt) < now) { w.pct = 0; w.reset = true; } return { windows, plan: rl.plan_type || '', asOf: iso(o.timestamp) || new Date(mt).toISOString() }; } } catch { /* partial line */ }
      }
    }
    return null;
  }
}
