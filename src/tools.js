// Installs the AI command-line tools (Claude Code, Codex) for the person, from inside Apiary, with progress.
//
// Everything is installed for the current user only, never with sudo:
//   Claude Code: Anthropic's own installer (https://claude.ai/install.sh) which puts `claude` in ~/.local/bin.
//   Codex:       npm, into the ~/.local prefix, so `codex` also lands in ~/.local/bin.
// The page watches `status` while it runs: a progress bar, a list of steps and a live log (like the update screen).
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { which } from './providers.js';

const HOME_BIN = path.join(os.homedir(), '.local', 'bin');
const LABEL = { claude: 'Claude Code', codex: 'Codex' };
const strip = (s) => String(s).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n');

export const RECIPES = {
  claude: {
    label: 'Claude Code',
    needs: [['curl', 'curl is needed to download it. Install it with: sudo apt-get install -y curl']],
    cmd: 'bash', args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'],
    login: 'claude',
  },
  codex: {
    label: 'Codex',
    needs: [['npm', 'npm is needed to install it. It comes with Node.js: sudo apt-get install -y nodejs npm']],
    cmd: 'npm', args: ['install', '-g', '--prefix', path.join(os.homedir(), '.local'), '@openai/codex', '--no-fund', '--no-audit', '--loglevel', 'http'],
    login: 'codex login',
  },
};

// Turns a failure into something a person can act on.
export function explain(log, code) {
  const t = log.join('\n');
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|Could not resolve host|Failed to connect|Connection timed out|Network is unreachable|curl: \(\d+\)/i.test(t)) return 'Could not reach the download server. Check that this computer is connected to the internet, then try again.';
  if (/EACCES|EPERM|Permission denied/i.test(t)) return 'Apiary was not allowed to write to your home folder (~/.local). Check the permissions of that folder, then try again.';
  if (/ENOSPC|No space left/i.test(t)) return 'The disk is full. Free some space, then try again.';
  if (/EEXIST/.test(t)) return 'A file from an earlier install is in the way. Remove ~/.local/bin/codex (or claude) and try again.';
  return `The installer stopped with an error (code ${code}). The last lines of the log above show why.`;
}

export class ToolInstaller {
  constructor({ recipes = RECIPES, onDone = () => {}, heartbeat = 8000 } = {}) {
    this.recipes = recipes; this.onDone = onDone; this.heartbeat = heartbeat;
    this.s = this._idle();
  }
  _idle() { return { state: 'idle', tools: [], steps: [], pct: 0, log: [], failed: null, startedAt: null, finishedAt: null }; }
  get status() { return { ...this.s, steps: this.s.steps.map((x) => ({ ...x })), log: this.s.log.slice(-300) }; }
  get running() { return this.s.state === 'running'; }
  _log(line) { const t = new Date().toLocaleTimeString([], { hour12: false }); for (const l of strip(line).split('\n')) { const x = l.trimEnd(); if (x) this.s.log.push(`${t}  ${x}`); } if (this.s.log.length > 600) this.s.log.splice(0, this.s.log.length - 600); }
  _pct() { const n = this.s.steps.length || 1; const done = this.s.steps.filter((x) => ['done', 'skip'].includes(x.state)).length; const cur = this.s.steps.find((x) => x.state === 'run'); return Math.min(99, Math.round(((done + (cur ? cur.frac || 0 : 0)) / n) * 100)); }

  installed() { return Object.fromEntries(Object.keys(this.recipes).map((id) => [id, !!which(id)])); }

  start(tools) {
    if (this.running) { const e = new Error('An install is already running.'); e.status = 409; throw e; }
    const ids = [...new Set(tools)].filter((t) => this.recipes[t]);
    if (!ids.length) { const e = new Error('Choose Claude Code, Codex or both.'); e.status = 400; throw e; }
    const steps = [];
    for (const id of ids) steps.push({ id: `${id}:check`, label: `Check this computer for ${this.recipes[id].label}`, state: 'wait' }, { id: `${id}:install`, label: `Download and install ${this.recipes[id].label}`, state: 'wait' }, { id: `${id}:verify`, label: `Check that ${this.recipes[id].label} works`, state: 'wait' });
    this.s = { state: 'running', tools: ids, steps, pct: 0, log: [], failed: null, startedAt: Date.now(), finishedAt: null };
    this._run(ids).catch((e) => { this.s.failed = { message: e.message || String(e) }; }).finally(() => { this.s.state = this.s.failed ? 'failed' : 'done'; this.s.finishedAt = Date.now(); if (!this.s.failed) this.s.pct = 100; this._log(this.s.failed ? `✖ ${this.s.failed.message}` : '✔ All done.'); try { this.onDone(this.status); } catch { /* ignore */ } });
    return this.status;
  }
  _step(id, state, frac) { const x = this.s.steps.find((y) => y.id === id); if (x) { x.state = state; x.frac = frac || 0; } this.s.pct = this._pct(); }

  async _run(ids) {
    for (const id of ids) {
      const r = this.recipes[id];
      this._step(`${id}:check`, 'run'); this._log(`Checking this computer for ${r.label}…`);
      const have = which(id);
      for (const [bin, hint] of r.needs || []) if (!have && !which(bin)) { this._step(`${id}:check`, 'fail'); throw Object.assign(new Error(`${hint}`), { step: `${id}:check` }); }
      if (have) {
        this._log(`${r.label} is already installed (${have}).`);
        this._step(`${id}:check`, 'done'); this._step(`${id}:install`, 'skip'); this._step(`${id}:verify`, 'run');
      } else {
        this._log('Nothing found, installing now.'); this._step(`${id}:check`, 'done');
        this._step(`${id}:install`, 'run'); this._log(`$ ${[r.cmd, ...r.args].join(' ')}`);
        const t0 = Date.now(), tick = setInterval(() => { const s = Math.round((Date.now() - t0) / 1000); const x = this.s.steps.find((y) => y.id === `${id}:install`); x.frac = 0.9 * (1 - Math.exp(-s / 45)); this.s.pct = this._pct(); this._log(`Still working… ${s} s. This can take a minute or two.`); }, this.heartbeat);
        let code;
        try { code = await this._exec(r); } finally { clearInterval(tick); }
        if (code !== 0) { this._step(`${id}:install`, 'fail'); const e = new Error(explain(this.s.log, code)); e.step = `${id}:install`; throw e; }
        this._step(`${id}:install`, 'done'); this._step(`${id}:verify`, 'run');
      }
      this._log(`Checking that ${r.label} starts…`);
      const ver = await this._version(id);
      if (!ver) { this._step(`${id}:verify`, 'fail'); throw Object.assign(new Error(`${r.label} was installed but does not start. Open a new terminal and run "${id} --version" to see why.`), { step: `${id}:verify` }); }
      this._log(`✔ ${r.label} is ready (${ver})`); this._step(`${id}:verify`, 'done');
    }
  }
  _env() { const parts = (process.env.PATH || '').split(path.delimiter); if (!parts.includes(HOME_BIN)) parts.unshift(HOME_BIN); return { ...process.env, PATH: parts.join(path.delimiter), npm_config_update_notifier: 'false', CI: '1' }; }
  _exec(r) {
    return new Promise((resolve) => {
      let child;
      try { child = spawn(r.cmd, r.args, { env: this._env(), stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { this._log(`Could not start: ${e.message}`); return resolve(127); }
      const kill = setTimeout(() => { this._log('Stopped: this took more than 10 minutes.'); child.kill('SIGTERM'); }, 600000);
      child.stdout.on('data', (d) => this._log(d)); child.stderr.on('data', (d) => this._log(d));
      child.on('error', (e) => { this._log(`Could not run ${r.cmd}: ${e.message}`); clearTimeout(kill); resolve(127); });
      child.on('close', (c) => { clearTimeout(kill); resolve(c ?? 1); });
    });
  }
  _version(id) {
    return new Promise((resolve) => {
      const bin = which(id) || path.join(HOME_BIN, id);
      let out = ''; let child; try { child = spawn(bin, ['--version'], { env: this._env(), stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return resolve(null); }
      const t = setTimeout(() => { child.kill('SIGTERM'); resolve(null); }, 20000);
      child.stdout.on('data', (d) => (out += d)); child.on('error', () => { clearTimeout(t); resolve(null); });
      child.on('close', (c) => { clearTimeout(t); resolve(c === 0 ? out.trim().split('\n')[0].slice(0, 80) || 'installed' : null); });
    });
  }
}
