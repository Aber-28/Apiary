// Automatic backups: the same export you can make by hand, on a schedule, with the newest few kept.
// Each file is checked right after it is written (it is opened and its list of contents read), so a backup
// that cannot be read is reported at once, not found out on the day you need it.
import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync, chmodSync, renameSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { exportTo } from './transfer.js';

const err = (status, message) => Object.assign(new Error(message), { status });
const NAME = /^apiary-backup-\d{8}-\d{6}\.tgz$/;
const DEFAULTS = { enabled: false, every: 'daily', time: '02:00', weekday: 0, keep: 7, vault: true, files: true, dir: '', dir2: '' };
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

// The latest moment a backup was due, at or before `now`.
export function lastDue(cfg, now = new Date()) {
  const [h, m] = String(cfg.time || '02:00').split(':').map(Number);
  const d = new Date(now); d.setHours(h, m, 0, 0);
  if (cfg.every === 'weekly') { d.setDate(d.getDate() - ((d.getDay() - cfg.weekday + 7) % 7)); if (d > now) d.setDate(d.getDate() - 7); }
  else if (d > now) d.setDate(d.getDate() - 1);
  return d;
}

export class Backups {
  constructor(engine, version = '') { this.engine = engine; this.version = version; this.running = false; }
  get st() { return (this.engine.store.data.settings.backup ||= {}); }
  get config() {
    const c = { ...DEFAULTS, ...(this.st.config || {}) };
    if (!c.dir) c.dir = path.join(path.dirname(this.engine.store.file), 'backups');
    return c;
  }
  get status() { const { lastRun = 0, lastOk = 0, lastError = '', lastFile = '', lastSize = 0, lastCopyError = '' } = this.st; return { lastRun, lastOk, lastError, lastFile, lastSize, lastCopyError, running: this.running }; }

  _dir(p, label) {
    p = String(p || '').trim();
    if (!p) return '';
    if (!path.isAbsolute(p) || p.split(path.sep).includes('..')) throw err(400, `${label}: type a full folder path starting with /, for example /mnt/nas/apiary-backups`);
    const r = path.resolve(p);
    if (r === '/' || r === os.homedir()) throw err(400, `${label}: choose a folder just for backups, not ${r}`);
    return r;
  }
  setConfig(b = {}) {
    const cur = this.config, c = { ...cur };
    if (b.enabled !== undefined) c.enabled = !!b.enabled;
    if (b.every !== undefined) { if (!['daily', 'weekly'].includes(b.every)) throw err(400, 'Choose daily or weekly'); c.every = b.every; }
    if (b.time !== undefined) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time)) throw err(400, 'The time must look like 02:00'); c.time = b.time; }
    if (b.weekday !== undefined) { const w = Number(b.weekday); if (!Number.isInteger(w) || w < 0 || w > 6) throw err(400, 'Choose a day of the week'); c.weekday = w; }
    if (b.keep !== undefined) { const k = Number(b.keep); if (!Number.isInteger(k) || k < 1 || k > 60) throw err(400, 'Keep between 1 and 60 backups'); c.keep = k; }
    if (b.vault !== undefined) c.vault = !!b.vault;
    if (b.files !== undefined) c.files = !!b.files;
    if (b.dir !== undefined) c.dir = this._dir(b.dir, 'Backup folder') || path.join(path.dirname(this.engine.store.file), 'backups');
    if (b.dir2 !== undefined) c.dir2 = this._dir(b.dir2, 'Second folder');
    if (c.dir2 && c.dir2 === c.dir) throw err(400, 'The second folder must be different from the first');
    if (c.enabled && !cur.enabled) this.st.lastRun = Math.max(this.st.lastRun || 0, Date.now());   // enabling does not run one at once; "Back up now" does
    this.st.config = c; this.engine.store.save(); return this.config;
  }

  list() {
    const c = this.config;
    if (!existsSync(c.dir)) return [];
    return readdirSync(c.dir).filter((n) => NAME.test(n)).map((n) => { const s = statSync(path.join(c.dir, n)); return { name: n, size: s.size, at: s.mtimeMs }; }).sort((a, b) => b.at - a.at);
  }
  file(name) { if (!NAME.test(String(name))) throw err(404, 'No such backup'); const f = path.join(this.config.dir, name); if (!existsSync(f)) throw err(404, 'No such backup'); return f; }

  // The tar listing must contain the data file, or the backup is not trusted.
  verify(file) {
    const r = spawnSync('tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) throw new Error('The backup could not be read back (' + String(r.stderr || '').trim().slice(0, 120) + ')');
    const names = r.stdout.split('\n');
    if (!names.includes('state.json')) throw new Error('The backup does not contain the main data file');
    return names.length;
  }
  _prune(dir, keep) {
    if (!existsSync(dir)) return;
    const all = readdirSync(dir).filter((n) => NAME.test(n)).sort().reverse();   // names sort by date
    for (const n of all.slice(keep)) { try { unlinkSync(path.join(dir, n)); } catch { /* leave it */ } }
  }

  async run(reason = 'manual') {
    if (this.running) throw err(409, 'A backup is already running');
    this.running = true; const c = this.config, st = this.st; st.lastRun = Date.now();
    try {
      mkdirSync(c.dir, { recursive: true, mode: 0o700 });
      let when = new Date(), name = `apiary-backup-${stamp(when)}.tgz`;
      while (existsSync(path.join(c.dir, name))) { when = new Date(when.getTime() + 1000); name = `apiary-backup-${stamp(when)}.tgz`; }   // never overwrite a backup
      const final = path.join(c.dir, name), tmp = final + '.tmp';
      const out = createWriteStream(tmp, { mode: 0o600 });
      const { done } = exportTo(this.engine, out, { vault: c.vault, files: c.files, version: this.version });
      await done; if (!out.writableFinished) await once(out, 'finish');
      this.verify(tmp); renameSync(tmp, final); try { chmodSync(final, 0o600); } catch { /* best effort */ }
      st.lastOk = Date.now(); st.lastError = ''; st.lastFile = name; st.lastSize = statSync(final).size; st.lastCopyError = '';
      this._prune(c.dir, c.keep);
      if (c.dir2) {   // a copy somewhere else: a backup on the same disk does not survive the disk
        try { mkdirSync(c.dir2, { recursive: true, mode: 0o700 }); copyFileSync(final, path.join(c.dir2, name)); chmodSync(path.join(c.dir2, name), 0o600); this._prune(c.dir2, c.keep); }
        catch (e) { st.lastCopyError = `The copy to ${c.dir2} failed: ${e.message}`; }
      }
      this.engine.store.save(); this.engine.emit('event', { type: 'backup' });
      this.engine.audit?.add('backup', { actor: reason === 'manual' ? 'You' : 'Schedule', action: 'backup made', detail: name });
      return { name, size: st.lastSize, reason, copyError: st.lastCopyError };
    } catch (e) {
      this.engine.audit?.add('backup', { actor: reason === 'manual' ? 'You' : 'Schedule', action: 'backup failed', detail: e.message });
      st.lastError = e.message; this.engine.store.save(); this.engine.emit('event', { type: 'backup' });
      try { unlinkSync(path.join(c.dir, '.tmp')); } catch { /* none */ }
      throw e;
    } finally { this.running = false; }
  }
  // Called every minute.
  async tick(now = new Date()) {
    const c = this.config;
    if (!c.enabled || this.running) return null;
    if ((this.st.lastRun || 0) >= lastDue(c, now).getTime()) return null;
    try { return await this.run('schedule'); } catch { return null; }
  }
}
