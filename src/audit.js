// Audit log: an append-only record of who did what. One JSON object per line in audit.jsonl.
// It holds names and short descriptions only, never secret values or command output, and anything older
// than the retention period (30 days) is deleted.
import { appendFileSync, readFileSync, writeFileSync, existsSync, chmodSync, renameSync } from 'node:fs';

export const KINDS = ['command', 'ssh', 'file', 'tool', 'commit', 'secret', 'approval', 'signin', 'vault', 'infra', 'backup', 'system'];
export const RETENTION_DAYS = 30;
const DAY = 86400000;
const FILE_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|str_replace)/i;

export class Audit {
  constructor(file, redact = (s) => s) { this.file = file; this.redact = redact; this.lastPrune = 0; this.prune(); }
  // kind: one of KINDS. actor: who (an agent name, or "You"). detail: short text (never output or secrets).
  add(kind, { actor = 'System', project = '', action = '', detail = '' } = {}) {
    const e = { t: Date.now(), kind, actor: String(actor).slice(0, 80), project: String(project || '').slice(0, 80), action: this.redact(String(action)).slice(0, 300), detail: this.redact(String(detail)).slice(0, 600) };
    try { appendFileSync(this.file, JSON.stringify(e) + '\n', { mode: 0o600 }); try { chmodSync(this.file, 0o600); } catch {} } catch {}
    if (Date.now() - this.lastPrune > DAY) this.prune();
    return e;
  }
  // Turns one line of an agent's live log into an entry (or nothing for chatter).
  fromLog(agent, project, line) {
    let m;
    if ((m = /^\$ (.+)/.exec(line))) {
      const ssh = /\bapiary-ssh\b/.test(m[1]);
      return this.add(ssh ? 'ssh' : 'command', { actor: agent, project, action: m[1], detail: ssh ? 'remote command over SSH' : '' });
    }
    if ((m = /^> ([\w.-]+)(?:: (.*))?$/.exec(line))) {
      return this.add(FILE_TOOLS.test(m[1]) ? 'file' : 'tool', { actor: agent, project, action: m[1], detail: m[2] || '' });
    }
    if ((m = /^✔ committed changes on (.+)/.exec(line))) return this.add('commit', { actor: agent, project, action: 'committed changes', detail: m[1] });
    return null;
  }
  _all() {
    if (!existsSync(this.file)) return [];
    const out = [];
    for (const l of readFileSync(this.file, 'utf8').split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch {} }
    return out;
  }
  prune(now = Date.now()) {
    this.lastPrune = now;
    if (!existsSync(this.file)) return 0;
    const all = this._all(), keep = all.filter((e) => e.t >= now - RETENTION_DAYS * DAY);
    if (keep.length === all.length) return 0;
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, keep.map((e) => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''), { mode: 0o600 });
    renameSync(tmp, this.file);
    return all.length - keep.length;
  }
  // q: words that must all appear (case-insensitive) in actor/project/action/detail. Newest first.
  search({ q = '', kind = '', actor = '', project = '', from = 0, to = 0, limit = 100, offset = 0 } = {}) {
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean), kinds = String(kind).split(',').filter(Boolean);
    const all = this._all();
    const facets = { kinds: {}, actors: {}, projects: {} };
    for (const e of all) { facets.kinds[e.kind] = (facets.kinds[e.kind] || 0) + 1; facets.actors[e.actor] = (facets.actors[e.actor] || 0) + 1; if (e.project) facets.projects[e.project] = (facets.projects[e.project] || 0) + 1; }
    const hit = all.filter((e) => (!kinds.length || kinds.includes(e.kind)) && (!actor || e.actor === actor) && (!project || e.project === project) && (!from || e.t >= from) && (!to || e.t <= to)
      && words.every((w) => `${e.actor} ${e.project} ${e.kind} ${e.action} ${e.detail}`.toLowerCase().includes(w))).sort((a, b) => b.t - a.t);
    limit = Math.min(Math.max(+limit || 100, 1), 500);
    return { total: hit.length, items: hit.slice(+offset || 0, (+offset || 0) + limit), facets, retentionDays: RETENTION_DAYS };
  }
}
