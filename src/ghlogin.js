// Signs in to GitHub from inside Apiary, so nobody needs a terminal.
// It runs the GitHub CLI's own browser sign-in (`gh auth login --web`), reads the one-time code and the
// address to open from its output, and shows them in the page. The person types the code at github.com,
// the CLI stores the login, and Apiary reuses it. Apiary never sees a password or token.
import { spawn } from 'node:child_process';
import { which } from './providers.js';

const strip = (s) => String(s).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n');
export const CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const URL_RE = /(https:\/\/github\.com\/login\/device\S*)/;

// Turns the CLI's last lines into something a person can act on.
export function explainLogin(text) {
  const t = String(text);
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|no such host|dial tcp|i\/o timeout|network is unreachable/i.test(t)) return 'Could not reach github.com. Check the internet connection and try again.';
  if (/expired|timed out/i.test(t)) return 'The code expired before it was used. Press Sign in again to get a new one.';
  if (/access_denied|denied|cancel/i.test(t)) return 'The sign-in was cancelled on GitHub. Press Sign in to try again.';
  if (/GH_TOKEN|GITHUB_TOKEN/.test(t)) return 'A GH_TOKEN variable is set for Apiary, so the GitHub CLI will not save a login. Remove it or use a token instead.';
  return 'The sign-in did not finish. Try again, or use a personal access token instead.';
}

export class GhLogin {
  constructor({ onChange = () => {}, timeoutMs = 15 * 60 * 1000, bin = () => which('gh') } = {}) {
    this.onChange = onChange; this.timeoutMs = timeoutMs; this.bin = bin;
    this.s = { state: 'idle' }; this.child = null; this.timer = null;
  }
  get status() { const { state, code, url, message, startedAt } = this.s; return { state, code, url, message, startedAt }; }
  _set(patch) { this.s = { ...this.s, ...patch }; this.onChange(this.status); }
  start() {
    if (this.s.state === 'starting' || this.s.state === 'waiting') return this.status;
    const bin = this.bin();
    if (!bin) { const e = new Error('The GitHub tool is not installed yet. Press "Install GitHub tool for me" first.'); e.status = 400; throw e; }
    const env = { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', BROWSER: 'true' };
    delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
    this.s = { state: 'starting', startedAt: Date.now() }; this.log = '';
    let child;
    try { child = spawn(bin, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], { env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { this._set({ state: 'failed', message: e.message }); return this.status; }
    this.child = child;
    const feed = (d) => {
      this.log = (this.log + strip(d)).slice(-4000);
      if (this.s.state === 'starting') {
        const c = this.log.match(CODE_RE);
        if (c) this._set({ state: 'waiting', code: c[1], url: (this.log.match(URL_RE) || [])[1] || 'https://github.com/login/device' });
      }
    };
    child.stdout.on('data', feed); child.stderr.on('data', feed);
    child.on('error', (e) => { this._end(child, 'failed', e.message); });
    child.on('close', (c) => {
      if (this.child !== child) return;
      if (c === 0) this._end(child, 'done');
      else if (this.s.state !== 'cancelled') this._end(child, 'failed', explainLogin(this.log));
    });
    this.timer = setTimeout(() => { this.log += '\ntimed out'; try { child.kill('SIGTERM'); } catch { /* gone */ } }, this.timeoutMs);
    return this.status;
  }
  _end(child, state, message) { if (this.child !== child) return; clearTimeout(this.timer); this.child = null; this._set({ state, message, code: undefined }); }
  cancel() {
    if (this.child) { const c = this.child; this.s = { ...this.s, state: 'cancelled' }; try { c.kill('SIGTERM'); } catch { /* gone */ } this._end(c, 'cancelled'); }
    return this.status;
  }
}
