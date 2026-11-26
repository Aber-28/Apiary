// The task board: to do, back burner, in progress, blocked and done.
//   backburner an unfinished idea; more detail comes later
//   todo       finished and ready: work on it can start
import { randomUUID } from 'node:crypto';

export const STATUSES = ['backburner', 'todo', 'inprogress', 'blocked', 'done'];
export const STATUS_LABELS = { backburner: 'Back burner', todo: 'To do', inprogress: 'In progress', blocked: 'Blocked', done: 'Done' };
const err = (status, message) => Object.assign(new Error(message), { status });
const clean = (s, n) => String(s ?? '').trim().slice(0, n);

export class Tasks {
  constructor(store) { this.store = store; }
  get all() { return (this.store.data.tasks ||= {}); }
  get list() { return Object.values(this.all).sort((a, b) => b.updatedAt - a.updatedAt); }
  get(id) { const t = this.all[id]; if (!t) throw err(404, 'No such task'); return t; }

  // Every task gets a code that is never reused, even after a task is deleted: T-0001, T-0002, ...
  _nextCode() { const n = (this.store.data.taskSeq = (this.store.data.taskSeq || 0) + 1); return { num: n, code: `T-${String(n).padStart(4, '0')}` }; }
  // Tasks made before codes existed get one, oldest first.
  backfill() {
    const all = Object.values(this.all);
    let seq = Math.max(this.store.data.taskSeq || 0, ...all.map((t) => t.num || 0));
    for (const t of all.filter((x) => !x.code).sort((a, b) => a.createdAt - b.createdAt)) { t.num = ++seq; t.code = `T-${String(seq).padStart(4, '0')}`; }
    this.store.data.taskSeq = seq;
  }
  byCode(code) { return Object.values(this.all).find((t) => t.code === String(code).trim().toUpperCase()); }
  children(t) { return Object.values(this.all).filter((x) => x.parent === t.id); }
  // "Closed by Agent X. Refer to T-0004." Names the closer and points to the related task.
  _closure(t, by) {
    const par = t.parent && this.all[t.parent], kids = this.children(t);
    const refer = par ? par.code : kids.length ? kids.map((k) => k.code).join(', ') : '';
    return `Closed by ${by}.${refer ? ` Refer to ${refer}.` : ''}`;
  }

  add({ title, notes = '', status = 'todo', labels = [], assignee = null, project = null, source = 'human', ref = null, parent = null, images = [] }) {
    title = clean(title, 140); if (!title) throw err(400, 'Give the task a title');
    if (!STATUSES.includes(status)) throw err(400, 'Unknown status');
    const now = Date.now();
    const par = parent ? this.all[parent] : null;
    const t = { id: randomUUID().slice(0, 8), ...this._nextCode(), parent: par ? par.id : null, title, notes: clean(notes, 4000), images, status, labels: this._labels(labels), assignee, project, source, ref, createdAt: now, updatedAt: now, log: [{ at: now, text: `Created as ${STATUS_LABELS[status]}` }] };
    while (Object.values(this.all).some((x) => x.id === t.id)) t.id = randomUUID().slice(0, 8);
    this.all[t.id] = t;
    if (par) { par.log.push({ at: now, text: `Opened ${t.code} for ${assignee?.name || 'a teammate'}: ${clean(title, 80)}` }); par.updatedAt = now; }
    this.store.save();
    return t;
  }
  _labels(l) { return [...new Set((Array.isArray(l) ? l : String(l || '').split(',')).map((x) => clean(x, 24).toLowerCase()).filter(Boolean))].slice(0, 8); }

  update(id, patch = {}, who = 'you') {
    const t = this.get(id), now = Date.now();
    if (patch.title !== undefined) { const v = clean(patch.title, 140); if (!v) throw err(400, 'Give the task a title'); t.title = v; }
    if (patch.notes !== undefined) t.notes = clean(patch.notes, 4000);
    if (patch.images !== undefined) t.images = patch.images;
    if (patch.labels !== undefined) t.labels = this._labels(patch.labels);
    if (patch.assignee !== undefined) t.assignee = patch.assignee;
    if (patch.status !== undefined && patch.status !== t.status) {
      if (!STATUSES.includes(patch.status)) throw err(400, 'Unknown status');
      t.log.push({ at: now, text: `${who} moved it from ${STATUS_LABELS[t.status]} to ${STATUS_LABELS[patch.status]}${patch.reason ? ': ' + clean(patch.reason, 200) : ''}` });
      t.status = patch.status;
      if (t.status === 'done') {
        const by = who === 'Apiary' || who === 'you' ? (who === 'you' ? 'You' : t.assignee?.name || 'Apiary') : who;
        t.doneAt = now; t.closedBy = by; t.closure = this._closure(t, by); t.log.push({ at: now, text: t.closure });
        const par = t.parent && this.all[t.parent];
        if (par) { par.log.push({ at: now, text: `${t.code} was closed by ${by}. Continuing with ${par.code}.` }); par.updatedAt = now; }
      } else { delete t.doneAt; delete t.closedBy; delete t.closure; }
    }
    t.log = t.log.slice(-40); t.updatedAt = now; this.store.save();
    return t;
  }
  remove(id) { this.get(id); delete this.all[id]; this.store.save(); }
  // Used by the engine when work starts, finishes or gets stuck.
  byRef(ref) { return this.list.find((t) => t.ref === ref); }
  view(t, agents = {}) { const par = t.parent && this.all[t.parent], kids = this.children(t); return { ...t, parentCode: par?.code || '', subtasks: kids.map((k) => ({ id: k.id, code: k.code, title: k.title, status: k.status, assignee: k.assignee?.name || '' })), waitingFor: kids.filter((k) => k.status !== 'done').map((k) => k.code) }; }
  counts() { const c = Object.fromEntries(STATUSES.map((s) => [s, 0])); for (const t of Object.values(this.all)) c[t.status]++; return c; }
}
