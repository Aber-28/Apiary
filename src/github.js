// GitHub access, two ways, same results:
//   cli   -> the `gh` command (uses its existing `gh auth login`)
//   token -> a personal access token entered in the web UI (REST API + git over HTTPS)
import { existsSync } from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';
import { git } from './git.js';
import { which } from './providers.js';

const API = () => process.env.APIARY_GITHUB_API || 'https://api.github.com';
const SPEC_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class GitHubError extends Error { constructor(m, status = 400) { super(m); this.status = status; } }

async function rest(token, pathname, init = {}) {
  const res = await fetch(API() + pathname, {
    ...init,
    signal: AbortSignal.timeout(20000),
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'content-type': 'application/json', 'user-agent': 'apiary', ...(init.headers || {}) },
  });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 200) }; }
  if (!res.ok) throw new GitHubError(`GitHub said ${res.status}: ${body.message || 'request failed'}`, res.status === 401 ? 401 : 502);
  return body;
}
// git over HTTPS with a token, without writing the token into .git/config
const authArgs = (conn) => conn.method === 'token' && conn.token
  ? ['-c', `http.extraheader=Authorization: Basic ${Buffer.from(`x-access-token:${conn.token}`).toString('base64')}`] : [];
const ghEnv = (conn) => (conn.method === 'token' && conn.token ? { GH_TOKEN: conn.token } : {});

export function validateSource(spec) {
  if (typeof spec !== 'string' || !spec.trim()) throw new GitHubError('Choose a repository');
  spec = spec.trim();
  if (SPEC_REPO.test(spec)) return { kind: 'github', spec };
  if (/^https:\/\/[^\s]+$/.test(spec)) return { kind: 'url', spec };
  if (path.isAbsolute(spec) && existsSync(spec)) return { kind: 'path', spec };
  throw new GitHubError('Use owner/name, an https:// URL, or an existing absolute path');
}

export const github = {
  async status(conn) {
    if (conn.method === 'token') {
      if (!conn.token) return { ok: false, reason: 'No token saved' };
      try { const u = await rest(conn.token, '/user'); return { ok: true, account: u.login }; }
      catch (e) { return { ok: false, reason: e.message }; }
    }
    if (!which('gh')) return { ok: false, reason: 'The gh command was not found on this machine' };
    const r = await run('gh', ['auth', 'status'], { timeout: 15000 });
    if (r.code !== 0) return { ok: false, reason: 'Not signed in. Run: gh auth login' };
    const u = await run('gh', ['api', 'user', '--jq', '.login'], { timeout: 15000 });
    return { ok: true, account: u.code === 0 ? u.stdout.trim() : null };
  },

  async listRepos(conn, q = '') {
    let repos;
    if (conn.method === 'token') {
      if (!conn.token) throw new GitHubError('Add a GitHub token under Connections first', 409);
      const list = await rest(conn.token, '/user/repos?per_page=100&sort=pushed');
      repos = list.map((r) => ({ name: r.full_name, private: r.private, description: r.description || '', defaultBranch: r.default_branch }));
    } else {
      const r = await run('gh', ['repo', 'list', '--limit', '100', '--json', 'nameWithOwner,isPrivate,description,defaultBranchRef'], { timeout: 30000, env: ghEnv(conn) });
      if (r.code !== 0) throw new GitHubError(`Could not list repositories: ${(r.stderr || '').trim().slice(0, 200) || 'is gh signed in?'}`, 409);
      repos = JSON.parse(r.stdout || '[]').map((x) => ({ name: x.nameWithOwner, private: x.isPrivate, description: x.description || '', defaultBranch: x.defaultBranchRef?.name || 'main' }));
    }
    const needle = q.trim().toLowerCase();
    return needle ? repos.filter((r) => r.name.toLowerCase().includes(needle)) : repos;
  },

  async listBranches(conn, repo) {
    if (!SPEC_REPO.test(repo)) throw new GitHubError('Bad repository name');
    if (conn.method === 'token') {
      return (await rest(conn.token, `/repos/${repo}/branches?per_page=100`)).map((b) => b.name);
    }
    const r = await run('gh', ['api', `repos/${repo}/branches?per_page=100`, '--jq', '.[].name'], { timeout: 30000, env: ghEnv(conn) });
    if (r.code !== 0) throw new GitHubError('Could not list branches', 409);
    return r.stdout.split('\n').filter(Boolean);
  },

  async clone(conn, spec, dest) {
    const { kind, spec: s } = validateSource(spec);
    if (kind === 'github' && conn.method !== 'token') {
      const r = await run('gh', ['repo', 'clone', s, dest], { timeout: 600000, env: ghEnv(conn) });
      if (r.code !== 0) throw new GitHubError(`Could not clone ${s}: ${(r.stderr || '').trim().slice(-300)}`, 409);
      return;
    }
    const url = kind === 'github' ? `https://github.com/${s}.git` : s;
    await git.clone(url, dest, /github\.com/.test(url) ? authArgs(conn) : []);
  },

  async openPr(conn, { dir, branch, base, title, body }) {
    await git.push(dir, branch, authArgs(conn));
    if (conn.method === 'token') {
      const url = await git.remoteUrl(dir);
      const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(url);
      if (!m) throw new GitHubError('The origin remote is not a GitHub repository');
      const pr = await rest(conn.token, `/repos/${m[1]}/pulls`, { method: 'POST', body: JSON.stringify({ title, head: branch, base, body }) });
      return pr.html_url;
    }
    const r = await run('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body], { cwd: dir, timeout: 60000, env: ghEnv(conn) });
    if (r.code !== 0) throw new GitHubError(`Could not open the pull request: ${(r.stderr || r.stdout).trim().slice(-300)}`, 502);
    return r.stdout.trim().split('\n').pop();
  },
};
