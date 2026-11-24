// Repositories: code or documents the human points agents at, to read information from.
// Remote repositories are cloned into ~/.apiary/repos; local folders are used where they are.
// Agents are told the repository is read-only reference material: they copy what they need into their own work.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { run } from './exec.js';
import { git } from './git.js';
import { github, validateSource, authArgs } from './github.js';

const err = (status, message) => Object.assign(new Error(message), { status });
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'repo';

export class Repos {
  constructor(store, getConn, dir) { this.store = store; this.getConn = getConn; this.dir = dir; }
  get all() { return (this.store.data.repos ||= {}); }
  get list() { return Object.values(this.all).sort((a, b) => a.name.localeCompare(b.name)); }
  get(id) { const r = this.all[id]; if (!r) throw err(404, 'No such repository'); return r; }

  async add({ source, name = '', branch = '', notes = '' } = {}) {
    const v = validateSource(source);
    if (v.kind === 'url' && /^https:\/\/[^/]*@/.test(v.spec)) throw err(400, 'Do not put a password or token in the address. Connect GitHub under Connections instead.');
    const label = String(name).trim().slice(0, 60) || (v.kind === 'path' ? path.basename(v.spec) : v.spec.replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, ''));
    const id = randomUUID().slice(0, 8);
    let dest = v.spec;
    if (v.kind !== 'path') {
      mkdirSync(this.dir, { recursive: true });
      dest = path.join(this.dir, `${slugify(label)}-${id}`);
      try { await github.clone(this.getConn(), v.spec, dest); }
      catch (e) { rmSync(dest, { recursive: true, force: true }); throw err(e.status || 409, e.message); }
      if (branch) { const r = await run('git', ['checkout', branch], { cwd: dest, timeout: 60000 }); if (r.code !== 0) { rmSync(dest, { recursive: true, force: true }); throw err(400, `Branch "${branch}" was not found`); } }
    } else if (!statSync(dest).isDirectory()) throw err(400, 'That path is not a folder');
    const repo = { id, name: label, source: v.spec, kind: v.kind === 'path' ? 'local' : 'clone', path: dest, branch: String(branch || '').slice(0, 80), notes: String(notes).slice(0, 1000), agents: [], everyone: false, createdAt: Date.now(), syncedAt: Date.now() };
    repo.overview = await this._overview(repo);
    this.all[id] = repo; this.store.save();
    return repo;
  }

  async _overview(repo) {
    let s = '';
    try {
      const names = readdirSync(repo.path).filter((n) => n !== '.git').slice(0, 40);
      s += `Top level: ${names.join(', ')}\n`;
      const readme = names.find((n) => /^readme/i.test(n));
      if (readme) s += `README start:\n${readFileSync(path.join(repo.path, readme), 'utf8').slice(0, 700)}\n`;
    } catch { /* unreadable */ }
    try { if (await git.isRepo(repo.path)) { const r = await run('git', ['log', '-1', '--format=%h %s (%cr)'], { cwd: repo.path, timeout: 15000 }); if (r.code === 0) s += `Latest commit: ${r.stdout.trim()}\n`; } } catch { /* not git */ }
    return s.trim();
  }

  // Bring a cloned repository up to date. Local folders are always current.
  async sync(id) {
    const repo = this.get(id);
    if (repo.kind === 'clone') {
      const r = await run('git', [...authArgs(this.getConn()), 'pull', '--ff-only'], { cwd: repo.path, timeout: 180000, env: { GIT_TERMINAL_PROMPT: '0' } });
      if (r.code !== 0) throw err(409, `Could not update it: ${(r.stderr || r.stdout).trim().slice(-200)}`);
    }
    repo.syncedAt = Date.now(); repo.overview = await this._overview(repo); this.store.save();
    return repo;
  }

  update(id, { name, notes, branch, agents, everyone } = {}) {
    const r = this.get(id);
    if (name !== undefined) { const v = String(name).trim().slice(0, 60); if (!v) throw err(400, 'Give it a name'); r.name = v; }
    if (notes !== undefined) r.notes = String(notes).slice(0, 1000);
    if (agents !== undefined) r.agents = [...new Set((Array.isArray(agents) ? agents : []).map(String))];
    if (everyone !== undefined) r.everyone = !!everyone;
    this.store.save(); return r;
  }
  remove(id) {
    const r = this.get(id);
    if (r.kind === 'clone' && r.path.startsWith(this.dir + path.sep)) rmSync(r.path, { recursive: true, force: true });
    delete this.all[id]; this.store.save();
  }
  forAgent(agent) { return this.list.filter((r) => r.everyone || r.agents.includes(agent.id) || (agent.parentId == null ? false : r.agents.includes(agent.parentId))).filter((r) => existsSync(r.path)); }
  dirsFor(agent) { return this.forAgent(agent).map((r) => r.path); }
  contextFor(agent) {
    const rs = this.forAgent(agent);
    if (!rs.length) return '';
    return '\nREFERENCE REPOSITORIES (read-only; the human pointed you here for information. Read from them freely, never change them; copy what you need into your own work):\n' +
      rs.map((r) => `- ${r.name}: ${r.path}${r.branch ? ` (branch ${r.branch})` : ''}${r.notes ? `\n  Why: ${r.notes}` : ''}${r.overview ? `\n  ${r.overview.replace(/\n/g, '\n  ').slice(0, 900)}` : ''}`).join('\n') + '\n';
  }
}
