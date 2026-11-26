// A short per-task "handover" note, kept as one Markdown file that the agent overwrites (never appends to).
// If Claude and Codex swap mid-task, the new one reads it and carries on. Lives in Apiary's own folder, never in a project.
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';

export const KEEP_DAYS = 7;   // a note nobody has updated for this long is deleted

export class Handover {
  constructor(dir) { this.dir = dir; mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  fileFor(agentId) { return path.join(this.dir, `${String(agentId).replace(/[^a-z0-9_-]/gi, '')}.md`); }
  exists(agentId) { return existsSync(this.fileFor(agentId)); }
  prune(days = KEEP_DAYS) {
    let n = 0;
    try {
      for (const f of readdirSync(this.dir)) {
        if (!f.endsWith('.md')) continue;
        const p = path.join(this.dir, f);
        if (Date.now() - statSync(p).mtimeMs > days * 86400e3) { try { unlinkSync(p); n++; } catch { /* leave it */ } }
      }
    } catch { /* nothing to prune */ }
    return n;
  }
  // Told to the agent every turn (short), so it keeps the note current.
  instruction(agentId) {
    return `HANDOVER NOTE: For work that takes several steps, keep one short Markdown file up to date at ${this.fileFor(agentId)}. ` +
      'Overwrite it at the end of each such turn (never append, keep it under about 40 lines) with these headings: Goal, Done, In progress, Next steps, Decisions, Files changed. ' +
      'Skip it for quick questions. Never put passwords, keys or tokens in it. Another AI may need to carry on from this note if you are interrupted.\n';
  }
  // Added to the system prompt when the step is handed to the other AI.
  switchNote(agentId, from) {
    const f = this.fileFor(agentId);
    return `\nHANDOVER: This step was handed to you because ${from || 'the other AI'} could not continue. ` +
      (existsSync(f) ? `Read ${f} first: it says what was done and what comes next. ` : 'There is no handover note yet, so check the project files (and git status or git log if it is a repository) to see what was already done. ') +
      `The last turn may have been cut off part-way, so check the files listed as changed before relying on them. Then carry on, and update ${f}.\n`;
  }
}
