// Signs in to Claude (and Codex) from inside Apiary, so a new person does not need a terminal.
// It runs the CLI's own sign-in, reads the address to open from its output, and passes on the code the person
// pastes back. The CLI stores the login; Apiary never sees a password. The code is not kept or logged.
import { spawn, spawnSync } from 'node:child_process';
import { which } from './providers.js';

const strip = (s) => String(s).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const URL_RE = /(https?:\/\/[^\s"'<>]+)/;
const CODE_RE = /\b([A-Z0-9]{4,6}-[A-Z0-9]{4,8})\b/;

// The sign-in command for each provider. Claude shows a code to paste back. Codex uses its device-code mode: it prints
// a page address and a short one-time code, the person types the code on that page, and the CLI finishes by itself.
const LOGIN = {
  claude: { bin: 'claude', args: ['auth', 'login', '--claudeai'], check: ['auth', 'status'], ok: (out) => /"loggedIn"\s*:\s*true/.test(out) },
  codex: { bin: 'codex', args: ['login', '--device-auth'], device: true, check: ['login', 'status'], ok: (out) => /logged in/i.test(out) && !/not logged in/i.test(out) },
};

export class AiLogin {
  constructor({ onChange = () => {}, timeoutMs = 10 * 60 * 1000, bin = (b) => which(b), spawnFn = spawn, checkFn = (b, a) => spawnSyncText(b, a) } = {}) {
    this.onChange = onChange; this.timeoutMs = timeoutMs; this.bin = bin; this.spawnFn = spawnFn; this.checkFn = checkFn;
    this.s = {}; this.child = {}; this.timer = {};
  }
  status(provider) { const s = this.s[provider] || { state: 'idle' }; return { provider, state: s.state, url: s.url, code: s.code, device: !!LOGIN[provider]?.device, message: s.message, startedAt: s.startedAt }; }
  _set(provider, patch) { this.s[provider] = { ...(this.s[provider] || {}), ...patch }; this.onChange(this.status(provider)); }
  _known(provider) { if (!LOGIN[provider]) { const e = new Error('Unknown service'); e.status = 404; throw e; } }

  start(provider) {
    this._known(provider);
    const cur = this.s[provider]?.state;
    if (cur === 'starting' || cur === 'waiting' || cur === 'checking') return this.status(provider);
    const cfg = LOGIN[provider];
    const bin = this.bin(cfg.bin);
    if (!bin) { const e = new Error(`${provider === 'claude' ? 'Claude Code' : 'Codex'} is not installed yet. Install it first.`); e.status = 400; throw e; }
    this._set(provider, { state: 'starting', startedAt: Date.now(), url: '', code: '', message: '' });
    const env = { ...process.env, NO_COLOR: '1', BROWSER: 'true', CI: '' };
    let child;
    try { child = this.spawnFn(bin, cfg.args, { env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { this._set(provider, { state: 'failed', message: e.message }); return this.status(provider); }
    this.child[provider] = child;
    let text = '';
    const feed = (d) => {
      text = (text + strip(d)).slice(-8000);
      const m = URL_RE.exec(text);
      if (!m || this.s[provider].state !== 'starting') return;
      const url = m[1].replace(/[.,;)]+$/, '');
      if (!cfg.device) { this._set(provider, { state: 'waiting', url }); return; }
      // Device mode: wait until the one-time code has been printed too (it comes after the address).
      const c = CODE_RE.exec(text.slice(m.index + m[0].length));
      if (c) this._set(provider, { state: 'waiting', url, code: c[1] });
    };
    child.stdout?.on('data', feed); child.stderr?.on('data', feed);
    child.on('error', (e) => this._set(provider, { state: 'failed', message: `Could not start the sign-in: ${e.message}` }));
    child.on('close', (code) => this._finished(provider, code));
    this.timer[provider] = setTimeout(() => this.cancel(provider, 'The sign-in timed out. Press Sign in to try again.'), this.timeoutMs);
    this.timer[provider].unref?.();
    return this.status(provider);
  }
  // The person pastes the code they were shown on the sign-in page. It goes straight to the CLI and is not kept.
  submit(provider, code) {
    this._known(provider);
    const c = String(code || '').trim();
    const child = this.child[provider];
    if (!c || c.length > 500) { const e = new Error('Paste the code shown after you approve the sign-in'); e.status = 400; throw e; }
    if (LOGIN[provider].device) { const e = new Error('This sign-in has no code to paste. Type the code shown on the page into the sign-in page instead.'); e.status = 400; throw e; }
    if (!child || this.s[provider]?.state !== 'waiting') { const e = new Error('There is no sign-in waiting for a code. Press Sign in first.'); e.status = 409; throw e; }
    // Set first: the CLI may answer before the write returns.
    this._set(provider, { state: 'checking', message: '' });
    child.stdin.write(c + '\n');
    return this.status(provider);
  }
  cancel(provider, message = '') {
    this._known(provider);
    clearTimeout(this.timer[provider]);
    const child = this.child[provider];
    if (child && !child.killed && child.exitCode === null) { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
    this.child[provider] = null;
    this._set(provider, { state: message ? 'failed' : 'idle', message, url: '', code: '' });
    return this.status(provider);
  }
  _finished(provider, code) {
    clearTimeout(this.timer[provider]); this.child[provider] = null;
    if (!['starting', 'waiting', 'checking'].includes(this.s[provider]?.state)) return;
    const cfg = LOGIN[provider];
    if (code !== 0) { this._set(provider, { state: 'failed', message: cfg.device ? 'The sign-in did not finish. Press Sign in to get a new code.' : 'The sign-in did not finish. Check the code and try again, or use the terminal.' }); return; }
    // Only report success once the CLI itself says the login works.
    if (!cfg.check) { this._set(provider, { state: 'done', message: '' }); return; }
    const bin = this.bin(cfg.bin);
    try {
      const out = this._runSync(bin, cfg.check);
      if (cfg.ok(out)) this._set(provider, { state: 'done', message: '' });
      else this._set(provider, { state: 'failed', message: 'The code was not accepted. Press Sign in to get a new one.' });
    } catch { this._set(provider, { state: 'failed', message: 'Could not confirm the sign-in. Try again.' }); }
  }
  _runSync(bin, args) { return this.checkFn(bin, args); }
}
function spawnSyncText(bin, args) { const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 20000, env: { ...process.env, NO_COLOR: '1' } }); return strip(`${r.stdout || ''}${r.stderr || ''}`); }
