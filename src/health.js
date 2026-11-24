// Health: looks for things that are about to break, or already have, and says what to do about each.
// A check runs every few minutes (and on demand). It also probes the devices on the map, so a device that
// stops answering turns red by itself.
import { statfsSync, existsSync } from 'node:fs';
import path from 'node:path';

const GB = (n) => (n >= 1e9 ? (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + ' GB' : Math.round(n / 1e6) + ' MB');
const mins = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`; };
export const LOGIN_RE = /not logged in|please (run )?\/?login|log ?in again|authentication[_ ]?(failed|error|required)|invalid (api[ _-]?key|x-api-key|token|credentials)|unauthori[sz]ed|\b401\b|token (has )?expired|session (has )?expired|sign in again|credentials? (has |have )?expired/i;
const LEVEL = { ok: 0, info: 1, warn: 2, err: 3 };

export class Health {
  constructor(engine) { this.engine = engine; this.state = { at: 0, items: [], level: 'ok' }; this.running = false; this.authFail = {}; }
  // The checks that need no network. Each item: { id, level, title, problem, fix, link }.
  evaluate(now = Date.now()) {
    const e = this.engine, out = [];
    // disk
    try {
      const dir = path.dirname(e.store.file), s = statfsSync(dir), total = s.blocks * s.bsize, free = s.bavail * s.bsize, pct = total ? free / total : 1;
      if (pct < 0.05 || free < 1e9) out.push({ id: 'disk', level: 'err', title: 'The disk is almost full', problem: `Only ${GB(free)} is free (${Math.round(pct * 100)}%). Apiary and its agents stop working when the disk is full.`, fix: 'Free some space: delete old backups, close projects you no longer need, or clear downloads. Then check again.', link: '#/backups' });
      else if (pct < 0.15 || free < 5e9) out.push({ id: 'disk', level: 'warn', title: 'The disk is getting full', problem: `${GB(free)} is free (${Math.round(pct * 100)}%).`, fix: 'Plan to free some space soon: old backups, finished projects and downloads are the usual culprits.', link: '#/backups' });
    } catch { /* not readable here */ }
    // devices on the map
    for (const it of e.infra.items) {
      if (!it.status || it.status.ok) continue;
      out.push({ id: 'device-' + it.id, level: 'err', title: `${it.name} is not answering`, problem: `${it.status.detail || 'No answer'}. Last checked ${mins(now - it.status.at)} ago.`, fix: 'Check that it is powered on and on the network, then press Test on the Devices page. If it has moved, edit its address.', link: '#/infrastructure' });
    }
    // logins
    for (const [prov, f] of Object.entries(this.authFail)) {
      if (now - f.at > 24 * 3600000) continue;
      const name = prov === 'claude' ? 'Claude' : prov === 'codex' ? 'Codex' : prov;
      out.push({ id: 'login-' + prov, level: 'err', title: `The ${name} login looks expired`, problem: `The last task that used ${name} failed with a sign-in problem (${mins(now - f.at)} ago).`, fix: `Sign in to ${name} again on this computer (open a terminal and run ${prov === 'codex' ? 'codex login' : 'claude'} then /login), then press Test connection on the Connections page.`, link: '#/connections' });
    }
    const gh = e.connections?._cache?.get('github')?.v;
    if (gh && gh.status && gh.status.ok === false && (gh.token?.saved || gh.cli?.found)) out.push({ id: 'login-github', level: 'warn', title: 'The GitHub login is not working', problem: gh.status.reason || 'GitHub did not accept the saved login.', fix: 'Sign in again (gh auth login) or save a new token on the Connections page.', link: '#/connections' });
    // the secrets vault
    if (e.vault.exists && !e.vault.unlocked) out.push({ id: 'vault', level: 'warn', title: 'The secrets vault is locked', problem: 'Agents cannot use passwords or keys until it is unlocked, and tasks that need them will wait.', fix: e.vault.autoProblem ? `Unlock it on the Secrets page. Auto-unlock is on but is not working: ${e.vault.autoProblem}` : 'Unlock it on the Secrets page, or turn on auto-unlock so it opens by itself after a restart.', link: '#/secrets' });
    else if (e.vault.exists && e.vault.autoProblem) out.push({ id: 'vault-auto', level: 'warn', title: 'Vault auto-unlock is not working', problem: e.vault.autoProblem, fix: 'Open the Secrets page and turn auto-unlock off and on again.', link: '#/secrets' });
    // backups
    const b = e.backups, c = b.config, st = b.status;
    if (c.enabled && st.lastError) out.push({ id: 'backup-failed', level: 'err', title: 'The last backup failed', problem: st.lastError, fix: 'Open Backups, fix the problem (often the folder or free space) and press Back up now.', link: '#/backups' });
    else if (c.enabled && st.lastOk && now - st.lastOk > (c.every === 'weekly' ? 9 : 2.5) * 86400000) out.push({ id: 'backup-old', level: 'warn', title: 'Backups have stopped', problem: `The last good backup was ${mins(now - st.lastOk)} ago.`, fix: 'Open Backups and press Back up now, then check the schedule.', link: '#/backups' });
    else if (!c.enabled) out.push({ id: 'backup-off', level: 'info', title: 'Automatic backups are off', problem: 'If this disk fails, everything is lost.', fix: 'Turn them on in Settings > Backups, ideally with a second place to copy to.', link: '#/backups' });
    if (st.lastCopyError && c.enabled) out.push({ id: 'backup-copy', level: 'warn', title: 'The second backup copy failed', problem: st.lastCopyError, fix: 'Check that the second folder or network share is mounted and writable.', link: '#/backups' });
    out.sort((x, y) => LEVEL[y.level] - LEVEL[x.level]);
    return out;
  }
  // Probe the devices (so the map is up to date), then evaluate.
  async run({ probe = true } = {}) {
    if (this.running) return this.state;
    this.running = true;
    try {
      if (probe) await Promise.all(this.engine.infra.items.filter((i) => i.address || i.url).map((i) => this.engine.infra.test(i.id).catch(() => {})));
      if (probe) await this.engine.connections.view('github').catch(() => {});
      const items = this.evaluate();
      const level = items.reduce((m, i) => (LEVEL[i.level] > LEVEL[m] ? i.level : m), 'ok');
      const prev = new Set(this.state.items.map((i) => i.id + ':' + i.level));
      const fresh = items.filter((i) => !prev.has(i.id + ':' + i.level));
      this.state = { at: Date.now(), items, level };
      if (probe) this.engine.emit('event', { type: 'infra' });
      this.engine.emit('event', { type: 'health', level, count: this.count });
      for (const i of fresh) if (i.level !== 'info') this.engine.emit('health-new', i);
      return this.state;
    } finally { this.running = false; }
  }
  get count() { return this.state.items.filter((i) => i.level === 'warn' || i.level === 'err').length; }
  get summary() { return { at: this.state.at, level: this.state.level, count: this.count }; }
  noteLoginFailure(provider, message) { if (LOGIN_RE.test(String(message))) this.authFail[provider] = { at: Date.now(), msg: String(message).slice(0, 200) }; }
  noteSuccess(provider) { delete this.authFail[provider]; }
}
