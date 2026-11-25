// Runbook library: steps for problems that were solved once, kept so they can be followed again.
// An agent saves one with an apiary-runbook block; it stays a DRAFT, and is never given to agents as
// instructions, until you have read it and approved it. Passwords and keys are masked on the way in.
import { randomUUID } from 'node:crypto';
import { scrub } from './templates.js';

const err = (status, message) => Object.assign(new Error(message), { status });
const clean = (s, n) => String(s ?? '').replace(/\r/g, '').trim().slice(0, n);

export class Runbooks {
  constructor(engine) { this.engine = engine; }
  get all() { return (this.engine.store.data.runbooks ||= {}); }
  // Why and steps must not name real machines, addresses or links: those become placeholders (see scrub in templates.js).
  _mask(text) { return this._secretMask(scrub(this.engine, String(text ?? '')).text); }
  _secretMask(text) {
    return this.engine._redact(String(text ?? '')).replace(/\b(password|passwd|pwd|passphrase|token|api[ _-]?key|secret)\s*[:=]\s*\S+/gi, (m, k) => `${k}: <removed>`);
  }
  _steps(v) {
    const arr = Array.isArray(v) ? v : String(v ?? '').split('\n');
    return arr.map((x) => this._mask(clean(String(x).replace(/^\s*(?:\d+[.)]|[-*])\s*/, ''), 400))).filter(Boolean).slice(0, 40);
  }
  _tags(v) { return [...new Set((Array.isArray(v) ? v : String(v ?? '').split(',')).map((t) => clean(t, 24).toLowerCase()).filter(Boolean))].slice(0, 8); }
  // Cleans runbooks saved before device names were kept out of them. Titles are left as they are.
  tidy() {
    let changed = 0;
    for (const r of Object.values(this.all)) {
      const problem = this._mask(r.problem || ''), steps = this._steps(r.steps || []);
      if (problem !== (r.problem || '') || steps.join('\n') !== (r.steps || []).join('\n')) { r.problem = problem; if (steps.length) r.steps = steps; changed++; }
    }
    if (changed) this.engine.store.save();
    return changed;
  }
  list() { return Object.values(this.all).sort((a, b) => b.updatedAt - a.updatedAt); }
  get(id) { const r = this.all[id]; if (!r) throw err(404, 'No such runbook'); return r; }
  get draftCount() { return Object.values(this.all).filter((r) => r.status === 'draft').length; }
  trusted() { return this.list().filter((r) => r.status === 'trusted'); }

  // By an agent: always a draft. A runbook that is already trusted is never changed by an agent;
  // a new draft is made beside it so you can compare.
  propose(agentName, project, b = {}) {
    const title = this._secretMask(clean(b.title, 100)), steps = this._steps(b.steps);
    if (!title) throw err(400, 'A runbook needs a title');
    if (!steps.length) throw err(400, 'A runbook needs steps');
    const clash = Object.values(this.all).find((r) => r.title.toLowerCase() === title.toLowerCase());
    if (clash && clash.status === 'draft') { Object.assign(clash, { problem: this._mask(clean(b.problem, 500)), steps, tags: this._tags(b.tags), author: agentName, project, updatedAt: Date.now() }); this._changed(); return clash; }
    const r = { id: randomUUID().slice(0, 8), title: clash ? `${title} (update)` : title, problem: this._mask(clean(b.problem, 500)), steps, tags: this._tags(b.tags), status: 'draft', author: agentName, project: project || '', createdAt: Date.now(), updatedAt: Date.now(), uses: 0 };
    this.all[r.id] = r; this._changed();
    this.engine.audit?.add('system', { actor: agentName, project, action: 'saved a runbook draft', detail: r.title });
    return r;
  }
  // By you: edits keep the status; a runbook you write yourself is trusted straight away.
  create(b = {}) {
    const title = clean(b.title, 100), steps = this._steps(b.steps);
    if (!title) throw err(400, 'Give the runbook a title'); if (!steps.length) throw err(400, 'Add at least one step');
    if (Object.values(this.all).some((r) => r.title.toLowerCase() === title.toLowerCase())) throw err(409, `There is already a runbook called "${title}"`);
    const r = { id: randomUUID().slice(0, 8), title, problem: this._mask(clean(b.problem, 500)), steps, tags: this._tags(b.tags), status: 'trusted', author: 'You', project: '', createdAt: Date.now(), updatedAt: Date.now(), approvedAt: Date.now(), uses: 0 };
    this.all[r.id] = r; this._changed(); return r;
  }
  update(id, b = {}) {
    const r = this.get(id);
    if (b.title !== undefined) { const t = clean(b.title, 100); if (!t) throw err(400, 'Give the runbook a title'); if (Object.values(this.all).some((x) => x.id !== id && x.title.toLowerCase() === t.toLowerCase())) throw err(409, `There is already a runbook called "${t}"`); r.title = t; }
    if (b.problem !== undefined) r.problem = this._mask(clean(b.problem, 500));
    if (b.steps !== undefined) { const s = this._steps(b.steps); if (!s.length) throw err(400, 'Add at least one step'); r.steps = s; }
    if (b.tags !== undefined) r.tags = this._tags(b.tags);
    if (b.status !== undefined) {
      if (!['draft', 'trusted'].includes(b.status)) throw err(400, 'Status must be draft or trusted');
      if (b.status === 'trusted' && r.status !== 'trusted') { r.approvedAt = Date.now(); this.engine.audit?.add('system', { actor: 'You', action: 'approved a runbook', detail: r.title }); }
      if (b.status === 'draft') delete r.approvedAt;
      r.status = b.status;
    }
    r.updatedAt = Date.now(); this._changed(); return r;
  }
  remove(id) { const r = this.get(id); delete this.all[id]; this._changed(); this.engine.audit?.add('system', { actor: 'You', action: 'deleted a runbook', detail: r.title }); }
  _changed() { this.engine.store.save(); this.engine.emit('event', { type: 'runbook', drafts: this.draftCount }); }
  // For the prompt: only approved runbooks, kept short.
  promptText(max = 6000) {
    const out = []; let n = 0;
    for (const r of this.trusted().slice(0, 30)) {
      const t = `- "${r.title}"${r.problem ? ` (why: ${r.problem})` : ''}\n${r.steps.map((s, i) => `    ${i + 1}. ${s}`).join('\n')}`;
      if (n + t.length > max) break; out.push(t); n += t.length;
    }
    return out.join('\n');
  }
}
