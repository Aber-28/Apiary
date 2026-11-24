// Encrypted secrets vault.
//
// Values are encrypted with AES-256-GCM. The key comes from a passphrase (scrypt) that is never stored: it is
// asked for after every start and the derived key lives only in memory. The file holds names, notes and which
// agents may ask for a secret (none of that is secret), and the encrypted values.
import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync, mkdirSync, unlinkSync } from 'node:fs';
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
// What is sealed: the secret value, plus an optional username (some logins need both).
const pack = (value, user) => (user ? JSON.stringify({ apiary: 1, v: value, u: user }) : value);
function unpack(plain) {
  if (plain.startsWith('{"apiary":1')) { try { const o = JSON.parse(plain); return { value: String(o.v ?? ''), user: String(o.u ?? '') }; } catch { /* plain text that looks like JSON */ } }
  return { value: plain, user: '' };
}
// Kinds of secret: a login (username + password), an SSH login (host + user + password or private key), or a token / API key.
export const TYPES = ['login', 'ssh', 'token'];
export const typeOf = (i) => (TYPES.includes(i.type) ? i.type : i.hasUser ? 'login' : 'token');
function connection(type, { host, port, auth, username }, value) {
  if (type !== 'ssh') return {};
  host = String(host || '').trim();
  if (!/^[A-Za-z0-9]([A-Za-z0-9.:_-]{0,251}[A-Za-z0-9])?$|^\[[0-9a-fA-F:]+\]$/.test(host)) throw err(400, 'Enter the server name or IP address, for example 10.0.0.5 or server.example.com');
  const p = port === undefined || port === '' ? 22 : Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw err(400, 'The port must be a number from 1 to 65535');
  if (!String(username || '').trim()) throw err(400, 'Enter the username to log in as');
  if (/[\s@]/.test(String(username).trim())) throw err(400, 'The username cannot contain spaces or @');
  auth = auth === 'key' ? 'key' : 'password';
  if (auth === 'key' && value !== undefined && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) throw err(400, 'That does not look like a private key. It should start with -----BEGIN … PRIVATE KEY-----');
  return { host, port: p, auth };
}
const cleanKey = (v) => String(v).replace(/\r\n?/g, '\n').trim() + '\n';
export const envName = (name) => 'APIARY_SECRET_' + String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

export class Vault {
  // keyFile (optional) is where the auto-unlock key lives. It is kept apart from the vault, so copying or
  // exporting the data folder does not carry the key with it.
  constructor(file, keyFile = '') {
    this.file = file; this.keyFile = keyFile;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.data = null; this.key = null; this.values = new Map(); this.users = new Map(); this._fails = 0;
    if (existsSync(file)) { try { this.data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.error('Could not read the vault file:', e.message); } }
    this.autoProblem = '';
    this._tryAuto();
  }
  // 'off', 'on', or 'broken' (turned on, but the key file is missing or does not match this vault)
  get auto() { return !this.data?.auto ? 'off' : this.autoProblem ? 'broken' : 'on'; }
  _tryAuto() {
    if (!this.data?.auto || !this.keyFile) return;
    try {
      const wrap = readFileSync(this.keyFile); if (wrap.length !== 32) throw new Error('bad key file');
      const key = unb64(open(wrap, this.data.auto, 'autounlock'));
      if (open(key, this.data.verify, 'verify') !== CHECK) throw new Error('bad');
      this._open(key); this.autoProblem = '';
    } catch { this.autoProblem = 'Auto-unlock is on, but its key file is missing or does not belong to this vault. Unlock with your passphrase and turn it on again.'; }
  }
  _open(key) {
    this.key = key; this.values.clear(); this.users.clear();
    for (const it of Object.values(this.data.items)) { try { const x = unpack(open(key, it, it.id)); this.values.set(it.id, x.value); if (x.user) this.users.set(it.id, x.user); } catch { /* skip a damaged item */ } }
  }
  // Keep the unlock key on this machine (private file, only this user) so a restart does not lock the vault.
  enableAuto(pass) {
    this._need();
    if (!this.keyFile) throw err(400, 'Auto-unlock is not available here.');
    const key = this._derive(pass, unb64(this.data.salt));
    try { if (open(key, this.data.verify, 'verify') !== CHECK) throw new Error('bad'); } catch { throw err(403, 'Wrong passphrase'); }
    const wrap = randomBytes(32);
    mkdirSync(path.dirname(this.keyFile), { recursive: true, mode: 0o700 });
    const tmp = this.keyFile + '.tmp'; writeFileSync(tmp, wrap, { mode: 0o600 }); renameSync(tmp, this.keyFile);
    try { chmodSync(this.keyFile, 0o600); chmodSync(path.dirname(this.keyFile), 0o700); } catch { /* best effort */ }
    this.data.auto = seal(wrap, b64(key), 'autounlock'); this.autoProblem = ''; this._save();
  }
  disableAuto() {
    if (this.data) { delete this.data.auto; this._save(); }
    this.autoProblem = '';
    try { if (this.keyFile) unlinkSync(this.keyFile); } catch { /* already gone */ }
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
    this.key = key; this.values.clear(); this.users.clear(); this._save();
  }
  async unlock(pass) {
    if (!this.exists) throw err(409, 'There is no vault yet. Create one first.');
    if (this._fails) await new Promise((r) => setTimeout(r, Math.min(this._fails, 5) * 600));   // slow down guessing
    const key = this._derive(pass, unb64(this.data.salt));
    try { if (open(key, this.data.verify, 'verify') !== CHECK) throw new Error('bad'); }
    catch { this._fails++; throw err(403, 'Wrong passphrase'); }
    this._fails = 0; this._open(key);
  }
  lock() { this.key?.fill(0); this.key = null; this.values.clear(); this.users.clear(); }

  _need() { if (!this.exists) throw err(409, 'Create the vault first'); if (!this.unlocked) throw err(423, 'The vault is locked. Unlock it first.'); }
  list() {
    return Object.values(this.data?.items || {}).sort((a, b) => a.createdAt - b.createdAt).map((i) => ({ id: i.id, name: i.name, note: i.note || '', createdAt: i.createdAt, username: this.users.get(i.id) || '', hasUsername: !!i.hasUser, type: typeOf(i), host: i.host || '', port: i.port || 0, auth: i.auth || '', assigned: Object.entries(i.assigned || {}).map(([key, a]) => ({ key, label: a.label, grant: a.grant })) }));
  }
  byName(name) { return Object.values(this.data?.items || {}).find((i) => i.name.toLowerCase() === String(name).trim().toLowerCase()); }
  add(name, value, note = '', username = '', meta = {}) {
    this._need();
    name = String(name || '').trim().slice(0, 60);
    if (!name) throw err(400, 'Give the secret a name');
    if (!String(value || '')) throw err(400, 'Enter the secret value');
    if (String(value).length > 20000) throw err(400, 'That value is too large');
    if (this.byName(name)) throw err(409, `You already have a secret called "${name}"`);
    const type = TYPES.includes(meta.type) ? meta.type : String(username || '').trim() ? 'login' : 'token';
    const id = randomUUID().slice(0, 8), user = type === 'token' ? '' : String(username || '').trim().slice(0, 200);
    const conn = connection(type, { ...meta, username: user }, type === 'ssh' && meta.auth === 'key' ? String(value) : undefined);
    if (conn.auth === 'key') value = cleanKey(value);
    this.data.items[id] = { id, name, note: String(note).slice(0, 300), createdAt: Date.now(), assigned: {}, hasUser: !!user, type, ...conn, ...seal(this.key, pack(String(value), user), id) };
    this.values.set(id, String(value)); if (user) this.users.set(id, user); this._save();
    return this.list().find((i) => i.id === id);
  }
  update(id, { value, username, note, assigned, host, port, auth }) {
    const it = this.data?.items[id];
    if (!it) throw err(404, 'No such secret');
    if (typeOf(it) === 'ssh' && (host !== undefined || port !== undefined || auth !== undefined)) {
      const u = username !== undefined ? username : this.users.get(id) || '';
      const nextAuth = auth !== undefined ? auth : it.auth;
      const c = connection('ssh', { host: host ?? it.host, port: port ?? it.port, auth: nextAuth, username: u }, nextAuth === 'key' && value ? String(value) : undefined);
      if (c.auth !== it.auth && !(value !== undefined && value !== '')) throw err(400, `Changing to ${c.auth === 'key' ? 'a private key' : 'a password'} needs the new ${c.auth === 'key' ? 'key' : 'password'} too. Use Replace secret.`);
      Object.assign(it, c);
    }
    if (typeOf(it) === 'ssh' && it.auth === 'key' && value !== undefined && value !== '') { if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(String(value))) throw err(400, 'That does not look like a private key. It should start with -----BEGIN … PRIVATE KEY-----'); value = cleanKey(value); }
    if ((value !== undefined && value !== '') || username !== undefined) {
      this._need();
      const val = value !== undefined && value !== '' ? String(value) : this.values.get(id);
      const user = username !== undefined ? String(username || '').trim().slice(0, 200) : this.users.get(id) || '';
      if (val === undefined) throw err(409, 'That secret could not be read, so it cannot be changed');
      Object.assign(it, seal(this.key, pack(val, user), id)); it.hasUser = !!user;
      this.values.set(id, val); if (user) this.users.set(id, user); else this.users.delete(id);
    }
    if (note !== undefined) it.note = String(note).slice(0, 300);
    if (assigned !== undefined) {
      it.assigned = {};
      const list = Array.isArray(assigned) ? assigned : Object.entries(assigned || {}).map(([key, a]) => ({ ...a, key }));   // a list, or a map by key
      for (const a of list) if (a && a.key) it.assigned[String(a.key)] = { label: String(a.label || a.key).slice(0, 80), grant: a.grant === 'always' ? 'always' : 'ask' };
    }
    this._save();
    return this.list().find((i) => i.id === id);
  }
  assign(id, key, label, grant) { const it = this.data?.items[id]; if (!it) throw err(404, 'No such secret'); (it.assigned ||= {})[key] = { label: String(label || key).slice(0, 80), grant: grant === 'always' ? 'always' : 'ask' }; this._save(); }
  setGrant(id, key, grant) { const a = this.data?.items[id]?.assigned?.[key]; if (a) { a.grant = grant; this._save(); } }
  remove(id) { if (!this.data?.items[id]) throw err(404, 'No such secret'); delete this.data.items[id]; this.values.delete(id); this._save(); }
  value(id) { return this.values.get(id) ?? null; }
  user(id) { return this.users.get(id) || ''; }

  // Replace every known secret value in a piece of text, so it never reaches chats, logs or memory.
  redact(text, extra = []) {
    return redactPairs(text, [...[...this.values].map(([id, v]) => [this.data.items[id]?.name || 'secret', v]), ...extra]);
  }
}
