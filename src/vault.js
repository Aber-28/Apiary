// Encrypted secrets vault.
//
// Values are encrypted with AES-256-GCM. The key comes from a passphrase (scrypt) that is never stored: it is
// asked for after every start and the derived key lives only in memory. The file holds names, notes and which
// agents may ask for a secret (none of that is secret), and the encrypted values.
import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { randomBytes, randomUUID, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

const PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const CHECK = 'apiary-vault-ok';
const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');

function seal(key, plain, aad) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { iv: b64(iv), tag: b64(c.getAuthTag()), ct: b64(ct) };
}
function open(key, box, aad) {
  const d = createDecipheriv('aes-256-gcm', key, unb64(box.iv));
  d.setAAD(Buffer.from(aad)); d.setAuthTag(unb64(box.tag));
  return Buffer.concat([d.update(unb64(box.ct)), d.final()]).toString('utf8');
}
const err = (status, message) => Object.assign(new Error(message), { status });
export function redactPairs(text, pairs) {
  let s = String(text ?? '');
  for (const [name, v] of [...pairs].sort((a, b) => b[1].length - a[1].length)) if (v && v.length >= 4 && s.includes(v)) s = s.split(v).join(`[secret:${name}]`);
  return s;
}
export const envName = (name) => 'APIARY_SECRET_' + String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

export class Vault {
  constructor(file) {
    this.file = file;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.data = null; this.key = null; this.values = new Map(); this._fails = 0;
    if (existsSync(file)) { try { this.data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.error('Could not read the vault file:', e.message); } }
  }
  get exists() { return !!this.data; }
  get unlocked() { return !!this.key; }
  _save() {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }
  _derive(pass, salt) { return scryptSync(String(pass), salt, 32, PARAMS); }

  init(pass) {
    if (this.exists) throw err(409, 'The vault already exists');
    if (String(pass || '').length < 8) throw err(400, 'Choose a passphrase of at least 8 characters');
    const salt = randomBytes(16), key = this._derive(pass, salt);
    this.data = { v: 1, salt: b64(salt), verify: seal(key, CHECK, 'verify'), items: {} };
    this.key = key; this.values.clear(); this._save();
  }
  async unlock(pass) {
    if (!this.exists) throw err(409, 'There is no vault yet. Create one first.');
    if (this._fails) await new Promise((r) => setTimeout(r, Math.min(this._fails, 5) * 600));   // slow down guessing
    const key = this._derive(pass, unb64(this.data.salt));
    try { if (open(key, this.data.verify, 'verify') !== CHECK) throw new Error('bad'); }
    catch { this._fails++; throw err(403, 'Wrong passphrase'); }
    this._fails = 0; this.key = key; this.values.clear();
    for (const it of Object.values(this.data.items)) { try { this.values.set(it.id, open(key, it, it.id)); } catch { /* skip a damaged item */ } }
  }
  lock() { this.key?.fill(0); this.key = null; this.values.clear(); }

  _need() { if (!this.exists) throw err(409, 'Create the vault first'); if (!this.unlocked) throw err(423, 'The vault is locked. Unlock it first.'); }
  list() {
    return Object.values(this.data?.items || {}).sort((a, b) => a.createdAt - b.createdAt).map((i) => ({ id: i.id, name: i.name, note: i.note || '', createdAt: i.createdAt, assigned: Object.entries(i.assigned || {}).map(([key, a]) => ({ key, label: a.label, grant: a.grant })) }));
  }
  byName(name) { return Object.values(this.data?.items || {}).find((i) => i.name.toLowerCase() === String(name).trim().toLowerCase()); }
  add(name, value, note = '') {
    this._need();
    name = String(name || '').trim().slice(0, 60);
    if (!name) throw err(400, 'Give the secret a name');
    if (!String(value || '')) throw err(400, 'Enter the secret value');
    if (String(value).length > 20000) throw err(400, 'That value is too large');
    if (this.byName(name)) throw err(409, `You already have a secret called "${name}"`);
    const id = randomUUID().slice(0, 8);
    this.data.items[id] = { id, name, note: String(note).slice(0, 300), createdAt: Date.now(), assigned: {}, ...seal(this.key, String(value), id) };
    this.values.set(id, String(value)); this._save();
    return this.list().find((i) => i.id === id);
  }
  update(id, { value, note, assigned }) {
    const it = this.data?.items[id];
    if (!it) throw err(404, 'No such secret');
    if (value !== undefined && value !== '') { this._need(); Object.assign(it, seal(this.key, String(value), id)); this.values.set(id, String(value)); }
    if (note !== undefined) it.note = String(note).slice(0, 300);
    if (assigned !== undefined) {
      it.assigned = {};
      for (const a of [].concat(assigned)) if (a && a.key) it.assigned[String(a.key)] = { label: String(a.label || a.key).slice(0, 80), grant: a.grant === 'always' ? 'always' : 'ask' };
    }
    this._save();
    return this.list().find((i) => i.id === id);
  }
  setGrant(id, key, grant) { const a = this.data?.items[id]?.assigned?.[key]; if (a) { a.grant = grant; this._save(); } }
  remove(id) { if (!this.data?.items[id]) throw err(404, 'No such secret'); delete this.data.items[id]; this.values.delete(id); this._save(); }
  value(id) { return this.values.get(id) ?? null; }

  // Replace every known secret value in a piece of text, so it never reaches chats, logs or memory.
  redact(text, extra = []) {
    return redactPairs(text, [...[...this.values].map(([id, v]) => [this.data.items[id]?.name || 'secret', v]), ...extra]);
  }
}
