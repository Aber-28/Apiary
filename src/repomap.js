// The repository map: where a repository is, which branch you are on, who is working on which branch.
// Read-only: it only runs git commands that look, and never changes anything.
import { existsSync } from 'node:fs';
import { run } from './exec.js';

const US = '\x1f';
const G = (dir, args) => run('git', args, { cwd: dir, env: { GIT_TERMINAL_PROMPT: '0' }, timeout: 20000 });
const lines = (s) => String(s || '').split('\n').filter(Boolean);
const clean = (url) => String(url || '').trim().replace(/\/\/[^/@\s]+@/, '//');   // never show a login embedded in a web address

// Every repository Apiary knows on this computer: those read by agents, and those that projects work in.
export function localRepos(engine) {
  const out = new Map();
  const add = (p, name, source, extra = {}) => {
    if (!p || !existsSync(p)) return;
    const e = out.get(p) || { id: '', path: p, name, uses: [], projects: [] };
    if (source === 'knowledge') e.uses.push('Read by agents'); else e.projects.push(extra.project);
    if (name && (source === 'knowledge' || !e.name)) e.name = name;
    out.set(p, e);
  };
  for (const r of engine.repos.list) add(r.path, r.name, 'knowledge');
  for (const a of Object.values(engine.agents)) if (!a.parentId && a.git?.repo) add(a.git.repo, a.git.repo.split('/').pop(), 'project', { project: a.name });
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name)).map((e, i) => ({ ...e, id: `l${i}`, projects: [...new Set(e.projects)], uses: [...new Set(e.uses)] }));
}

export async function inspect(engine, dir) {
  if (!existsSync(dir)) return { error: 'This folder is no longer on this computer.' };
  const inside = await G(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0) return { error: 'This folder is not a git repository.' };
  const [head, st, remote, defRef, refs, wt, log] = await Promise.all([
    G(dir, ['log', '-1', `--format=%h${US}%s${US}%an${US}%cI`]),
    G(dir, ['status', '--porcelain=v1', '-b']),
    G(dir, ['remote', 'get-url', 'origin']),
    G(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
    G(dir, ['for-each-ref', `--format=%(refname)${US}%(objectname:short)${US}%(committerdate:iso-strict)${US}%(subject)${US}%(authorname)`, 'refs/heads', 'refs/remotes/origin']),
    G(dir, ['worktree', 'list', '--porcelain']),
    G(dir, ['log', '--all', '--topo-order', '--max-count=60', `--format=%h${US}%s${US}%an${US}%cI${US}%D${US}%p`]),
  ]);
  const st0 = lines(st.stdout), first = st0[0] || '';
  const body = first.replace(/^## /, '').replace(/^(No commits yet on|Initial commit on) /, '');
  const trk = /^(.*?) \[(.*)\]$/.exec(body), pair = (trk ? trk[1] : body).split('...');
  const bm = [null, pair[0], pair[1], trk ? trk[2] : ''];
  const ahead = +(/ahead (\d+)/.exec(bm[3] || '') || [])[1] || 0, behind = +(/behind (\d+)/.exec(bm[3] || '') || [])[1] || 0;
  const changes = st0.slice(1).length;
  const [hash, subject, author, when] = head.stdout.trim().split(US);
  const current = bm[1] || '';
  let defaultBranch = defRef.code === 0 ? defRef.stdout.trim().replace(/^origin\//, '') : '';
  const map = new Map();
  for (const l of lines(refs.stdout)) {
    const [ref, sha, date, subj, who] = l.split(US);
    const remoteSide = ref.startsWith('refs/remotes/origin/'), name = ref.replace(/^refs\/(heads|remotes\/origin)\//, '');
    if (name === 'HEAD') continue;
    const b = map.get(name) || { name, local: false, remote: false, sha, date, subject: subj, author: who };
    if (remoteSide) b.remote = true; else { b.local = true; b.sha = sha; b.date = date; b.subject = subj; b.author = who; }
    map.set(name, b);
  }
  if (!defaultBranch) defaultBranch = ['main', 'master'].find((n) => map.has(n)) || current;
  const projectOf = (name) => {
    const m = /^apiary\/.*-([a-z0-9]{8})\/.+$/.exec(name); if (!m) return null;
    const a = engine.agents[m[1]]; return a ? a.name : 'an Apiary project';
  };
  const base = map.has(defaultBranch) ? (map.get(defaultBranch).local ? defaultBranch : `origin/${defaultBranch}`) : null;
  const branches = [...map.values()].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 60);
  await Promise.all(branches.map(async (b) => {
    b.current = b.name === current; b.isDefault = b.name === defaultBranch; b.agentProject = projectOf(b.name);
    if (base && !b.isDefault) {
      const ref = b.local ? b.name : `origin/${b.name}`;
      const r = await G(dir, ['rev-list', '--left-right', '--count', `${base}...${ref}`]);
      if (r.code === 0) { const [behindDef, aheadDef] = r.stdout.trim().split(/\s+/).map(Number); b.behindDefault = behindDef; b.aheadDefault = aheadDef; }
    }
  }));
  const worktrees = []; let cur = null;
  for (const l of lines(wt.stdout)) {
    if (l.startsWith('worktree ')) { cur = { path: l.slice(9), branch: '' }; worktrees.push(cur); }
    else if (l.startsWith('branch ') && cur) cur.branch = l.slice(7).replace(/^refs\/heads\//, '');
    else if (l === 'detached' && cur) cur.branch = '(detached)';
  }
  for (const w of worktrees) w.agentProject = projectOf(w.branch);
  const commits = lines(log.stdout).map((l) => { const [h, s, a, d, refsText, par] = l.split(US); return { hash: h, subject: s, author: a, date: d, parents: String(par || '').split(' ').filter(Boolean), refs: String(refsText || '').split(',').map((x) => x.trim().replace(/^HEAD -> /, '')).filter((x) => x && x !== 'HEAD' && !x.startsWith('origin/HEAD')) }; });
  const graph = layoutGraph(commits);
  const picture = await buildMap(dir, { base, defaultBranch, current, branches, projectOf });
  return {
    path: dir, remote: clean(remote.stdout), defaultBranch, current, detached: current === 'HEAD',
    head: { hash, subject, author, date: when }, ahead, behind, changes, clean: changes === 0, hasUpstream: !!bm[2],
    branches, worktrees, commits: commits.slice(0, 20), graph, map: picture,
  };
}

// Puts commits into lanes (columns) so a drawing can show branches splitting off and merging back.
// Each row says which lane its commit sits in, and which commit each lane is waiting for before and after it.
export function layoutGraph(commits) {
  const rows = []; let active = [], maxLane = 0;
  for (const c of commits) {
    const before = active.slice();
    let lane = before.indexOf(c.hash);
    if (lane < 0) { lane = before.indexOf(null); if (lane < 0) lane = before.length; }
    const next = before.slice(); while (next.length <= lane) next.push(null);
    for (let j = 0; j < next.length; j++) if (next[j] === c.hash) next[j] = null;   // lanes that ended here merge into this commit
    const targets = [];
    c.parents.forEach((p, i) => {
      let k = next.indexOf(p);
      if (k < 0) { k = i === 0 && next[lane] === null ? lane : next.indexOf(null); if (k < 0) k = next.length; next[k] = p; }
      targets.push(k);
    });
    while (next.length && next[next.length - 1] === null) next.pop();
    maxLane = Math.max(maxLane, lane, ...targets, next.length - 1);
    while (before.length && before[before.length - 1] === null) before.pop();
    rows.push({ hash: c.hash, subject: c.subject, author: c.author, date: c.date, refs: c.refs, lane, before, after: next, to: targets, merge: c.parents.length > 1, root: c.parents.length === 0 });
    active = next;
  }
  return { rows, lanes: Math.min(maxLane + 1, 10) };
}

// The simple picture: the main branch as a row of recent saves, "you are here", and the other branches hanging off it.
async function buildMap(dir, { base, defaultBranch, current, branches, projectOf }) {
  if (!base) return null;
  const log = await G(dir, ['log', '--first-parent', '--max-count=8', `--format=%H${US}%h${US}%s${US}%D${US}%cI`, base]);
  const line = lines(log.stdout).map((l) => { const [full, hash, subject, refsText, date] = l.split(US); const tag = (String(refsText || '').split(',').map((x) => x.trim()).find((x) => x.startsWith('tag: ')) || '').slice(5); return { full, hash, subject, tag, date }; }).reverse();
  if (!line.length) return null;
  const find = async (ref) => {
    const mb = await G(dir, ['merge-base', base, ref]);
    const full = mb.stdout.trim(); const i = line.findIndex((c) => c.full === full);
    return { index: i >= 0 ? i : 0, earlier: i < 0 && mb.code === 0 };
  };
  const out = [], mergedNames = [];
  const others = branches.filter((b) => !b.isDefault).slice(0, 30);
  await Promise.all(others.map(async (b) => {
    const ref = b.local ? b.name : `origin/${b.name}`;
    const merged = (await G(dir, ['merge-base', '--is-ancestor', ref, base])).code === 0;
    if (merged) { mergedNames.push(b.name); return; }
    const at = await find(ref);
    out.push({ name: b.name, subject: b.subject, date: b.date, ahead: b.aheadDefault || 0, behind: b.behindDefault || 0, local: b.local, remote: b.remote, current: b.current, agentProject: b.agentProject || null, ...at });
  }));
  out.sort((a, b) => (b.current - a.current) || String(b.date).localeCompare(String(a.date)));
  const onMain = current === defaultBranch;
  const here = onMain ? { onMain: true, index: line.length - 1 } : { onMain: false, branch: current, ...(await find('HEAD')) };
  return { base: defaultBranch, line, here, branches: out.slice(0, 8), hiddenBranches: Math.max(0, out.length - 8), merged: mergedNames.slice(0, 12), mergedCount: mergedNames.length };
}
