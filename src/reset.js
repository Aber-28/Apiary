// Factory reset: deletes everything Apiary keeps and starts again from the setup wizard.
//
// It is deliberately hard to do by accident. The server asks three questions in order (YES, YES, then a sum)
// and a wrong answer cancels the whole thing, so the checks cannot be skipped by calling the API directly.
// Only Apiary's own data folder is touched, and only the things Apiary itself creates in it. Folders that
// projects were pointed at on the person's computer are never deleted.
import { rmSync, readdirSync, existsSync } from 'node:fs';
import { randomUUID, randomInt } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const err = (status, message) => Object.assign(new Error(message), { status });
const EXPIRES = 5 * 60 * 1000;
const OURS = ['state.json', 'memory.json', 'infra.json', 'audit.jsonl', 'vault.json', 'known_hosts', 'agents', 'org', 'meetings', 'workspaces', 'repos', 'worktrees'];

export class ResetGate {
  constructor() { this.run = null; }
  _live() { if (this.run && Date.now() > this.run.exp) this.run = null; return this.run; }
  start() {
    this.run = { id: randomUUID(), step: 1, exp: Date.now() + EXPIRES };
    return this._view();
  }
  _view() {
    const r = this.run;
    if (r.step === 1) return { id: r.id, step: 1, of: 3, prompt: 'This deletes EVERYTHING in Apiary: every project, chat, task, agent, memory, secret and setting. Type YES (capital letters) to continue.' };
    if (r.step === 2) return { id: r.id, step: 2, of: 3, prompt: 'Are you absolutely sure? This cannot be undone. There is no backup unless you exported one. Type YES again.' };
    return { id: r.id, step: 3, of: 3, prompt: `Last check. What is ${r.a} + ${r.b}?` };
  }
  cancel() { this.run = null; }
  // Returns { done: true } after the third correct answer, otherwise the next question. A wrong answer cancels everything.
  answer(id, text) {
    const r = this._live();
    if (!r || r.id !== id) throw err(409, 'This reset expired or was cancelled. Start again if you still want it.');
    const t = String(text ?? '').trim();
    if (r.step < 3) {
      if (t !== 'YES') { this.run = null; throw err(400, 'That was not YES. The reset was cancelled and nothing was deleted.'); }
      r.step++;
      if (r.step === 3) { r.a = randomInt(12, 60); r.b = randomInt(12, 60); }
      return this._view();
    }
    if (!/^\d{1,4}$/.test(t) || Number(t) !== r.a + r.b) { this.run = null; throw err(400, 'That was not the right answer. The reset was cancelled and nothing was deleted.'); }
    this.run = null;
    return { done: true };
  }
}

// What would be deleted, for the confirmation screen and for the tests.
export function plan(engine, { keepAccount = true } = {}) {
  const base = path.dirname(engine.store.file);
  const names = existsSync(base) ? readdirSync(base).filter((n) => OURS.includes(n) || /^backup-before-import-/.test(n) || /^\.export-/.test(n) || /\.tmp$/.test(n) || (!keepAccount && n === 'auth.json')) : [];
  const files = names.map((n) => path.join(base, n));
  if (engine.vault.keyFile) files.push(engine.vault.keyFile);
  return { base, files };
}

export function factoryReset(engine, opts = {}) {
  const { base, files } = plan(engine, opts);
  const home = os.homedir();
  if (!base || base === '/' || path.resolve(base) === path.resolve(home) || path.resolve(base).split(path.sep).filter(Boolean).length < 2) throw err(500, 'Refusing to reset: the data folder looks wrong.');
  // stop everything and make sure nothing running writes the old data back
  for (const id of Object.keys(engine.agents)) { try { engine.stop(id); } catch { /* ignore */ } }
  clearTimeout(engine.store._t); clearTimeout(engine.memory._t);
  const noop = () => {};
  engine.store.save = engine.store.flush = noop; engine.memory.save = engine.memory.flush = noop; engine.infra._save = noop; engine.vault._save = noop;
  engine.vault.lock();
  for (const f of files) { try { rmSync(f, { recursive: true, force: true }); } catch { /* keep going */ } }
  return { removed: files.length };
}
