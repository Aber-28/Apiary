// Templates: save a repeatable setup (goal, plan phases, team roles) and start new projects from it.
// A template never holds passwords or specific servers: secrets are masked, and IP addresses, web links,
// ssh targets and the names and addresses of devices on your map are replaced with <server>.
import { randomUUID } from 'node:crypto';

const err = (status, message) => Object.assign(new Error(message), { status });
const clean = (s, n) => String(s ?? '').replace(/\r/g, '').trim().slice(0, n);

// Returns { text, removed } with specific details replaced.
export function scrub(engine, text) {
  let removed = 0;
  const sub = (re, to) => { text = text.replace(re, (...a) => { removed++; return typeof to === 'function' ? to(...a) : to; }); };
  text = engine._redact(String(text ?? ''));
  for (const it of engine.infra.items) for (const v of [it.address, it.url, it.name]) if (v && String(v).length >= 3) { const esc = String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); sub(new RegExp(esc, 'gi'), '<server>'); }
  sub(/\b[\w.-]+@(?:\d{1,3}\.){3}\d{1,3}\b|\b[\w.-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi, '<server>');   // user@host
  sub(/https?:\/\/[^\s)>"']+/gi, '<link>');
  sub(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<server>');
  sub(/\b(password|passwd|pwd|passphrase|token|api[ _-]?key|secret)\s*[:=]\s*\S+/gi, (m, k) => `${k}: <removed>`);
  return { text, removed };
}

export class Templates {
  constructor(engine) { this.engine = engine; }
  get all() { return (this.engine.store.data.templates ||= {}); }
  list() { return Object.values(this.all).sort((a, b) => a.name.localeCompare(b.name)); }
  get(id) { const t = this.all[id]; if (!t) throw err(404, 'No such template'); return t; }

  // Save a project's setup. The goal, the phases with their steps (all unticked) and the team roles.
  save(rootId, { name, description } = {}) {
    const e = this.engine, root = e.agents[rootId];
    if (!root || root.parentId || root.kind === 'general') throw err(404, 'Pick a project to save as a template');
    name = clean(name || root.name, 60); if (!name) throw err(400, 'Give the template a name');
    if (Object.values(this.all).some((t) => t.name.toLowerCase() === name.toLowerCase())) throw err(409, `There is already a template called "${name}"`);
    let removed = 0; const S = (t, n) => { const r = scrub(e, clean(t, n)); removed += r.removed; return r.text; };
    const plan = root.plan;
    const members = e._roster(root).map((m) => ({ title: S(m.title || m.name, 60), name: S(m.title ? m.name : '', 40) || undefined, role: S(m.role, 120), department: m.department, instructions: S(m.instructions, 4000) }));
    const phases = (plan?.phases || []).map((p) => ({ title: S(p.title, 100), goal: S(p.goal, 400), steps: (p.steps || []).map((x) => S(x.text, 300)) }));
    const goal = S(plan?.goal || description || '', 2000);
    if (!goal && !phases.length && !members.length) throw err(400, 'This project has no goal, plan or team yet, so there is nothing to save. Let it make a plan first.');
    const t = { id: randomUUID().slice(0, 8), name, description: S(description || '', 300), goal, phases, members, createdAt: Date.now(), fromProject: root.name };
    this.all[t.id] = t; e.store.save();
    e.audit?.add('system', { actor: 'You', action: 'saved a template', detail: name });
    return { ...t, removed };
  }
  update(id, b = {}) {
    const t = this.get(id), e = this.engine;
    if (b.name !== undefined) { const n = clean(b.name, 60); if (!n) throw err(400, 'Give the template a name'); if (Object.values(this.all).some((x) => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) throw err(409, `There is already a template called "${n}"`); t.name = n; }
    if (b.description !== undefined) t.description = scrub(e, clean(b.description, 300)).text;
    if (b.goal !== undefined) t.goal = scrub(e, clean(b.goal, 2000)).text;
    e.store.save(); return t;
  }
  remove(id) { const t = this.get(id); delete this.all[id]; this.engine.store.save(); this.engine.audit?.add('system', { actor: 'You', action: 'deleted a template', detail: t.name }); }

  // A new project with the saved team and plan already in place, ready to start.
  async start(id, { name, provider, model, cwd, source, access, approvals } = {}) {
    const e = this.engine, t = this.get(id);
    const lead = await e.createLead({ name: clean(name, 48) || t.name, provider, model, cwd, source, access, approvals });
    for (const m of t.members) {
      await e._makeMember(lead, { title: m.title, name: m.name, role: m.role, department: m.department, instructions: m.instructions, reason: `from the template "${t.name}"`, provider: lead.provider, reportsTo: lead.id });
    }
    if (t.phases.length) {
      const now = Date.now();
      lead.plan = { goal: t.goal || t.name, createdAt: now, updatedAt: now, fromTemplate: t.name, phases: t.phases.map((p, i) => ({ id: i + 1, title: p.title, goal: p.goal, status: 'pending', steps: p.steps.map((x) => ({ text: x, done: false })) })) };
      e._planFix(lead.plan); e._planDone(lead);
      e._msg(lead, { role: 'system', text: `Project started from the template "${t.name}": ${lead.plan.phases.map((p) => p.title).join(' → ')}` });
    }
    e.emit('event', { type: 'agent', agent: lead }); e.store.save();
    e.audit?.add('system', { actor: 'You', project: lead.name, action: 'started a project from a template', detail: t.name });
    e.send(lead.id, `This project was started from the template "${t.name}". ${t.goal ? `Goal: ${t.goal}\n` : ''}${t.phases.length ? 'The plan and team from the template are already in place. Confirm what is needed (for example which servers or folders apply, asking me for anything specific), then start on the first phase.' : 'Start by making a plan.'}`).catch(() => {});
    return lead;
  }
}
