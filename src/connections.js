// Connection settings: how Apiary reaches each AI and GitHub (terminal/CLI or web/API key).
// Secrets live in the state file, which is written with owner-only permissions.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './exec.js';
import { which } from './providers.js';
import { github } from './github.js';

const DEFAULTS = {
  claude: { method: 'cli', apiKey: '', model: '' },
  codex: { method: 'cli', apiKey: '', model: '' },
  github: { method: 'cli', token: '' },
};
export const CONNECTION_IDS = Object.keys(DEFAULTS);
// Suggested choices when the provider can't be asked for its list (terminal logins have no list command).
const PRESETS = {
  claude: [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5: balanced' }, { id: 'claude-opus-5-5', label: 'Claude Opus 5.5: most capable' }, { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5: fastest' }],
  codex: [{ id: 'gpt-5.5', label: 'GPT-5.5: most capable' }, { id: 'gpt-5.4', label: 'GPT-5.4: balanced' }, { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini: fast and low cost' }],
};
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
      const agent = { id: 'test', name: 'test', provider: id, method: c.method, cwd: process.cwd(), access: 'safe', model: c.model || '' };
      const text = await providers.quickCheck(agent, c);
      return { ok: true, detail: `Replied: ${text.slice(0, 60)}` };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // Models Codex has told this computer about (its own cache and config), when it is installed and signed in.
  _codexLocal() {
    const out = [], dir = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    try {
      const j = JSON.parse(readFileSync(path.join(dir, 'models_cache.json'), 'utf8'));
      for (const m of j.models || []) if (m.slug && m.visibility !== 'hide') out.push({ id: m.slug, label: m.display_name || m.slug });
    } catch { /* no cache */ }
    try { const t = /^\s*model\s*=\s*"([^"]+)"/m.exec(readFileSync(path.join(dir, 'config.toml'), 'utf8')); if (t && !out.some((m) => m.id === t[1])) out.unshift({ id: t[1], label: `${t[1]} (set in your Codex settings)` }); } catch { /* no config */ }
    return out;
  }
  // Models known right now without asking anyone: the last list from the provider, else this computer's own list, else suggestions.
  known(id) {
    if (this._known?.[id]) return this._known[id];
    const local = id === 'codex' ? this._codexLocal() : [];
    return local.length ? local : PRESETS[id] || [];
  }

  // Models to offer as the default. Asks the provider when an API key is saved, else falls back to suggestions.
  async models(id) {
    if (!DEFAULTS[id] || id === 'github') throw Object.assign(new Error('Unknown connection'), { status: 404 });
    const c = this.get(id);
    if (c.apiKey) {
      try {
        const url = id === 'claude' ? `${process.env.APIARY_ANTHROPIC_URL || 'https://api.anthropic.com'}/v1/models?limit=100` : `${process.env.APIARY_OPENAI_URL || 'https://api.openai.com'}/v1/models`;
        const headers = id === 'claude' ? { 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${c.apiKey}` };
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const list = ((await res.json()).data || []).map((m) => ({ id: m.id, label: m.display_name ? `${m.display_name}` : m.id }))
            .filter((m) => id === 'claude' || !/embed|whisper|tts|dall-e|moderation|image|audio|realtime|transcribe/i.test(m.id))
            .sort((a, b) => a.id.localeCompare(b.id));
          if (list.length) { (this._known ||= {})[id] = list; return { source: 'provider', models: list }; }
        }
      } catch { /* fall through to suggestions */ }
    }
    const local = id === 'codex' ? this._codexLocal() : [];
    return local.length ? { source: 'this computer', models: local } : { source: 'suggestions', models: PRESETS[id] || [] };
  }
}
