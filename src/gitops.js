// Git actions for the repository map. A fixed list of safe actions, run one at a time on a repository Apiary
// already knows, with every line of output sent live. No force-push, hard reset, rebase or remote deletes.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { run } from './exec.js';

const NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/-]{1,100}$/;
export const RISKY = new Set(['push', 'merge', 'deletebranch', 'commit', 'stashpop']);
export const ACTION_IDS = ['status', 'fetch', 'pull', 'push', 'commit', 'switch', 'newbranch', 'merge', 'deletebranch', 'stash', 'stashpop', 'tag'];
const scrub = (s) => String(s).replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1…').replace(/\/\/[^/@\s]+@/g, '//');
const G = (dir, args) => run('git', args, { cwd: dir, env: { GIT_TERMINAL_PROMPT: '0' }, timeout: 20000 });
const busy = new Set();

const need = (v, what) => { if (typeof v !== 'string' || !NAME.test(v)) throw Object.assign(new Error(`${what} must be letters, numbers, dots, dashes or slashes`), { status: 400 }); return v; };

// Turn an action into the git steps to run. Throws a 400 for anything not allowed.
export async function plan(dir, action, a = {}) {
  const cur = (await G(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  switch (action) {
    case 'status': return { title: 'Check status', steps: [['status', '-sb'], ['log', '--oneline', '-n', '5']] };
    case 'fetch': return { title: 'Fetch from GitHub', steps: [['fetch', '--all', '--prune']] };
    case 'pull': return { title: `Pull into ${cur}`, steps: [['pull', '--ff-only']], hint: 'The branches have drifted apart, so Apiary did not change anything. Merge on the map instead, or ask an agent.' };
    case 'push': {
      const up = (await G(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).code === 0;
      if (cur === 'HEAD') throw Object.assign(new Error('You are not on a branch, so there is nothing to push'), { status: 400 });
      return { title: `Push ${cur} to GitHub`, steps: [up ? ['push'] : ['push', '-u', 'origin', cur]] };
    }
    case 'commit': {
      const m = String(a.message || '').trim().slice(0, 200);
      if (!m) throw Object.assign(new Error('Write a short message that says what changed'), { status: 400 });
      return { title: 'Save all changes', steps: [['add', '-A'], ['commit', '-m', m]], identity: true };
    }
    case 'switch': return { title: `Go to ${need(a.branch, 'The branch name')}`, steps: [['switch', a.branch]] };
    case 'newbranch': {
      const n = need(a.name, 'The new branch name'), from = a.from ? need(a.from, 'The starting branch') : '';
      return { title: `New branch ${n}`, steps: [['switch', '-c', n, ...(from ? [from] : [])]] };
    }
    case 'merge': {
      const b = need(a.branch, 'The branch name');
      if (b === cur) throw Object.assign(new Error('A branch cannot be merged into itself'), { status: 400 });
      return { title: `Merge ${b} into ${cur}`, steps: [['merge', '--no-edit', b]], identity: true, abortOnFail: 'merge', hint: 'The two branches changed the same lines, so Apiary stopped and undid the merge. Nothing was changed.' };
    }
    case 'deletebranch': {
      const b = need(a.branch, 'The branch name');
      if (b === cur) throw Object.assign(new Error('You are on that branch. Go to another one first'), { status: 400 });
      return { title: `Delete merged branch ${b}`, steps: [['branch', '-d', b]], hint: 'Git only deletes a branch that is already merged, so unmerged work is never lost.' };
    }
    case 'stash': return { title: 'Set unsaved changes aside', steps: [['stash', 'push', '-u']], identity: true };
    case 'stashpop': return { title: 'Bring set-aside changes back', steps: [['stash', 'pop']], identity: true };
    case 'tag': return { title: `Tag ${need(a.name, 'The tag name')}`, steps: [['tag', a.name]] };
    default: throw Object.assign(new Error('That Git action is not available'), { status: 400 });
  }
}

function stream(dir, args, onLine) {
  return new Promise((resolve) => {
    let done = false, buf = '';
    const fin = (code) => { if (done) return; done = true; clearTimeout(t); if (buf) onLine(buf); resolve(code); };
    let child;
    try { child = spawn('git', args, { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { onLine(e.message); return resolve(-1); }
    const t = setTimeout(() => { child.kill('SIGKILL'); onLine('[timed out after 5 minutes]'); fin(-2); }, 300000);
    const feed = (d) => { buf += d; const parts = buf.split(/\r|\n/); buf = parts.pop(); for (const p of parts) if (p.trim()) onLine(p); };
    child.stdout.on('data', feed); child.stderr.on('data', feed);
    child.on('error', (e) => { onLine(e.message); fin(-1); });
    child.on('close', fin);
  });
}

// Run one action, emitting {type:'gitop'} events as it goes. Resolves with the result; never throws for a git failure.
export async function perform({ dir, repoId, opId, action, args = {}, confirmed, authArgs = [], emit }) {
  if (!existsSync(dir)) throw Object.assign(new Error('This folder is no longer on this computer'), { status: 404 });
  if (!ACTION_IDS.includes(action)) throw Object.assign(new Error('That Git action is not available'), { status: 400 });
  if (RISKY.has(action) && confirmed !== true) throw Object.assign(new Error('This action needs your confirmation'), { status: 400 });
  if (busy.has(dir)) throw Object.assign(new Error('Another Git action is still running on this repository'), { status: 409 });
  const p = await plan(dir, action, args);
  busy.add(dir);
  const send = (o) => emit({ type: 'gitop', opId, repoId, ...o });
  send({ start: true, title: p.title });
  let ok = true, last = '';
  try {
    const id = p.identity && (await G(dir, ['config', 'user.email'])).stdout.trim() === '' ? ['-c', 'user.name=Apiary', '-c', 'user.email=apiary@localhost'] : [];
    for (const step of p.steps) {
      const net = ['fetch', 'pull', 'push'].includes(step[0]);
      send({ line: `$ git ${step.map((s) => (/\s/.test(s) ? JSON.stringify(s) : s)).join(' ')}`, cmd: true });
      const code = await stream(dir, [...(net ? authArgs : []), ...id, ...step], (l) => { last = scrub(l); send({ line: last }); });
      if (code !== 0) {
        ok = false;
        if (p.abortOnFail) await G(dir, [p.abortOnFail, '--abort']);
        if (p.hint) send({ line: p.hint, note: true });
        break;
      }
    }
  } finally { busy.delete(dir); }
  const summary = ok ? `${p.title}: done` : `${p.title}: did not work${last ? ` (${last.slice(0, 120)})` : ''}`;
  send({ done: true, ok, summary });
  return { ok, title: p.title, summary };
}
