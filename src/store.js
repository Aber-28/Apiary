// Tiny JSON-file store. State is small (agents, chat history, logs, settings), so one file is plenty.
// The file can hold API keys and tokens, so it is written with owner-only permissions.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.APIARY_HOME || path.join(os.homedir(), '.apiary');

export class Store {
  constructor(file = path.join(HOME, 'state.json')) {
    this.file = file;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.data = {};
    if (existsSync(file)) {
      try { this.data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
        console.error('Could not read state file, starting fresh:', e.message);
      }
    }
    for (const k of ['agents', 'messages', 'logs', 'defs', 'approvals']) this.data[k] ||= {};
    this.data.settings ||= {};
    this._t = null;
  }
  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.flush(), 300);
  }
  flush() {
    clearTimeout(this._t);
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }
}
