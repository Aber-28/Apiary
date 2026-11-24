#!/usr/bin/env node
// The `apiary` command: start the app, check status, connect services, watch an agent.
const [cmd = 'start', ...args] = process.argv.slice(2);
const PORT = process.env.APIARY_PORT || 7777, HOST = process.env.APIARY_HOST || '127.0.0.1';
const BASE = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`;
const HELP = `Apiary — chat-first orchestrator for Claude Code and Codex agents

Usage:
  apiary [start]                     Start Apiary and open it at ${BASE}
  apiary status                      Show what is connected and which agents exist
  apiary connect <claude|codex|github> [--method cli|api|token] [--model NAME]
                                     Choose how a service is reached. For api/token, pipe the key in:
                                       echo "$ANTHROPIC_API_KEY" | apiary connect claude --method api
  apiary attach <agent-name>         Follow an agent's terminal log (read-only)
  apiary --version | --help

Environment: APIARY_PORT, APIARY_HOST, APIARY_TOKEN, APIARY_HOME (see the docs)`;

async function api(path, method = 'GET', body) {
  let r;
  try {
    r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(process.env.APIARY_TOKEN ? { 'x-apiary-token': process.env.APIARY_TOKEN } : {}) }, body: body && JSON.stringify(body) });
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
  else if (cmd === 'start') { const { main } = await import('../src/server.js'); main(); }
  else if (cmd === 'status') {
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
