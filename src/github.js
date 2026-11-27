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
// The header is scoped to github.com, so the token is never sent to any other server.
export const authArgs = (conn) => conn.method === 'token' && conn.token
  ? ['-c', `http.https://github.com/.extraheader=Authorization: Basic ${Buffer.from(`x-access-token:${conn.token}`).toString('base64')}`] : [];
export const isGithubUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && x.hostname === 'github.com'; } catch { return false; } };
const ghEnv = (conn) => (conn.method === 'token' && conn.token ? { GH_TOKEN: conn.token } : {});

export function validateSource(spec) {
  if (typeof spec !== 'string' || !spec.trim()) throw new GitHubError('Choose a repository');
  spec = spec.trim();
  if (SPEC_REPO.test(spec)) return { kind: 'github', spec };
  if (/^https:\/\/[^\s]+$/.test(spec)) return { kind: 'url', spec };
  if (path.isAbsolute(spec) && existsSync(spec)) return { kind: 'path', spec };
  throw new GitHubError('Use owner/name, an https:// URL, or an existing absolute path');
}

const NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\/$)[A-Za-z0-9._\/-]{1,100}$/, SHA = /^[0-9a-f]{40}$/;
const enc = (n) => n.split('/').map(encodeURIComponent).join('/');
export const githubActions = ['branch', 'tag', 'merge', 'deletebranch', 'pr'];

export const github = {
  // Changes made on GitHub itself (nothing on this computer). A short fixed list; merges and deletes need `confirmed`.
  async act(conn, repo, action, a = {}, confirmed = false) {
    if (!SPEC_REPO.test(String(repo || ''))) throw new GitHubError('Choose a repository');
    if (!githubActions.includes(action)) throw new GitHubError('That GitHub action is not available');
    if (['merge', 'deletebranch'].includes(action) && confirmed !== true) throw new GitHubError('This action needs your confirmation');
    const nm = (v, what) => { if (typeof v !== 'string' || !NAME.test(v)) throw new GitHubError(`${what} must be letters, numbers, dots, dashes or slashes`); return v; };
    const call = async (method, p, body) => {
      if (conn.method === 'token') { if (!conn.token) throw new GitHubError('Add a GitHub token under Connections first', 409); return rest(conn.token, p, { method, ...(body ? { body: JSON.stringify(body) } : {}) }); }
      const r = await run('gh', ['api', '-X', method, p.replace(/^\//, ''), ...(body ? ['--input', '-'] : [])], { timeout: 30000, env: ghEnv(conn), input: body ? JSON.stringify(body) : undefined });
      if (r.code !== 0) throw new GitHubError(`GitHub said no: ${(r.stderr || r.stdout || '').trim().slice(0, 200) || 'is gh signed in?'}`, 409);
      return r.stdout.trim() ? JSON.parse(r.stdout) : {};
    };
    const info = await call('GET', `/repos/${repo}`), def = info.default_branch;
    const shaOf = async (ref) => { if (SHA.test(ref)) return ref; const b = await call('GET', `/repos/${repo}/branches/${enc(nm(ref, 'The starting point'))}`); return b.commit?.sha; };
    try {
      if (action === 'branch') { const n = nm(a.name, 'The new branch name'), sha = await shaOf(String(a.from || def)); await call('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${n}`, sha }); return { ok: true, message: `Created branch ${n} on GitHub.` }; }
      if (action === 'tag') { const n = nm(a.name, 'The tag name'), sha = await shaOf(String(a.sha || def)); await call('POST', `/repos/${repo}/git/refs`, { ref: `refs/tags/${n}`, sha }); return { ok: true, message: `Tagged ${n} on GitHub.` }; }
      if (action === 'merge') {
        const head = nm(a.head, 'The branch'), base = nm(a.base || def, 'The target branch');
        if (head === base) throw new GitHubError('A branch cannot be merged into itself');
        const r = await call('POST', `/repos/${repo}/merges`, { base, head, commit_message: `Merge ${head} into ${base} (from Apiary)` });
        return { ok: true, message: r?.sha ? `Merged ${head} into ${base} on GitHub.` : `${base} already has everything from ${head}. Nothing to merge.` };
      }
      if (action === 'deletebranch') {
        const n = nm(a.name, 'The branch name'); if (n === def) throw new GitHubError('The main branch is never deleted');
        const cmp = await call('GET', `/repos/${repo}/compare/${enc(def)}...${enc(n)}`);
        if (cmp.ahead_by) throw new GitHubError(`${n} has ${cmp.ahead_by} save(s) that are not in ${def} yet, so it is not deleted`);
        await call('DELETE', `/repos/${repo}/git/refs/heads/${enc(n)}`); return { ok: true, message: `Deleted merged branch ${n} on GitHub.` };
      }
      if (action === 'pr') {
        const head = nm(a.head, 'The branch'), title = String(a.title || '').trim().slice(0, 200) || `Merge ${head}`;
        const r = await call('POST', `/repos/${repo}/pulls`, { title, head, base: def }); return { ok: true, message: `Opened pull request #${r.number} into ${def}.`, url: r.html_url };
      }
    } catch (e) {
      if (e instanceof GitHubError && e.status !== 502) throw e;
      const m = String(e.message || '');
      if (/409|conflict/i.test(m) && action === 'merge') throw new GitHubError('The two branches changed the same lines, so GitHub did not merge them. Nothing was changed. Open a pull request to resolve it.', 409);
      if (/422|already exists/i.test(m)) throw new GitHubError('GitHub says that name already exists or is not valid. Pick another name.', 409);
      throw e;
    }
  },

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

  // What GitHub shows about a repository: default branch, branches, open pull requests, latest commits.
  async overview(conn, repo) {
    if (!SPEC_REPO.test(repo)) throw new GitHubError('Bad repository name');
    const get = async (p) => {
      if (conn.method === 'token') { if (!conn.token) throw new GitHubError('Add a GitHub token under Connections first', 409); return rest(conn.token, p); }
      const r = await run('gh', ['api', p.replace(/^\//, '')], { timeout: 30000, env: ghEnv(conn) });
      if (r.code !== 0) throw new GitHubError(`GitHub could not answer: ${(r.stderr || '').trim().slice(0, 160) || 'is gh signed in?'}`, 409);
      return JSON.parse(r.stdout || 'null');
    };
    const [info, branches, pulls, commits30, tags] = await Promise.all([get(`/repos/${repo}`), get(`/repos/${repo}/branches?per_page=100`), get(`/repos/${repo}/pulls?state=open&per_page=30`), get(`/repos/${repo}/commits?per_page=30`), get(`/repos/${repo}/tags?per_page=50`).catch(() => [])]);
    const commits = (commits30 || []).slice(0, 15);
    // The simple map, built from GitHub's own answers: the main line (first parents only), and each unmerged branch with where it started.
    const byFull = new Map((commits30 || []).map((c) => [c.sha, c])); const line = []; let cur = commits30 && commits30[0];
    for (let i = 0; cur && i < 8; i++) { line.unshift(cur); cur = byFull.get(cur.parents?.[0]?.sha); }
    const tagBySha = new Map((tags || []).map((t) => [t.commit?.sha, t.name]));
    const mline = line.map((c) => ({ full: c.sha, hash: c.sha.slice(0, 7), subject: String(c.commit?.message || '').split('\n')[0], tag: tagBySha.get(c.sha) || '', date: c.commit?.author?.date }));
    const others = (branches || []).filter((b) => b.name !== info.default_branch).slice(0, 24), mbranches = [], merged = [];
    await Promise.all(others.map(async (b) => {
      let cmp; try { cmp = await get(`/repos/${repo}/compare/${encodeURIComponent(info.default_branch)}...${b.name.split('/').map(encodeURIComponent).join('/')}`); } catch { return; }
      if (!cmp.ahead_by) { merged.push(b.name); return; }
      const tip = (cmp.commits || [])[cmp.commits.length - 1], i = mline.findIndex((c) => c.full === cmp.merge_base_commit?.sha);
      mbranches.push({ name: b.name, subject: String(tip?.commit?.message || '').split('\n')[0], date: tip?.commit?.author?.date, ahead: cmp.ahead_by, behind: cmp.behind_by, local: false, remote: true, current: false, agentProject: /^apiary\//.test(b.name) ? 'an Apiary project' : null, index: i >= 0 ? i : 0, earlier: i < 0 });
    }));
    mbranches.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const map = mline.length ? { base: info.default_branch, line: mline, here: null, branches: mbranches.slice(0, 8), hiddenBranches: Math.max(0, mbranches.length - 8), merged: merged.slice(0, 12), mergedCount: merged.length } : null;
    return {
      map,
      name: info.full_name || repo, private: !!info.private, description: info.description || '', defaultBranch: info.default_branch, url: info.html_url, pushedAt: info.pushed_at,
      branches: (branches || []).map((b) => ({ name: b.name, sha: String(b.commit?.sha || '').slice(0, 7), protected: !!b.protected })),
      pulls: (pulls || []).map((x) => ({ number: x.number, title: x.title, from: x.head?.ref, into: x.base?.ref, author: x.user?.login, draft: !!x.draft, url: x.html_url, updatedAt: x.updated_at })),
      commits: (commits || []).map((c) => ({ hash: String(c.sha || '').slice(0, 7), subject: String(c.commit?.message || '').split('\n')[0], author: c.commit?.author?.name || '', date: c.commit?.author?.date })),
    };
  },

  async clone(conn, spec, dest) {
    const { kind, spec: s } = validateSource(spec);
    if (kind === 'github' && conn.method !== 'token') {
      const r = await run('gh', ['repo', 'clone', s, dest], { timeout: 600000, env: ghEnv(conn) });
      if (r.code !== 0) throw new GitHubError(`Could not clone ${s}: ${(r.stderr || '').trim().slice(-300)}`, 409);
      return;
    }
    const url = kind === 'github' ? `https://github.com/${s}.git` : s;
    await git.clone(url, dest, isGithubUrl(url) ? authArgs(conn) : []);
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
