#!/usr/bin/env node
// The `apiary` command: start the app, check status, connect services, watch an agent.
const [cmd = 'start', ...args] = process.argv.slice(2);
const PORT = process.env.APIARY_PORT || 7777, HOST = process.env.APIARY_HOST || '127.0.0.1';
const BASE = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`;
const HELP = `Apiary — chat-first orchestrator for Claude Code and Codex agents

Usage:
  apiary [start] [--lan] [--port N]  Start Apiary (http://127.0.0.1:7777). --lan makes it reachable from
                                     other devices on your network, protected by an access token
  apiary service <install|uninstall|status> [--lan]
                                     Start Apiary automatically at login (systemd user service)
  apiary token                       Print the access link for --lan (and create the token if needed)
  apiary user [set <name>|remove]    Username and password for signing in from other laptops.
                                     Also the way back in if you forget the password
  apiary status                      Show what is connected and which agents exist
  apiary connect <claude|codex|github> [--method cli|api|token] [--model NAME]
                                     Choose how a service is reached. For api/token, pipe the key in:
                                       echo "$ANTHROPIC_API_KEY" | apiary connect claude --method api
  apiary attach <agent-name>         Follow an agent's terminal log (read-only)
  apiary --version | --help

Environment: APIARY_PORT, APIARY_HOST, APIARY_TOKEN, APIARY_HOME (see the docs)`;

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { networkInterfaces, homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

// Reads a line without showing it. Piped input (a script) is read as is.
async function hiddenLine(prompt) {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) { let d = ''; for await (const c of stdin) d += c; return d.replace(/\r?\n$/, ''); }
  stderr.write(prompt);
  return new Promise((resolve) => {
    let v = ''; stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const on = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', on); stderr.write('\n'); return resolve(v); }
        if (c === '\u0003') { stdin.setRawMode(false); stderr.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') v = v.slice(0, -1); else v += c;
      }
    };
    stdin.on('data', on);
  });
}
// One token, created on first use and kept (private file) so the link stays the same between restarts.
function lanToken() {
  const dir = process.env.APIARY_HOME || path.join(homedir(), '.apiary'), file = path.join(dir, 'token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const t = randomBytes(24).toString('hex');
  writeFileSync(file, t + '\n', { mode: 0o600 }); try { chmodSync(file, 0o600); } catch { /* best effort */ }
  return t;
}
function savedToken() { try { return process.env.APIARY_TOKEN || readFileSync(path.join(process.env.APIARY_HOME || path.join(homedir(), '.apiary'), 'token'), 'utf8').trim(); } catch { return ''; } }
function lanLinks(token = process.env.APIARY_TOKEN, force = false) {
  if (!token || (!force && (process.env.APIARY_HOST || '127.0.0.1') === '127.0.0.1')) return [];
  const ips = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  return ips.map((ip) => `http://${ip}:${process.env.APIARY_PORT || 7777}/?token=${token}`);
}

async function api(path, method = 'GET', body) {
  let r;
  try {
    r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(savedToken() ? { 'x-apiary-token': savedToken() } : {}) }, body: body && JSON.stringify(body) });
  } catch { throw new Error(`Apiary is not running at ${BASE}. Start it with: apiary`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const readStdin = async () => { if (process.stdin.isTTY) return ''; let s = ''; for await (const c of process.stdin) s += c; return s.trim(); };

try {
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') console.log(HELP);
  else if (cmd === '--version' || cmd === '-v') console.log(JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  else if (cmd === 'start' || cmd.startsWith('--')) {
    const a = cmd === 'start' ? args : [cmd, ...args];
    const f = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
    if (f('--port')) process.env.APIARY_PORT = f('--port');
    if (f('--host')) process.env.APIARY_HOST = f('--host');
    if (a.includes('--lan')) { process.env.APIARY_HOST ||= '0.0.0.0'; process.env.APIARY_TOKEN ||= lanToken(); }
    const { main } = await import('../src/server.js'); main(lanLinks());
  } else if (cmd === 'service') {
    const svc = await import('../src/service.js');
    const sub = args[0];
    if (sub === 'install') { const s = await svc.install({ lan: args.includes('--lan') }); console.log(`✔ Installed. Apiary will start automatically at login${s.active ? ' (running now)' : ''}.\n  Start it now: systemctl --user start apiary`); }
    else if (sub === 'uninstall') { await svc.uninstall(); console.log('✔ Removed. Apiary will no longer start automatically.'); }
    else if (sub === 'status') { const s = await svc.status(); console.log(s.supported ? `installed: ${s.installed}  enabled: ${s.enabled}  running: ${s.active}` : s.reason); }
    else throw new Error('Usage: apiary service <install|uninstall|status> [--lan]');
  } else if (cmd === 'user') {
    const { Auth } = await import('../src/auth.js');
    const auth = new Auth(path.join(process.env.APIARY_HOME || path.join(homedir(), '.apiary'), 'auth.json'));
    const sub = args[0];
    if (!sub || sub === 'status') console.log(auth.exists ? `Sign-in is on. Username: ${auth.username}` : 'Sign-in is off. Turn it on with: apiary user set <name>');
    else if (sub === 'remove') { await auth.remove(); console.log('✔ Sign-in removed.'); }
    else if (sub === 'set') {
      const name = args[1] || auth.username;
      if (!name) throw new Error('Usage: apiary user set <name>');
      const first = await hiddenLine('Password: '), again = process.stdin.isTTY ? await hiddenLine('Type it again: ') : first;
      if (first !== again) throw new Error('The two passwords are not the same.');
      await auth.set(name, first);
      console.log(`✔ Sign-in is on for "${name}". Everyone signed in before is signed out.`);
    } else throw new Error('Usage: apiary user [set <name>|remove]');
  } else if (cmd === 'token') {
    const t = process.env.APIARY_TOKEN || lanToken();
    console.log(`Access token: ${t}`);
    for (const u of lanLinks(t, true)) console.log(u);
  } else if (cmd === 'status') {
    const [conns, st] = await Promise.all([api('/api/connections'), api('/api/state')]);
    for (const c of conns) {
      const ok = c.id === 'github' ? c.status?.ok : c.ready;
      console.log(`${ok ? '●' : '○'} ${c.id.padEnd(7)} ${ok ? 'connected' : 'not connected'}  via ${c.method === 'cli' ? 'terminal' : 'web'}${c.cli?.version ? '  · ' + c.cli.version : ''}`);
    }
    const leads = st.agents.filter((a) => !a.parentId);
    console.log(`\n${leads.length} project(s), ${st.agents.length} agent(s)`);
    for (const a of leads) console.log(`  ${a.name}  [${a.status}]${a.git ? '  ' + a.git.branch : ''}`);
  } else if (cmd === 'connect') {
    const id = args[0];
    if (!['claude', 'codex', 'github'].includes(id)) throw new Error('Usage: apiary connect <claude|codex|github> [--method cli|api|token]');
    const patch = {}; const m = flag('--method'); if (m) patch.method = m;
    const model = flag('--model'); if (model) patch.model = model;
    const secret = await readStdin();
    if (secret) patch[id === 'github' ? 'token' : 'apiKey'] = secret;
    if (!Object.keys(patch).length) throw new Error('Nothing to change. Use --method, --model, or pipe a key in.');
    await api('/api/connections/' + id, 'PUT', patch);
    const t = await api(`/api/connections/${id}/test`, 'POST', {});
    console.log(t.ok ? `✔ ${id}: ${t.detail}` : `✘ ${id}: ${t.error}`);
    process.exit(t.ok ? 0 : 1);
  } else if (cmd === 'attach') {
    const name = args.join(' ').toLowerCase();
    if (!name) throw new Error('Usage: apiary attach <agent-name>');
    const { agents } = await api('/api/state');
    const hits = agents.filter((a) => a.name.toLowerCase().includes(name) || a.id === name);
    if (!hits.length) throw new Error(`No agent matches "${name}". Try: apiary status`);
    if (hits.length > 1) throw new Error('Several agents match:\n' + hits.map((a) => `  ${a.name} (${a.id})`).join('\n') + '\nUse the id to pick one.');
    const a = hits[0]; let seen = 0;
    console.error(`Following ${a.name} (read-only). Ctrl-C to stop.`);
    for (;;) {
      const lines = await api(`/api/agents/${a.id}/logs`);
      if (lines.length < seen) seen = 0;
      for (const l of lines.slice(seen)) console.log(l);
      seen = lines.length;
      await new Promise((r) => setTimeout(r, 1000));
    }
  } else { console.error(HELP); process.exit(2); }
} catch (e) { console.error(e.message); process.exit(1); }
