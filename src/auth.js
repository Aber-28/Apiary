// Sign-in for the web portal: one username and password, so Apiary can be used from any laptop.
//
// The password is never stored, only a salted scrypt hash. A sign-in gives a cookie that is signed with a
// secret kept in the same private file, so it survives restarts and stops working when the password changes.
// Wrong guesses are slowed down, per address and per account name.
import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync, mkdirSync, statSync } from 'node:fs';
import { randomBytes, scrypt, scryptSync, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

const PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const DAYS = 14, MAX_DELAY = 60000;
const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const hash = (pw, salt) => new Promise((res, rej) => scrypt(String(pw), salt, 32, PARAMS, (e, k) => (e ? rej(e) : res(k))));
const eq = (a, b) => a.length === b.length && timingSafeEqual(a, b);
export const COOKIE = 'apiary_session';

export function checkNew(username, password) {
  const u = String(username || '').trim();
  if (!/^[A-Za-z0-9._@-]{3,40}$/.test(u)) throw err(400, 'The username must be 3 to 40 letters, numbers, dots, dashes or underscores.');
  const p = String(password || '');
  if (p.length < 10) throw err(400, 'The password must be at least 10 characters. A few random words is a good choice.');
  if (p.length > 200) throw err(400, 'That password is too long.');
  if (p.toLowerCase().includes(u.toLowerCase()) || /^(.)\1+$/.test(p)) throw err(400, 'Choose a password that is not easy to guess.');
  return u;
}

export class Auth {
  constructor(file) {
    this.file = file; this.fails = new Map(); this._mtime = 0; this.data = null; this._load();
  }
  _load() {
    try { const st = statSync(this.file); if (st.mtimeMs === this._mtime && this.data) return; this._mtime = st.mtimeMs; this.data = JSON.parse(readFileSync(this.file, 'utf8')); }
    catch { this.data = null; this._mtime = 0; }
  }
  // Changes made from the command line while Apiary runs are picked up here.
  get exists() { this._load(); return !!this.data?.hash; }
  get username() { this._load(); return this.data?.username || ''; }
  _save() {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + '.tmp'; writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 }); renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* best effort */ }
    this._mtime = statSync(this.file).mtimeMs;
  }

  async set(username, password) {
    const u = checkNew(username, password), salt = randomBytes(16);
    // a new secret signs the cookies, which signs everyone else out
    this.data = { v: 1, username: u, salt: salt.toString('base64'), hash: (await hash(password, salt)).toString('base64'), secret: randomBytes(32).toString('base64'), changedAt: Date.now() };
    this._save();
  }
  async remove() { this.data = null; try { writeFileSync(this.file, '{}', { mode: 0o600 }); this._mtime = statSync(this.file).mtimeMs; } catch { /* nothing to remove */ } }

  async _ok(username, password) {
    this._load();
    const salt = Buffer.from(this.data?.salt || 'AAAAAAAAAAAAAAAAAAAAAA==', 'base64');
    const got = await hash(password, salt);   // always done, so a wrong username takes as long as a wrong password
    const want = Buffer.from(this.data?.hash || '', 'base64');
    const sameUser = String(username || '').trim().toLowerCase() === String(this.data?.username || '\0').toLowerCase();
    return !!this.data?.hash && sameUser && eq(got, want);
  }
  _wait(keys) {
    const now = Date.now();
    return Math.max(0, ...keys.map((k) => { const f = this.fails.get(k); return f ? f.until - now : 0; }));
  }
  _fail(keys) {
    for (const k of keys) { const f = this.fails.get(k) || { n: 0, until: 0 }; f.n++; f.until = Date.now() + (f.n > 3 ? Math.min(MAX_DELAY, 1000 * 2 ** (f.n - 3)) : 0); this.fails.set(k, f); }
    if (this.fails.size > 5000) this.fails.clear();
  }
  // Returns a cookie value when the username and password are right.
  async login(username, password, ip = '?') {
    const keys = [`ip:${ip}`, `user:${String(username || '').trim().toLowerCase()}`];
    const wait = this._wait(keys);
    if (wait > 0) throw err(429, `Too many wrong tries. Wait ${Math.ceil(wait / 1000)} seconds and try again.`, { retryAfter: Math.ceil(wait / 1000) });
    // Count the try BEFORE checking it. Otherwise many guesses sent at the same moment all pass the lock check together.
    this._fail(keys);
    if (!(await this._ok(username, password))) throw err(401, 'Wrong username or password.');
    for (const k of keys) this.fails.delete(k);
    return this.cookie();
  }
  // Same slow-down as sign-in, so the account page cannot be used to guess the password quickly. Throws 429 while locked.
  async verifyThrottled(password, ip = '?') {
    const keys = [`acct:ip:${ip}`, 'acct:all'];
    const wait = this._wait(keys);
    if (wait > 0) throw err(429, `Too many wrong tries. Wait ${Math.ceil(wait / 1000)} seconds and try again.`, { retryAfter: Math.ceil(wait / 1000) });
    this._fail(keys); // counted before the check, so guesses sent in parallel cannot slip past the lock
    const ok = await this.verify(password);
    if (ok) for (const k of keys) this.fails.delete(k);
    return ok;
  }
  async verify(password) { this._load(); if (!this.exists) return false; return this._ok(this.data.username, password); }

  cookie() {
    this._load();
    const exp = Date.now() + DAYS * 864e5, mac = createHmac('sha256', Buffer.from(this.data.secret, 'base64')).update(`${this.data.username}.${exp}`).digest('base64url');
    return `${exp}.${mac}`;
  }
  validCookie(value) {
    this._load();
    if (!this.data?.secret || typeof value !== 'string') return false;
    const [exp, mac] = value.split('.');
    if (!/^\d{10,16}$/.test(exp || '') || Number(exp) < Date.now() || !mac) return false;
    const want = createHmac('sha256', Buffer.from(this.data.secret, 'base64')).update(`${this.data.username}.${exp}`).digest('base64url');
    return mac.length === want.length && timingSafeEqual(Buffer.from(mac), Buffer.from(want));
  }
}
export const maxAge = DAYS * 86400;
void scryptSync; void existsSync;
