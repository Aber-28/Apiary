// Support tickets: problems the human reports, which an agent works on and answers.
import { randomUUID } from 'node:crypto';

export const TICKET_STATUSES = ['open', 'working', 'resolved', 'closed'];
export const PRIORITIES = ['low', 'normal', 'high'];
const err = (status, message) => Object.assign(new Error(message), { status });
const clean = (s, n) => String(s ?? '').trim().slice(0, n);

export class Tickets {
  constructor(store) { this.store = store; }
  get all() { return (this.store.data.tickets ||= {}); }
  get list() { return Object.values(this.all).sort((a, b) => b.updatedAt - a.updatedAt); }
  get(id) { const t = this.all[id]; if (!t) throw err(404, 'No such ticket'); return t; }
  add({ title, description = '', priority = 'normal', assignee = null }) {
    title = clean(title, 140); if (!title) throw err(400, 'Give the ticket a short title');
    if (!PRIORITIES.includes(priority)) priority = 'normal';
    const now = Date.now(), n = Object.values(this.all).reduce((m, t) => Math.max(m, t.num), 0) + 1;
    const t = { id: randomUUID().slice(0, 8), num: n, title, description: clean(description, 6000), priority, status: 'open', assignee, comments: [], createdAt: now, updatedAt: now };
    this.all[t.id] = t; this.store.save(); return t;
  }
  comment(id, who, text, kind = 'note') {
    const t = this.get(id); text = clean(text, 8000); if (!text) throw err(400, 'Write a message');
    t.comments.push({ at: Date.now(), who, text, kind }); t.comments = t.comments.slice(-60); t.updatedAt = Date.now(); this.store.save(); return t;
  }
  setStatus(id, status) { const t = this.get(id); if (!TICKET_STATUSES.includes(status)) throw err(400, 'Unknown status'); t.status = status; t.updatedAt = Date.now(); this.store.save(); return t; }
  update(id, p = {}) {
    const t = this.get(id);
    if (p.title !== undefined) { const v = clean(p.title, 140); if (!v) throw err(400, 'Give the ticket a short title'); t.title = v; }
    if (p.description !== undefined) t.description = clean(p.description, 6000);
    if (PRIORITIES.includes(p.priority)) t.priority = p.priority;
    if (p.assignee !== undefined) t.assignee = p.assignee;
    t.updatedAt = Date.now(); this.store.save(); return t;
  }
  remove(id) { this.get(id); delete this.all[id]; this.store.save(); }
}
