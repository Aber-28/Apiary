// Connection settings: how Apiary reaches each AI and GitHub (terminal/CLI or web/API key).
// Secrets live in the state file, which is written with owner-only permissions.
import { run } from './exec.js';
import { which } from './providers.js';
import { github } from './github.js';

const DEFAULTS = {
  claude: { method: 'cli', apiKey: '', model: 'claude-sonnet-5-5' },
  codex: { method: 'cli', apiKey: '', model: '' },
  github: { method: 'cli', token: '' },
};
export const CONNECTION_IDS = Object.keys(DEFAULTS);
const last4 = (s) => (s ? `••••${s.slice(-4)}` : '');

export class Connections {
  constructor(store) { this.store = store; this._cache = new Map(); }
  get all() { return (this.store.data.settings ||= {}).connections ||= {}; }
  get(id) { return { ...DEFAULTS[id], ...(this.all[id] || {}) }; }

  update(id, patch) {
    if (!DEFAULTS[id]) throw Object.assign(new Error('Unknown connection'), { status: 404 });
    const cur = this.get(id);
    if (patch.method !== undefined) {
      if (!['cli', 'api', 'token'].includes(patch.method) || (id === 'github' ? patch.method === 'api' : patch.method === 'token')) {
        throw Object.assign(new Error('Unknown method'), { status: 400 });
      }
      cur.method = patch.method;
    }
    if (id !== 'github') {
      if (patch.apiKey !== undefined) cur.apiKey = String(patch.apiKey || '').trim();
      if (patch.model !== undefined) cur.model = String(patch.model || '').trim().slice(0, 100);
    } else if (patch.token !== undefined) cur.token = String(patch.token || '').trim();
    this.all[id] = cur;
    this._cache.clear();
    this.store.save();
  }

  async _version(bin) {
    const r = await run(bin, ['--version'], { timeout: 5000 });
    return r.code === 0 ? r.stdout.trim().split('\n')[0].slice(0, 80) : null;
  }

  // What the UI shows. Never includes secrets.
  async view(id) {
    const hit = this._cache.get(id);
    if (hit && Date.now() - hit.at < 20000) return hit.v;
    const c = this.get(id);
    let v;
    if (id === 'github') {
      const bin = which('gh');
      v = {
        id, method: c.method,
        cli: { found: !!bin, path: bin, version: bin ? await this._version('gh') : null },
        token: { saved: !!c.token, hint: last4(c.token) },
        status: await github.status(c),
      };
    } else {
      const bin = which(id);
      v = {
        id, method: c.method,
        cli: { found: !!bin, path: bin, version: bin ? await this._version(id) : null },
        api: { saved: !!c.apiKey, hint: last4(c.apiKey), model: c.model },
      };
      v.ready = c.method === 'api' ? !!c.apiKey : !!bin;
    }
    this._cache.set(id, { at: Date.now(), v });
    return v;
  }

  // Explicit "Test connection": a tiny real request, so it also proves the login works.
  async test(id, providers) {
    const c = this.get(id);
    if (id === 'github') {
      const s = await github.status(c);
      return s.ok ? { ok: true, detail: s.account ? `Signed in as ${s.account}` : 'Signed in' } : { ok: false, error: s.reason };
    }
    try {
      const agent = { id: 'test', name: 'test', provider: id, method: c.method, cwd: process.cwd(), access: 'safe', model: '' };
      const text = await providers.quickCheck(agent, c);
      return { ok: true, detail: `Replied: ${text.slice(0, 60)}` };
    } catch (e) { return { ok: false, error: e.message }; }
  }
}
