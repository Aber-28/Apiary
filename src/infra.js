// The map of the person's infrastructure: devices, servers, VMs, websites and the links between them.
// Things are added by hand, or proposed by an agent as "is this right?" cards that the person confirms.
// No passwords live here: an item only names the vault secret that gives access to it.
import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { byId as libraryEntry } from './library.js';

export const TYPES = {
  router: 'Router or firewall', switch: 'Switch or access point', proxmox: 'Proxmox or hypervisor', server: 'Server or computer', vm: 'Virtual machine',
  container: 'Container', pi: 'Raspberry Pi or small board', nas: 'NAS or storage', website: 'Website', service: 'Service or app', database: 'Database',
  cloud: 'Cloud or hosting account', device: 'Smart home or other device', other: 'Other',
};
const PORTS = { proxmox: 8006, server: 22, vm: 22, pi: 22, nas: 22, router: 443, container: 22 };
const err = (status, message) => Object.assign(new Error(message), { status });
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

export class Infra {
  constructor(file) {
    this.file = file; this.items = [];
    try { if (existsSync(file)) this.items = JSON.parse(readFileSync(file, 'utf8')).items || []; } catch (e) { console.error('Could not read the infrastructure file:', e.message); }
  }
  _save() {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + '.tmp'; writeFileSync(tmp, JSON.stringify({ v: 1, items: this.items }), { mode: 0o600 }); renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }
  get(id) { return this.items.find((i) => i.id === id); }
  byName(name) { const n = String(name || '').trim().toLowerCase(); return n ? this.items.find((i) => i.name.toLowerCase() === n) : undefined; }
  view() { return this.items; }

  _fields(b, cur = {}) {
    const o = {};
    if (b.name !== undefined || !cur.id) { o.name = clean(b.name, 60); if (!o.name) throw err(400, 'Give it a name'); }
    if (b.type !== undefined || !cur.id) { o.type = TYPES[b.type] ? b.type : 'other'; }
    if (b.address !== undefined) {
      o.address = clean(b.address, 253);
      if (/\s/.test(o.address) || /^[a-z]+:\/\//i.test(o.address)) throw err(400, 'The address is a name or IP like 10.0.0.5 or nas.local (put web links in the Web address box)');
    }
    if (b.port !== undefined) { const p = b.port === '' || b.port === null ? 0 : Number(b.port); if (!Number.isInteger(p) || p < 0 || p > 65535) throw err(400, 'The port must be a number from 1 to 65535'); o.port = p; }
    if (b.url !== undefined) { o.url = clean(b.url, 500); if (o.url && !/^https?:\/\/[^\s]+$/i.test(o.url)) throw err(400, 'The web address must start with http:// or https://'); }
    for (const [k, n] of [['notes', 1000], ['secret', 80], ['location', 200], ['os', 80]]) if (b[k] !== undefined) o[k] = clean(b[k], n);
    if (b.parentId !== undefined) {
      const pid = b.parentId || '';
      if (pid && !this.get(pid)) throw err(400, 'The place it runs on does not exist');
      if (pid && cur.id) { for (let x = this.get(pid); x; x = this.get(x.parentId)) if (x.id === cur.id) throw err(400, 'That would make it run on itself'); }
      if (pid === cur.id && pid) throw err(400, 'That would make it run on itself');
      o.parentId = pid;
    }
    if (b.lib !== undefined) o.lib = libraryEntry(b.lib) ? String(b.lib) : '';
    if (b.links !== undefined) {
      o.links = [].concat(b.links || []).filter((l) => l && this.get(l.to) && l.to !== cur.id).slice(0, 30).map((l) => ({ to: String(l.to), label: clean(l.label, 40) }));
    }
    return o;
  }
  add(b, { proposed = false, by = '' } = {}) {
    const o = this._fields(b);
    if (this.byName(o.name)) throw err(409, `You already have "${o.name}"`);
    const it = { id: randomUUID().slice(0, 8), address: '', port: 0, url: '', notes: '', secret: '', location: '', os: '', parentId: '', links: [], ...o, state: proposed ? 'proposed' : 'confirmed', createdAt: Date.now() };
    if (proposed) { it.by = clean(by, 60); it.why = clean(b.why, 300); it.question = clean(b.question, 300); }
    this.items.push(it); this._save(); return it;
  }
  update(id, b) {
    const it = this.get(id); if (!it) throw err(404, 'No such item');
    const o = this._fields(b, it);
    if (o.name && o.name.toLowerCase() !== it.name.toLowerCase() && this.byName(o.name)) throw err(409, `You already have "${o.name}"`);
    Object.assign(it, o); this._save(); return it;
  }
  remove(id) {
    if (!this.get(id)) throw err(404, 'No such item');
    this.items = this.items.filter((i) => i.id !== id);
    for (const i of this.items) { if (i.parentId === id) i.parentId = ''; i.links = (i.links || []).filter((l) => l.to !== id); }
    this._save();
  }
  // "Is this right?" answers
  confirm(id, ok) {
    const it = this.get(id); if (!it) throw err(404, 'No such item');
    if (!ok) { this.remove(id); return null; }
    it.state = 'confirmed'; delete it.why; this._save(); return it;
  }
  answer(id, text) {
    const it = this.get(id); if (!it) throw err(404, 'No such item');
    const a = clean(text, 600); if (!a) throw err(400, 'Type an answer first');
    it.notes = [it.notes, `${it.question ? it.question + ' ' : ''}${a}`].filter(Boolean).join('\n').slice(0, 1000); delete it.question; this._save(); return it;
  }

  // An agent proposes things; nothing is trusted until the person confirms it.
  propose(by, list) {
    const added = [], notes = [];
    const raw = [].concat(list || []).slice(0, 20);
    for (const x of raw) {
      try {
        if (!x || !String(x.name || '').trim()) { notes.push('An apiary-infra item needs a "name".'); continue; }
        const ex = this.byName(x.name);
        if (ex) {   // already known: only a question or a detail can be added, never overwritten
          if (ex.state === 'proposed') continue;
          if (x.question && !ex.question) { ex.question = clean(x.question, 300); this._save(); added.push(ex); }
          continue;
        }
        const parent = x.hostedOn ? this.byName(x.hostedOn) : null;
        if (x.hostedOn && !parent) notes.push(`"${x.hostedOn}" is not in the map yet, so "${x.name}" was added without a place to run on. Add it first, or in the same block before this item.`);
        const it = this.add({ name: x.name, type: x.type, address: x.address && !/\s|:\/\//.test(String(x.address)) ? x.address : undefined, url: /^https?:\/\//i.test(x.url || '') ? x.url : undefined, notes: x.notes, os: x.os, location: x.location, parentId: parent?.id || '', why: x.why, question: x.question }, { proposed: true, by });
        for (const n of [].concat(x.connectsTo || [])) { const t = this.byName(typeof n === 'string' ? n : n?.to); if (t && t.id !== it.id) (it.links ||= []).push({ to: t.id, label: clean(typeof n === 'string' ? '' : n?.label, 40) }); }
        this._save(); added.push(it);
      } catch (e) { notes.push(`Could not add "${x?.name}": ${e.message}`); }
    }
    return { added, notes };
  }

  // Can it be reached right now? A website gets a web request, anything else a quick connection to its port.
  async test(id) {
    const it = this.get(id); if (!it) throw err(404, 'No such item');
    const t0 = Date.now(); let ok = false, detail = '';
    try {
      if (it.url && (it.type === 'website' || it.type === 'service' || !it.address)) {
        const r = await fetch(it.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) });
        ok = r.status < 500; detail = `Answered with HTTP ${r.status}`;
        r.body?.cancel?.().catch(() => {});
      } else if (it.address) {
        const port = it.port || PORTS[it.type] || 22;
        await new Promise((res, rej) => { const s = net.connect({ host: it.address, port, timeout: 5000 }); s.once('connect', () => { s.destroy(); res(); }); s.once('timeout', () => { s.destroy(); rej(new Error('No answer (timed out)')); }); s.once('error', rej); });
        ok = true; detail = `Port ${port} is open`;
      } else throw new Error('Add an address or a web address first');
    } catch (e) { detail = e.cause?.code === 'ENOTFOUND' || e.code === 'ENOTFOUND' ? 'The name could not be found' : e.cause?.code === 'ECONNREFUSED' || e.code === 'ECONNREFUSED' ? 'Connection refused' : e.message; }
    const prev = it.status, at = Date.now();
    it.status = { ok, detail, at, ms: at - t0, since: prev && prev.ok === ok && prev.since ? prev.since : at }; this._save();
    return it;
  }
  // Short text for an agent: what is already on the map.
  summary() {
    if (!this.items.length) return '';
    const nm = (id) => this.get(id)?.name;
    const mcp = (i) => { const e = i.lib && libraryEntry(i.lib); return e?.mcp && i.secret ? ` [MCP connector "${e.mcp.name}": ask to use its login "${i.secret}" and its tools appear on your next turn]` : ''; };
    return this.items.filter((i) => i.state !== 'proposed').map((i) => `- ${i.name} (${TYPES[i.type] || i.type})${i.address ? ' ' + i.address : ''}${mcp(i)}${i.parentId ? ` runs on ${nm(i.parentId)}` : ''}${(i.links || []).length ? ` connects to ${i.links.map((l) => nm(l.to)).join(', ')}` : ''}${i.secret ? ` [vault: ${i.secret}]` : ''}`).join('\n');
  }
}
