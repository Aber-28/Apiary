// Small promise wrapper around child_process.spawn. Never throws for a failed command;
// callers look at `code`. Used for git, gh and CLI probes.
import { spawn } from 'node:child_process';

export function run(cmd, args = [], { cwd, env, input, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, timer = null, child;
    const finish = (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    };
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return resolve({ code: -1, stdout: '', stderr: e.message }); }
    if (timeout) timer = setTimeout(() => { child.kill('SIGKILL'); err += '\n[timed out]'; finish(-2); }, timeout);
    child.stdout.on('data', (d) => { out += d; if (out.length > 5e6) out = out.slice(-5e6); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 2e5) err = err.slice(-2e5); });
    child.on('error', (e) => { err += e.message; finish(-1); });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}
