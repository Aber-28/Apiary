// Git helpers. Every agent in a git project works in its own worktree on its own branch.
import { run } from './exec.js';

const G = (cwd, args, o = {}) => run('git', args, { cwd, env: { GIT_TERMINAL_PROMPT: '0', ...(o.env || {}) }, timeout: o.timeout ?? 120000 });
async function ok(cwd, args, o) {
  const r = await G(cwd, args, o);
  if (r.code !== 0) throw new Error(`git ${args.find((a) => !a.startsWith('-')) || args[0]} failed: ${(r.stderr || r.stdout).trim().slice(-600)}`);
  return r.stdout.trim();
}
// Use the user's own git identity when they have one; otherwise a neutral fallback so commits never fail.
async function identity(dir) {
  const r = await G(dir, ['config', 'user.email']);
  return r.code === 0 && r.stdout.trim() ? [] : ['-c', 'user.name=Apiary agent', '-c', 'user.email=apiary@localhost'];
}

export const git = {
  async isRepo(dir) { const r = await G(dir, ['rev-parse', '--is-inside-work-tree']); return r.code === 0 && r.stdout.trim() === 'true'; },
  toplevel: (dir) => ok(dir, ['rev-parse', '--show-toplevel']),
  currentBranch: (dir) => ok(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
  async refExists(dir, ref) { return (await G(dir, ['rev-parse', '--verify', '--quiet', ref])).code === 0; },
  async branches(dir) {
    const out = await ok(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin']);
    const names = out.split('\n').map((s) => s.trim().replace(/^origin\//, '')).filter((s) => s && s !== 'HEAD' && s !== 'origin' && !s.startsWith('apiary/'));
    return [...new Set(names)];
  },
  // Branch to start from: the local branch if it exists, else the remote one.
  async startRef(dir, base) {
    return (await git.refExists(dir, `refs/heads/${base}`)) ? base : `origin/${base}`;
  },
  async worktreeAdd(mainDir, wtDir, branch, start) { await ok(mainDir, ['worktree', 'add', '-b', branch, wtDir, start]); },
  async worktreeRemove(mainDir, wtDir) { await G(mainDir, ['worktree', 'remove', '--force', wtDir]); },
  async commitAll(dir, message) {
    await ok(dir, ['add', '-A']);
    if (!(await ok(dir, ['status', '--porcelain']))) return false;
    await ok(dir, [...(await identity(dir)), 'commit', '-m', message]);
    return true;
  },
  async merge(dir, branch) {
    const r = await G(dir, [...(await identity(dir)), 'merge', '--no-edit', branch]);
    if (r.code === 0) return { ok: true };
    const conflicts = (await G(dir, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
    await G(dir, ['merge', '--abort']);
    return { ok: false, conflicts, message: (r.stderr || r.stdout).trim().slice(-300) };
  },
  // What `to` adds on top of `from` (three-dot), for review screens. Output is capped.
  async diff(dir, from, to, cap = 60000) {
    const stat = await ok(dir, ['diff', '--no-color', '--stat', `${from}...${to}`]);
    const patch = await ok(dir, ['diff', '--no-color', `${from}...${to}`], { timeout: 60000 });
    return { stat, patch: patch.slice(0, cap), truncated: patch.length > cap };
  },
  async clone(url, dest, extra = []) {
    const r = await G(process.cwd(), [...extra, 'clone', '--', url, dest], { timeout: 600000 });
    if (r.code !== 0) throw new Error(`Could not clone: ${(r.stderr || r.stdout).trim().slice(-500)}`);
  },
  async push(dir, branch, extra = []) { await ok(dir, [...extra, 'push', '-u', 'origin', branch], { timeout: 300000 }); },
  remoteUrl: (dir) => ok(dir, ['remote', 'get-url', 'origin']),
};
