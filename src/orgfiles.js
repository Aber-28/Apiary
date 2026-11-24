// Everything about the team that a person may want to read or edit is kept as Markdown under ~/.apiary:
//   agents/<scope>/<role>.md    one profile per agent (read on every turn, so edits take effect at once)
//   org/company.md              the overview gathered during setup
//   meetings/<scope>/<date>.md  minutes of team meetings
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { HOME } from './store.js';

const safe = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'agent';
export const agentFile = (scope, key) => path.join(HOME, 'agents', safe(scope), `${safe(key)}.md`);
export const companyFile = () => path.join(HOME, 'org', 'company.md');
export const meetingDir = (scope) => path.join(HOME, 'meetings', safe(scope));

function put(file, text) { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, text, { mode: 0o600 }); return file; }

export function splitMd(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const meta = {};
  if (m) for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { meta, body: m ? text.slice(m[0].length) : text };
}
export function agentMd({ name, title, department, reportsTo, reason, instructions, hired }) {
  return `---\nname: ${name}\ntitle: ${title || ''}\ndepartment: ${department || ''}\nreports_to: ${reportsTo || ''}\nhired: ${new Date(hired || Date.now()).toISOString().slice(0, 10)}\n---\n# ${name}${title ? ` — ${title}` : ''}\n\n${reason ? `Hired because: ${reason}\n\n` : ''}${instructions}\n\n## Notes from the human\n(Anything you write here is read by this agent on every turn.)\n`;
}
export function writeAgent(scope, key, fields) { return put(agentFile(scope, key), agentMd(fields)); }
export const writeRaw = put;
// What the agent is told about itself: the file's contents without the front matter and title line.
export function readStanding(file) {
  try { return splitMd(readFileSync(file, 'utf8')).body.replace(/^\s*# .*\n/, '').trim().slice(0, 8000); } catch { return null; }
}
export function readCompany() { try { return readFileSync(companyFile(), 'utf8').slice(0, 6000); } catch { return ''; } }
export function writeCompany(text) { return put(companyFile(), text); }
export function writeMinutes(scope, date, text) { return put(path.join(meetingDir(scope), `${date}.md`), text); }
export function listMinutes() {
  const root = path.join(HOME, 'meetings'), out = [];
  if (!existsSync(root)) return out;
  for (const scope of readdirSync(root)) for (const f of readdirSync(path.join(root, scope))) if (f.endsWith('.md')) out.push({ scope, date: f.slice(0, -3) });
  return out.sort((a, b) => b.date.localeCompare(a.date));
}
export function readMinutes(scope, date) { return readFileSync(path.join(meetingDir(scope), `${safe(date).replace(/-+$/, '')}.md`), 'utf8'); }
