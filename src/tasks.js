// The task board: to do, back burner, in progress, blocked and done.
//   todo       will be done soon
//   backburner an idea that is not finished yet; more detail comes later
import { randomUUID } from 'node:crypto';

export const STATUSES = ['todo', 'backburner', 'inprogress', 'blocked', 'done'];
export const STATUS_LABELS = { todo: 'To do', backburner: 'Back burner', inprogress: 'In progress', blocked: 'Blocked', done: 'Done' };
const err = (status, message) => Object.assign(new Error(message), { status });
const clean = (s, n) => String(s ?? '').trim().slice(0, n);

export class Tasks {
  constructor(store) { this.store = store; }
  get all() { return (this.store.data.tasks ||= {}); }
  get list() { return Object.values(this.all).sort((a, b) => b.updatedAt - a.updatedAt); }
  get(id) { const t = this.all[id]; if (!t) throw err(404, 'No such task'); return t; }

  add({ title, notes = '', status = 'todo', labels = [], assignee = null, project = null, source = 'human', ref = null }) {
    title = clean(title, 140); if (!title) throw err(400, 'Give the task a title');
    if (!STATUSES.includes(status)) throw err(400, 'Unknown status');
    const now = Date.now();
    const t = { id: randomUUID().slice(0, 8), title, notes: clean(notes, 4000), status, labels: this._labels(labels), assignee, project, source, ref, createdAt: now, updatedAt: now, log: [{ at: now, text: `Created as ${STATUS_LABELS[status]}` }] };
    this.all[t.id] = t; this.store.save();
    return t;
  }
  _labels(l) { return [...new Set((Array.isArray(l) ? l : String(l || '').split(',')).map((x) => clean(x, 24).toLowerCase()).filter(Boolean))].slice(0, 8); }

  update(id, patch = {}, who = 'you') {
    const t = this.get(id), now = Date.now();
    if (patch.title !== undefined) { const v = clean(patch.title, 140); if (!v) throw err(400, 'Give the task a title'); t.title = v; }
    if (patch.notes !== undefined) t.notes = clean(patch.notes, 4000);
    if (patch.labels !== undefined) t.labels = this._labels(patch.labels);
    if (patch.assignee !== undefined) t.assignee = patch.assignee;
    if (patch.status !== undefined && patch.status !== t.status) {
      if (!STATUSES.includes(patch.status)) throw err(400, 'Unknown status');
      t.log.push({ at: now, text: `${who} moved it from ${STATUS_LABELS[t.status]} to ${STATUS_LABELS[patch.status]}${patch.reason ? ': ' + clean(patch.reason, 200) : ''}` });
      t.status = patch.status; if (t.status === 'done') t.doneAt = now; else delete t.doneAt;
    }
    t.log = t.log.slice(-40); t.updatedAt = now; this.store.save();
    return t;
  }
  remove(id) { this.get(id); delete this.all[id]; this.store.save(); }
  // Used by the engine when work starts, finishes or gets stuck.
  byRef(ref) { return this.list.find((t) => t.ref === ref); }
  counts() { const c = Object.fromEntries(STATUSES.map((s) => [s, 0])); for (const t of Object.values(this.all)) c[t.status]++; return c; }
}
