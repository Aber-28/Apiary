// Providers turn "run this prompt for this agent" into either a CLI subprocess (terminal)
// or a direct API call (web). Each returns { text, sessionId } and streams through callbacks:
//   onText(chunk)      live reply text for the chat
//   onActivity(label)  short "what is it doing now" label
//   onLog(line)        a line for the Terminal view
import { spawn } from 'node:child_process';
import { accessSync, constants, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HELPERS = fileURLToPath(new URL('../bin', import.meta.url));

export function which(bin) {
  // ~/.local/bin is where the AI tools are installed for the current user; a service may not have it on its PATH
  for (const dir of [...(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin')]) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try { accessSync(p, constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return null;
}

const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

function lineLogger(onLog) {
  let buf = '';
  return {
    push(t) { buf += t; let i; while ((i = buf.indexOf('\n')) >= 0) { onLog(buf.slice(0, i)); buf = buf.slice(i + 1); } },
    flush() { if (buf) onLog(buf); buf = ''; },
  };
}
const clip = (s, n = 200) => (s.length > n ? s.slice(0, n) + '…' : s);
function logOutput(onLog, text) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  lines.slice(0, 8).forEach((l) => onLog('  ' + clip(l)));
  if (lines.length > 8) onLog(`  … ${lines.length - 8} more lines`);
}

// What an agent's process gets to see: our environment, without Apiary's own access token,
// plus only the secrets that were approved for this turn.
export function childEnv(extra = {}) {
  const env = { ...process.env }; delete env.APIARY_TOKEN;
  env.PATH = [HELPERS, env.PATH].filter(Boolean).join(path.delimiter);   // apiary-ssh and friends
  return { ...env, ...extra };
}
// Codex hides variables with KEY, SECRET or TOKEN in the name from its shell unless told not to,
// which would hide an approved secret from the agent. Only turned on when a secret was approved.
export const codexSecretFlags = (env = {}) => Object.keys(env).some((k) => k.startsWith('APIARY_SECRET_')) ? ['-c', 'shell_environment_policy.ignore_default_excludes=true'] : [];

function runProc(cmd, args, { cwd, input, signal, onLine, env }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortErr());
    const child = spawn(cmd, args, { cwd, env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '', buf = '';
    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e); });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (buf.trim()) onLine(buf.trim());
      if (signal?.aborted) return reject(abortErr());
      resolve({ code, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

// ---------- terminal (CLI) providers ----------
// Arguments for one headless Claude CLI turn. In safe mode a headless run cannot show a shell
// permission prompt, so each command that needs approval is sent to Apiary instead: `approval` names
// the bridge (src/approval-bridge.js), its URL and this run's token. Without `approval`, anything that
// would prompt is refused.
// The bridge's settings, including this run's token, go in a private file (readable by this user only) instead of the
// command line, where other users could read them in the process list. The caller removes the file when the run ends.
export function writeApprovalConfig(approval) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'apiary-'));
  const file = path.join(dir, 'mcp.json');
  const mcpServers = { apiary: { command: process.execPath, args: [approval.bridge], env: { APIARY_APPROVAL_URL: approval.url, APIARY_APPROVAL_TOKEN: approval.token } } };
  writeFileSync(file, JSON.stringify({ mcpServers }), { mode: 0o600 });
  return { configFile: file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function claudeCliArgs({ access, model, system, dirs = [], sessionId, approval }) {
  const full = access === 'full';
  const args = ['-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', full ? 'bypassPermissions' : 'acceptEdits'];
  if (!full && approval) {
    args.push('--mcp-config', approval.configFile, '--permission-prompt-tool', 'mcp__apiary__approve');
  }
  args.push('--append-system-prompt', system);
  if (model) args.push('--model', model);
  for (const d of dirs) args.push('--add-dir', d);
  if (sessionId) args.push('--resume', sessionId);
  return args;
}

const claudeCli = {
  async run({ agent, prompt, system, env, dirs = [], signal, approval, onText, onActivity, onLog }) {
    const cfg = approval && agent.access !== 'full' ? writeApprovalConfig(approval) : null;
    const args = claudeCliArgs({ access: agent.access, model: agent.model, system, dirs, sessionId: agent.sessionId, approval: cfg ? { configFile: cfg.configFile } : undefined });
    let sessionId = agent.sessionId, streamed = '', final = null, isError = false, usage = null;
    let runResult;
    try {
    runResult = await runProc('claude', args, {
      cwd: agent.cwd, input: prompt, signal, env,
      onLine: (line) => {
        let ev; try { ev = JSON.parse(line); } catch { return; }
        if (ev.session_id) sessionId = ev.session_id;
        if (ev.type === 'assistant') {
          for (const b of ev.message?.content || []) {
            if (b.type === 'text' && b.text) { streamed += b.text + '\n'; onText(b.text + '\n'); b.text.split('\n').forEach((l) => l && onLog(l)); }
            else if (b.type === 'tool_use') {
              onActivity(describeTool(b));
              onLog(b.name === 'Bash' && b.input?.command ? `$ ${clip(b.input.command, 300)}` : `> ${describeTool(b)}`);
            }
          }
        } else if (ev.type === 'user') {
          for (const b of ev.message?.content || []) {
            if (b.type === 'tool_result') {
              const t = typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text || '').join('\n');
              logOutput(onLog, t);
            }
          }
        } else if (ev.type === 'result') { final = ev.result; isError = !!ev.is_error; const u = ev.usage; if (u) usage = { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0 }; }
      },
    });
    } finally { cfg?.cleanup(); }
    const { code, stderr } = runResult;
    if (isError) throw new Error(final || 'Claude reported an error');
    if (final == null && code !== 0) throw new Error(stderr.trim() || `claude exited with code ${code}`);
    return { text: (final ?? streamed).trim(), sessionId, usage };
  },
};

function describeTool(b) {
  const i = b.input || {};
  const hint = i.command || i.file_path || i.pattern || i.url || i.description || '';
  return `${b.name}${hint ? ': ' + String(hint).slice(0, 80) : ''}`;
}

const codexCli = {
  async run({ agent, prompt, system, env, signal, onText, onActivity, onLog }) {
    const full = agent.access === 'full';
    // Codex has no system-prompt flag, so the instructions ride along on the first turn.
    const input = agent.sessionId ? prompt : `${system}\n\n---\n\n${prompt}`;
    const flags = ['--json', '--skip-git-repo-check', '--sandbox', full ? 'danger-full-access' : 'workspace-write'];
    if (agent.model) flags.push('-m', agent.model);
    const args = [...codexSecretFlags(env), ...(agent.sessionId ? ['exec', 'resume', agent.sessionId, ...flags, '-'] : ['exec', ...flags, '-'])];
    let sessionId = agent.sessionId, last = '', err = null, usage = null;
    const { code, stderr } = await runProc('codex', args, {
      cwd: agent.cwd, input, signal, env,
      onLine: (line) => {
        let ev; try { ev = JSON.parse(line); } catch { return; }
        if (ev.type === 'thread.started' && ev.thread_id) sessionId = ev.thread_id;
        const it = ev.item;
        if (ev.type === 'item.completed' && it?.type === 'agent_message' && it.text) {
          last = it.text; onText(it.text + '\n'); it.text.split('\n').forEach((l) => l && onLog(l));
        } else if (ev.type === 'item.started' && it?.type === 'command_execution') {
          onActivity(`Running: ${String(it.command).slice(0, 80)}`); onLog(`$ ${clip(String(it.command), 300)}`);
        } else if (ev.type === 'item.completed' && it?.type === 'command_execution') {
          logOutput(onLog, it.aggregated_output);
        } else if (ev.type === 'turn.completed' && ev.usage) usage = { input: Math.max(0, (ev.usage.input_tokens || 0) - (ev.usage.cached_input_tokens || 0)), output: ev.usage.output_tokens || 0 };
        else if (ev.type === 'turn.completed' && ev.usage) usage = { input: Math.max(0, (ev.usage.input_tokens || 0) - (ev.usage.cached_input_tokens || 0)), output: ev.usage.output_tokens || 0 };
        else if (ev.type === 'turn.failed') err = ev.error?.message || 'Codex turn failed';
        else if (ev.type === 'error') err = ev.message || err;
      },
    });
    if (err && !last) throw new Error(err);
    if (!last && code !== 0) throw new Error(stderr.trim() || `codex exited with code ${code}`);
    return { text: last.trim(), sessionId, usage };
  },
};

// ---------- web (API key) providers: text only, no file or command access ----------
async function* sseData(res) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
}

const claudeApi = {
  async run({ agent, prompt, system, history = [], conn, signal, onText, onLog }) {
    if (!conn?.apiKey) throw new Error('No Anthropic API key saved. Add one under Connections.');
    const base = process.env.APIARY_ANTHROPIC_URL || 'https://api.anthropic.com';
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': conn.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: agent.model || conn.model || 'claude-sonnet-5-5', max_tokens: 8192, stream: true, system, messages: [...history, { role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const log = lineLogger(onLog);
    let text = '', uin = 0, uout = 0;
    for await (const data of sseData(res)) {
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      if (ev.type === 'message_start') uin = (ev.message?.usage?.input_tokens || 0) + (ev.message?.usage?.cache_creation_input_tokens || 0);
      else if (ev.type === 'message_delta' && ev.usage?.output_tokens) uout = ev.usage.output_tokens;
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') { text += ev.delta.text; onText(ev.delta.text); log.push(ev.delta.text); }
      else if (ev.type === 'error') throw new Error(ev.error?.message || 'Anthropic API error');
    }
    log.flush();
    return { text: text.trim(), sessionId: null, usage: uin || uout ? { input: uin, output: uout } : null };
  },
};

const codexApi = {
  async run({ agent, prompt, system, history = [], conn, signal, onText, onLog }) {
    if (!conn?.apiKey) throw new Error('No OpenAI API key saved. Add one under Connections.');
    const model = agent.model || conn.model;
    if (!model) throw new Error('Set a model name for Codex (web) under Connections.');
    const base = process.env.APIARY_OPENAI_URL || 'https://api.openai.com';
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${conn.apiKey}` },
      body: JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const log = lineLogger(onLog);
    let text = '', usage = null;
    for await (const data of sseData(res)) {
      if (data === '[DONE]') break;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      if (ev.usage) usage = { input: ev.usage.prompt_tokens || 0, output: ev.usage.completion_tokens || 0 };
      const d = ev.choices?.[0]?.delta?.content;
      if (d) { text += d; onText(d); log.push(d); }
    }
    log.flush();
    return { text: text.trim(), sessionId: null, usage };
  },
};

// ---------- mock: deterministic fake agent for tests and demos ----------
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
const mock = {
  async run({ agent, prompt, system, env, signal, onText, onActivity, onLog }) {
    const sleep = (ms) => new Promise((r, j) => {
      const t = setTimeout(r, ms);
      signal?.addEventListener('abort', () => { clearTimeout(t); j(abortErr()); }, { once: true });
    });
    const delay = Number(process.env.APIARY_MOCK_DELAY || 8);
    const say = async (s) => { for (const w of s.split(/(?<= )/)) { onText(w); await sleep(delay); } };
    let out;
    onLog(`$ mock ${agent.name}`);
    if ((system || '').includes('ONBOARDING INTERVIEW')) {
      const n = (prompt.match(/^A\d+:/gm) || []).length;
      if (n < 2) out = JSON.stringify({ question: `Mock question ${n + 1}?`, choices: ['Yes', 'No'] });
      else out = JSON.stringify({ done: true, overview: 'They run a home network and a website.', team: /network|server/i.test(prompt)
        ? [{ title: 'Network Engineer', department: 'networking', role: 'Looks after the network', reason: 'They run a home network' }, { title: 'Security Engineer', department: 'security', role: 'Reviews risk', reason: 'Network changes need review' }]
        : [{ title: 'Web Developer', department: 'engineering', role: 'Builds the site', reason: 'They run a website' }, { title: 'Researcher', department: 'research', role: 'Finds facts', reason: 'Decisions need facts' }] });
    } else if (!agent.parentId && agent.kind !== 'general' && /plan-it/i.test(prompt) && !/Notes from Apiary:|^Nothing was run/m.test(prompt) && !(system || '').includes('PROJECT PLAN (')) {
      out = 'Here is the plan.\n\n```apiary-plan\n{"goal":"Launch the site","phases":[{"title":"Plan and design","goal":"Know what to build","steps":["Gather requirements","Draft the design"]},{"title":"Build","goal":"Make it work","steps":["Build the pages","Test everything"]}]}\n```';
    } else if (/progress:\d+:\d+/i.test(prompt) && !/Notes from Apiary:|^Nothing was run/m.test(prompt)) {
      const [, ph, st] = /progress:(\d+):(\d+)/i.exec(prompt);
      out = 'Recorded.\n\n```apiary-progress\n{"phase":' + ph + ',"step":' + st + ',"status":"done","note":"done in test"}\n```';
    } else if (prompt.startsWith('Support ticket #')) {
      onActivity('Looking into the ticket');
      out = /unfixable/i.test(prompt) && !/New message from the human/.test(prompt) ? 'NEEDS HUMAN: Which server should I check?' : `RESOLVED: I looked into it and fixed it. ${/New message from the human/.test(prompt) ? '(after your reply)' : ''}`;
    } else if (/make-task:/i.test(prompt) && !prompt.startsWith('Message from')) {
      const t = /make-task:(\S+)/i.exec(prompt)[1].replace(/_/g, ' ');
      out = 'Added it to the board.\n\n```apiary-task\n{"title":"' + t + '","notes":"from chat","status":"backburner"}\n```';
    } else if (prompt.startsWith('TEAM MEETING, update round')) {
      out = `Did my part of the work. Nothing blocked. (${agent.name})`;
    } else if (prompt.startsWith("TEAM MEETING, everyone's updates")) {
      out = 'Noted.';
    } else if (/environment variable \$APIARY_SECRET_/.test(prompt) && env) {
      const nm = /\$(APIARY_SECRET_[A-Z0-9_]+)/.exec(prompt)[1];
      out = `Logged in using the secret: ${env[nm]}${env[nm + '_USER'] ? ' as ' + env[nm + '_USER'] : ''}`;
    } else if (/use-secret:/i.test(prompt) && !/Notes from Apiary:/.test(prompt) && !prompt.startsWith('Message from')) {
      const nm = /use-secret:([^\s"]+)/i.exec(prompt)[1].replace(/_/g, ' ');
      out = 'I need a credential.\n\n```apiary-secret\n{"name":"' + nm + '","why":"to log in"}\n```';
    } else if (/remember this:/i.test(prompt) && !prompt.startsWith('Message from')) {
      const what = /remember this:\s*(.+)/i.exec(prompt)[1].replace(/["\\\n]/g, ' ');
      out = 'Noted.\n\n```apiary-remember\n{"text":"' + what + '","scope":"' + (/project note/i.test(prompt) ? 'project' : /global note/i.test(prompt) ? 'global' : 'agent') + '"}\n```';
    } else if (/what do you remember/i.test(prompt)) {
      const mem = (system || '').includes('MEMORY:') ? (system || '').slice((system || '').indexOf('MEMORY:')) : '(nothing)';
      out = 'I remember:\n' + mem;
    } else if (prompt.includes('Pre-check requested by')) {
      onActivity('Reviewing');
      if (/wipe/i.test(prompt) && (agent.title || agent.name) === 'Security') out = 'VERDICT: BLOCK\nREASON: Wiping the rules would expose everything.';
      else if (/firewall/i.test(prompt) && (agent.title || agent.name) === 'Security') out = 'VERDICT: CONDITIONS\nREASON: The current rules must be reviewed first.\nPREREQUISITE: Review and write down the current firewall rules';
      else if (/garble/i.test(prompt) && (agent.title || agent.name) === 'Research') out = 'Sounds fine to me.';
      else out = 'VERDICT: GO\nREASON: Nothing in my area stands in the way.';
    } else if (prompt.includes('Prerequisite for ') && agent.member) {
      onActivity('Doing the prerequisite');
      if (/failprereq/i.test(prompt)) out = 'FAILED: could not complete it.';
      else { if (agent.cwd) writeFileSync(path.join(agent.cwd, `${slugify(agent.title || agent.name)}-prereq.txt`), 'prerequisite done\n'); out = 'DONE: reviewed the rules and wrote them to a file.'; }
    } else if (prompt.startsWith('Task from ') && agent.member) {
      onActivity('Working');
      const sees = agent.cwd && existsSync(path.join(agent.cwd, 'security-prereq.txt'));
      if (agent.cwd) writeFileSync(path.join(agent.cwd, `${slugify(agent.title || agent.name)}.txt`), `Work by ${agent.name}\n`);
      out = `Finished the job. Sees prerequisite: ${sees ? 'yes' : 'no'}. Checks: ${(prompt.match(/^- \w+: \w+/gm) || []).join(' | ')}`;
    } else if (!agent.parentId && agent.kind !== 'general' && !/Notes from Apiary:|^Nothing was run|^Reports from/m.test(prompt) && /\bhire\b/i.test(prompt)) {
      out = 'I need specialists.\n\n```apiary-hire\n[{"name":"Frontend Engineer","role":"Builds the website UI","department":"engineering","complexity":"hard","reason":"The site needs a UI built and tested"},{"name":"Brand Writer","role":"Writes the site copy","department":"marketing","reason":"Copy needs a consistent voice","reportsTo":"Frontend Engineer"}]\n```';
    } else if (agent.team && !prompt.startsWith('Reports from your sub-agents') && !/Notes from Apiary:|^Nothing was run/m.test(prompt) && /network|research|assign-to:/i.test(prompt)) {
      const at = /assign-to:(\S+)/i.exec(prompt);
      const to = at ? at[1].replace(/_/g, ' ') : /network/i.test(prompt) ? 'Networking' : 'Research';
      out = 'Handing this to ' + to + '.\n\n```apiary-assign\n{"to":"' + to + '","task":"' + prompt.slice(0, 80).replace(/["\\\n]/g, ' ') + '"}\n```';
    } else if (prompt.startsWith('Replies from teammates') || (agent.parentId && /Replies from teammates|Notes from Apiary:/.test(prompt))) {
      onActivity('Reading replies');
      out = `Teammate replied. ${prompt.split('\n').filter((l) => l.startsWith('### ')).join(' ')} | ${prompt.includes('Not sent') ? 'blocked' : 'ok'}`;
    } else if (agent.parentId && /ask-(writer|lead|nobody)/.test(prompt) && !prompt.startsWith('Message from')) {
      const to = /ask-lead/.test(prompt) ? 'parent' : /ask-nobody/.test(prompt) ? 'Ghost' : 'Writer';
      out = 'Let me check with a teammate.\n\n```apiary-send\n{"to":"' + to + '","text":"Need your input on: ' + prompt.slice(0, 20).replace(/["\\\n]/g, ' ') + '"}\n```';
    } else if (prompt.startsWith('Reports from your sub-agents')) {
      onActivity('Summarising reports');
      if (agent.cwd) writeFileSync(path.join(agent.cwd, 'lead.txt'), 'summary\n');
      out = `All done. Here is the combined result:\n${prompt.split('\n').filter((l) => l.startsWith('### ')).join('\n')}`;
    } else if (!agent.parentId && /saved agent/i.test(prompt)) {
      out = 'Using a saved agent.\n\n```apiary-spawn\n{"agent":"Reviewer","task":"Review the work"}\n```';
    } else if (!agent.parentId && !/Notes from Apiary:|^Nothing was run/m.test(prompt) && /collab/i.test(prompt)) {
      const t = /collab-lead/.test(prompt) ? 'ask-lead' : /collab-ghost/.test(prompt) ? 'ask-nobody' : 'ask-writer';
      out = 'Splitting up.\n\n```apiary-spawn\n[{"name":"Researcher","role":"Finds facts","task":"' + t + ': research"},{"name":"Writer","role":"Writes","task":"Draft the summary"}]\n```';
    } else if (!agent.parentId && !/Notes from Apiary:|^Nothing was run/m.test(prompt) && /delegate|team|sub-?agent/i.test(prompt)) {
      out = 'I will split this up.\n\n' +
        '```apiary-spawn\n{"name":"Researcher","role":"Finds facts","task":"Research the topic"}\n```\n\n' +
        '```apiary-spawn\n{"name":"Writer","role":"Writes clearly","task":"Draft the summary","provider":"mock"}\n```';
    } else {
      onActivity('Thinking');
      if (agent.parentId && agent.cwd) writeFileSync(path.join(agent.cwd, `${slugify(agent.name)}.txt`), `Work by ${agent.name}\n${prompt}\n`);
      out = agent.parentId ? `Finished: ${prompt.slice(0, 60)}` : `You said: ${prompt}`;
    }
    onLog(`> ${out.split('\n')[0]}`);
    await say(out);
    return { text: out, sessionId: agent.sessionId || `mock-${agent.id}` };
  },
};

const cli = { claude: claudeCli, codex: codexCli, mock };
const api = { claude: claudeApi, codex: codexApi };

export const providers = {
  pick(agent) {
    const r = agent.method === 'api' ? api[agent.provider] : cli[agent.provider];
    if (!r) throw new Error(`No ${agent.method === 'api' ? 'web' : 'terminal'} connection for ${agent.provider}`);
    return r;
  },
  // A tiny real request used by "Test connection".
  async quickCheck(agent, conn) {
    const runner = providers.pick(agent);
    let text = '';
    const res = await runner.run({
      agent: { ...agent, cwd: os.tmpdir(), model: agent.model || (agent.method === 'api' ? '' : '') },
      prompt: 'Reply with the single word OK.', system: 'You are a connection test. Be brief.', history: [], conn,
      signal: AbortSignal.timeout(90000),
      onText: (t) => { text += t; }, onActivity: () => {}, onLog: () => {},
    });
    return (res.text || text || '(empty reply)').trim();
  },
};
