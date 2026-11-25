// Update checker for installs made from GitHub (the install script clones the repo).
//
//   check()   fetches the newest commits from GitHub into the local git store. That is the "download":
//             nothing in the running app is changed. If the newest version is higher than ours the
//             state becomes "ready" and the interface shows an Install button.
//   install() fast-forwards the checkout to what was downloaded (and refreshes dependencies if the
//             project ever has any). The caller then restarts the app.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';

const G = (dir, args, o = {}) => run('git', args, { cwd: dir, env: { GIT_TERMINAL_PROMPT: '0', ...(o.env || {}) }, timeout: o.timeout ?? 120000 });

export function cmpVer(a, b) {
  const p = (s) => String(s || '0').replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  return 0;
}

// The part of the changelog between the new version and the one we have.
export function notesBetween(changelog, current) {
  const out = [];
  for (const block of String(changelog).split(/^## /m).slice(1)) {
    const ver = block.split('\n')[0].trim();
    if (cmpVer(ver, current) <= 0) break;
    out.push(`## ${block.trim()}`);
  }
  return out.join('\n\n').slice(0, 4000);
}

export class Updater {
  constructor({ dir, current, branch = 'main', authArgs = () => [] }) {
    this.dir = dir; this.branch = branch; this.authArgs = authArgs;
    this.s = { state: 'idle', current, latest: null, checkedAt: null, notes: '', error: '' };
    this.busy = null; this.pace = process.env.APIARY_UPDATE_PACE != null ? Number(process.env.APIARY_UPDATE_PACE) : 450;
  }
  get status() { return { ...this.s }; }

  async _supported() {
    const inside = await G(this.dir, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0) return 'This copy of Apiary was not installed with git, so it cannot update itself. Re-run the install command instead.';
    const remote = await G(this.dir, ['remote', 'get-url', 'origin']);
    if (remote.code !== 0) return 'This copy of Apiary has no GitHub remote to update from.';
    return '';
  }

  check() {
    if (this.busy) return this.busy;
    this.busy = this._check().finally(() => { this.busy = null; });
    return this.busy;
  }
  async _check() {
    const s = this.s;
    if (s.state === 'installing') return this.status;
    const why = await this._supported();
    if (why) { Object.assign(s, { state: 'unsupported', error: why, checkedAt: Date.now() }); return this.status; }
    s.state = 'checking'; s.error = '';
    const f = await G(this.dir, [...this.authArgs(), 'fetch', '--quiet', 'origin', this.branch], { timeout: 300000 });
    s.checkedAt = Date.now();
    if (f.code !== 0) { Object.assign(s, { state: 'error', error: `Could not reach GitHub: ${(f.stderr || f.stdout).trim().slice(-300) || 'unknown error'}` }); return this.status; }
    const pkg = await G(this.dir, ['show', `origin/${this.branch}:package.json`]);
    let latest; try { latest = JSON.parse(pkg.stdout).version; } catch { /* handled below */ }
    if (!latest) { Object.assign(s, { state: 'error', error: 'Could not read the version on GitHub.' }); return this.status; }
    s.latest = latest;
    if (cmpVer(latest, s.current) <= 0) { Object.assign(s, { state: 'uptodate', notes: '' }); return this.status; }
    const ff = await G(this.dir, ['merge-base', '--is-ancestor', 'HEAD', `origin/${this.branch}`]);
    if (ff.code !== 0) { Object.assign(s, { state: 'error', error: 'This copy has local changes that GitHub does not have, so it cannot be updated automatically. Update it by hand with git.' }); return this.status; }
    const log = await G(this.dir, ['show', `origin/${this.branch}:CHANGELOG.md`]);
    Object.assign(s, { state: 'ready', notes: log.code === 0 ? notesBetween(log.stdout, s.current) : '' });
    return this.status;
  }

  // Installing is slow enough that people think it has frozen, so every step is recorded for the screen.
  _steps() { return ['Check the downloaded update', 'Apply the new version', 'Install what it needs', 'Check the new files', 'Restart Apiary'].map((label, i) => ({ id: i, label, state: 'wait' })); }
  _p(i, state, line) {
    const pr = this.s.progress; if (!pr) return;
    if (i != null) pr.steps[i].state = state;
    if (line) { pr.log.push(`${new Date().toLocaleTimeString()}  ${line}`); pr.log = pr.log.slice(-60); }
    const done = pr.steps.filter((x) => ['done', 'skip'].includes(x.state)).length, run = pr.steps.some((x) => x.state === 'run') ? 0.5 : 0;
    pr.pct = Math.min(100, Math.round(((done + run) / pr.steps.length) * 100));
  }
  async _pause() { if (this.pace) await new Promise((r) => setTimeout(r, this.pace)); }
  // The restart step is started by the caller (the server), after this returns.
  markRestarting() { this._p(4, 'run', 'Restarting Apiary. This page will come back by itself in a few seconds.'); }

  async install() {
    const s = this.s;
    if (s.state !== 'ready') throw Object.assign(new Error('There is no downloaded update to install. Check for updates first.'), { status: 409 });
    s.state = 'installing'; s.error = ''; s.progress = { steps: this._steps(), pct: 0, log: [], failed: false, from: s.current, to: s.latest };
    let before = '';
    try {
      this._p(0, 'run', `Update ${s.current} to ${s.latest} is already downloaded`); await this._pause();
      before = (await G(this.dir, ['rev-parse', 'HEAD'])).stdout.trim();
      this._before = before;
      const ahead = await G(this.dir, ['rev-list', '--count', `HEAD..origin/${this.branch}`]);
      this._p(0, 'done', `${ahead.stdout.trim() || '?'} change${ahead.stdout.trim() === '1' ? '' : 's'} to apply`);
      this._p(1, 'run', 'Applying the new version'); await this._pause();
      const m = await G(this.dir, ['merge', '--ff-only', `origin/${this.branch}`], { timeout: 120000 });
      if (m.code !== 0) throw new Error(`Could not apply the update: ${(m.stderr || m.stdout).trim().slice(-300)}`);
      const stat = (m.stdout || '').trim().split('\n').slice(-1)[0];
      this._p(1, 'done', stat || 'Files updated');
      const pkg = JSON.parse(readFileSync(path.join(this.dir, 'package.json'), 'utf8'));
      if (Object.keys(pkg.dependencies || {}).length) {
        this._p(2, 'run', 'Installing what the new version needs (this can take a minute)');
        const n = await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: this.dir, timeout: 600000 });
        if (n.code !== 0) throw new Error(`npm install failed: ${(n.stderr || n.stdout).trim().slice(-300)}`);
        this._p(2, 'done', 'Done');
      } else this._p(2, 'skip', 'Nothing extra to install');
      await this._pause();
      this._p(3, 'run', 'Checking that the new files load');
      for (const f of ['src/server.js', 'src/engine.js'].filter((x) => existsSync(path.join(this.dir, x)))) {
        const c = await run(process.execPath, ['--check', path.join(this.dir, f)], { timeout: 30000 });
        if (c.code !== 0) throw new Error(`The new version failed its check (${f}): ${(c.stderr || '').trim().slice(-200)}`);
      }
      this._p(3, 'done', `Version ${pkg.version} looks good`); await this._pause();
      return { version: pkg.version };
    } catch (e) {
      if (before) {
        // Dependencies changed by the update must go back too, or the old code would run with the new packages.
        const depsChanged = (await G(this.dir, ['diff', '--name-only', before, 'HEAD', '--', 'package.json', 'package-lock.json'])).stdout.trim();
        await G(this.dir, ['reset', '--hard', before]);
        this._p(null, null, 'Put the old version back so nothing is broken');
        if (depsChanged && existsSync(path.join(this.dir, 'package.json'))) {
          const r = await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: this.dir, timeout: 600000 });
          this._p(null, null, r.code === 0 ? 'The old packages are back in place' : 'Could not put the old packages back: run "npm install" in the Apiary folder');
        }
      }
      const pr = s.progress; if (pr) { pr.failed = true; const cur = pr.steps.find((x) => x.state === 'run'); if (cur) cur.state = 'fail'; this._p(null, null, e.message); }
      Object.assign(s, { state: 'ready', error: e.message });   // still downloaded; the person can retry
      throw Object.assign(e, { status: 500 });
    }
  }
}
