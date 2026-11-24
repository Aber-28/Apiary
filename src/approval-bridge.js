#!/usr/bin/env node
// Apiary approval bridge: a tiny MCP server that the Claude CLI starts for safe-mode agents.
// When a shell command is not pre-approved, the CLI calls its "approve" tool. This forwards the
// request to Apiary, where the person decides on the Approvals page, and returns the answer.
// Any failure is a denial, so a broken bridge never lets a command run.
import readline from 'node:readline';

const APPROVAL_URL = process.env.APIARY_APPROVAL_URL || '';
const RUN_TOKEN = process.env.APIARY_APPROVAL_TOKEN || '';

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const deny = (message) => ({ behavior: 'deny', message });

async function decide(args) {
  try {
    if (!APPROVAL_URL || !RUN_TOKEN) return deny('Apiary could not reach its approval queue.');
    const r = await fetch(APPROVAL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${RUN_TOKEN}` },
      body: JSON.stringify(args),
    });
    const out = await r.json().catch(() => null);
    if (r.ok && out && (out.behavior === 'allow' || out.behavior === 'deny')) return out;
    return deny(out?.error || 'The command was not approved.');
  } catch {
    return deny('Apiary could not reach its approval queue.');
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;   // notifications need no answer
  if (msg.method === 'initialize') {
    return reply(msg.id, {
      protocolVersion: msg.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'apiary-approvals', version: '1' },
    });
  }
  if (msg.method === 'tools/list') {
    return reply(msg.id, {
      tools: [{
        name: 'approve',
        description: 'Ask the person who runs Apiary whether a tool call may run.',
        inputSchema: {
          type: 'object',
          properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
          required: ['tool_name', 'input'],
        },
      }],
    });
  }
  if (msg.method === 'tools/call') {
    const decision = await decide(msg.params?.arguments || {});
    return reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(decision) }] });
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
});
rl.on('close', () => process.exit(0));
