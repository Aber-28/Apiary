// Approval rules: decisions you make once, so you are not asked every time.
// A rule says what kind of request it covers and whether to allow it automatically, always ask, or block it.
// When several rules match, the most careful one wins: block, then ask, then allow.
// Rules cover Apiary's own approvals (secrets, new agents, hires, plans, merges). Only you can change them.
import { randomUUID } from 'node:crypto';
import { commandRuleCovers, isDangerous, COMMAND_SCOPES } from './command-rules.js';

const err = (status, message) => Object.assign(new Error(message), { status });
export const KINDS = { any: 'anything', secret: 'use a secret', command: 'run a shell command', spawn: 'create sub-agents', hire: 'hire a team member', plan: 'accept a project plan', merge: 'merge code' };
export const ACTIONS = { allow: 'Allow without asking', ask: 'Always ask me', deny: 'Block' };
const RANK = { deny: 3, ask: 2, allow: 1 };

export class Policy {
  constructor(engine) { this.engine = engine; }
  get rules() { return (this.engine.store.data.settings.policy ||= []); }
  describe(r) {
    const what = r.kind === 'secret' && r.secret ? `use the secret "${r.secret}"`
      : r.kind === 'command' ? (r.scope === 'exact' ? `run the command "${r.command}"` : r.scope === 'program' ? `run any "${r.command}" command` : 'run read-only commands')
      : KINDS[r.kind];
    const who = r.agent ? `${this.engine.agents[r.agent]?.name || 'an agent'}` : 'an agent';
    return `${ACTIONS[r.action]}: ${r.kind === 'any' ? (r.agent ? `any request from ${who}` : 'any request') : `when ${who} wants to ${what}`}${r.project ? ` in the project "${this.engine.agents[r.project]?.name || 'unknown'}"` : ''}${r.contains ? ` and the request mentions "${r.contains}"` : ''}.`;
  }
  view() { return this.rules.map((r) => ({ ...r, text: this.describe(r) })); }
  _clean(b) {
    if (!KINDS[b.kind]) throw err(400, 'Pick what the rule is about');
    if (!ACTIONS[b.action]) throw err(400, 'Pick allow, ask or block');
    const project = b.project ? String(b.project) : '';
    if (project && (!this.engine.agents[project] || this.engine.agents[project].parentId)) throw err(400, 'That project does not exist');
    const secret = b.kind === 'secret' ? String(b.secret || '').trim().slice(0, 80) : '', contains = String(b.contains || '').trim().slice(0, 60);
    let scope = '', command = '';
    if (b.kind === 'command') {
      if (!COMMAND_SCOPES[b.scope]) throw err(400, 'Pick which commands the rule covers');
      scope = b.scope;
      command = scope === 'exact' ? String(b.command || '').trim().slice(0, 500) : scope === 'program' ? String(b.command || '').trim() : '';
      if (scope === 'exact' && !command) throw err(400, 'Enter the command');
      if (scope === 'program' && !/^[\w.-]{1,64}$/.test(command)) throw err(400, 'Enter a program name such as curl or ls');
    }
    const agent = b.agent ? String(b.agent) : '';
    if (agent && !this.engine.agents[agent]) throw err(400, 'That agent does not exist');
    return { kind: b.kind, action: b.action, project, secret, contains, scope, command, agent };
  }
  add(b) {
    const r = { id: randomUUID().slice(0, 8), ...this._clean(b), createdAt: Date.now() };
    if (this.rules.some((x) => ['kind', 'action', 'project', 'secret', 'contains', 'scope', 'command', 'agent'].every((k) => (x[k] || '') === (r[k] || '')))) throw err(409, 'That rule already exists');
    if (this.rules.length >= 100) throw err(400, 'Too many rules. Remove some first.');
    this.rules.push(r); this.engine.store.save();
    this.engine.audit?.add('system', { actor: 'You', action: 'added an approval rule', detail: this.describe(r) });
    return { ...r, text: this.describe(r) };
  }
  remove(id) {
    const i = this.rules.findIndex((r) => r.id === id); if (i < 0) throw err(404, 'No such rule');
    const [r] = this.rules.splice(i, 1); this.engine.store.save();
    this.engine.audit?.add('system', { actor: 'You', action: 'removed an approval rule', detail: this.describe(r) }); return r;
  }
  // ctx: { kind, title, secret, project (root agent id), agent (agent id), command (raw text of a shell command) }.
  // Returns the winning rule or null (null means ask as usual).
  match(ctx) {
    let best = null;
    for (const r of this.rules) {
      if (r.kind !== 'any' && r.kind !== ctx.kind) continue;
      if (r.project && r.project !== ctx.project) continue;
      if (r.agent && r.agent !== ctx.agent) continue;
      if (r.kind === 'command') {
        if (!commandRuleCovers(r, ctx.command)) continue;
        // A broad rule (any program, or read-only) never covers a command on the safety list. Only an exact rule or "allow everything for this agent" can.
        if (r.action === 'allow' && r.scope !== 'exact' && isDangerous(ctx.command)) continue;
      }
      if (r.kind === 'secret' && r.secret && String(ctx.secret || '').toLowerCase() !== r.secret.toLowerCase()) continue;
      if (r.contains && !String(ctx.title || '').toLowerCase().includes(r.contains.toLowerCase())) continue;
      if (!best || RANK[r.action] > RANK[best.action]) best = r;
    }
    return best && best.action !== 'ask' ? best : null;   // "ask" is the normal path; it only matters as an override of "allow"
  }
}
