// Pictures and screenshots the person attaches to a chat message or a task.
// Kept as plain files under the Apiary home folder (never in the project), only png/jpeg/gif/webp (no SVG: it can carry scripts).
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const MAX_IMAGE = 8 * 1024 * 1024;   // per picture, after decoding
export const MAX_PER_MESSAGE = 6;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const err = (status, message) => Object.assign(new Error(message), { status });

// What the file really is, judged from its first bytes and not from what the sender claims.
export function sniff(buf) {
  if (buf.length > 12 && buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 6 && buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

export class Images {
  constructor(dir) { this.dir = dir; mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  // data: a data URL or plain base64. Returns { id, name, mime, size }.
  save({ name, data }) {
    const b64 = String(data || '').replace(/^data:[^,]*,/, '');
    if (!b64) throw err(400, 'No picture received');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > MAX_IMAGE) throw err(413, `That picture is too large (the limit is ${MAX_IMAGE / 1024 / 1024} MB).`);
    const ext = sniff(buf);
    if (!ext) throw err(400, 'Only PNG, JPEG, GIF and WebP pictures can be attached.');
    const id = `img-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    writeFileSync(path.join(this.dir, `${id}.${ext}`), buf, { mode: 0o600 });
    return { id, name: String(name || `picture.${ext}`).replace(/[^\w .()-]/g, '').slice(0, 60) || `picture.${ext}`, mime: TYPES[ext], size: buf.length };
  }
  find(id) {
    if (!/^img-[a-f0-9]{16}$/.test(String(id))) return null;
    for (const ext of Object.keys(TYPES)) { const p = path.join(this.dir, `${id}.${ext}`); if (existsSync(p)) return { id, path: p, mime: TYPES[ext] }; }
    return null;
  }
  read(id) { const f = this.find(id); return f ? { mime: f.mime, buf: readFileSync(f.path) } : null; }
  // Turn what the browser sent back ([{id,name}]) into trusted records; unknown ids are refused.
  resolve(list) {
    if (list == null) return [];
    if (!Array.isArray(list)) throw err(400, 'Bad picture list');
    if (list.length > MAX_PER_MESSAGE) throw err(400, `You can attach up to ${MAX_PER_MESSAGE} pictures at a time.`);
    return list.map((x) => {
      const f = this.find(x?.id);
      if (!f) throw err(400, 'One of the pictures is no longer available. Attach it again.');
      return { id: f.id, name: String(x.name || 'picture').replace(/[^\w .()-]/g, '').slice(0, 60) || 'picture', mime: f.mime };
    });
  }
  // Paths for the AI to open.
  files(list) { return (list || []).map((x) => this.find(x.id)).filter(Boolean).map((f) => ({ path: f.path, mime: f.mime })); }
  // Old pictures are dropped after a while so the folder does not grow forever.
  prune(days = 60) {
    const cut = Date.now() - days * 864e5;
    for (const f of readdirSync(this.dir)) { try { const p = path.join(this.dir, f); if (statSync(p).mtimeMs < cut) unlinkSync(p); } catch { /* gone already */ } }
  }
}

// The line added to a prompt so a terminal AI opens each picture itself.
export function imageNote(files) {
  if (!files?.length) return '';
  return `\n\n[The person attached ${files.length === 1 ? 'a picture' : `${files.length} pictures`}. Look at ${files.length === 1 ? 'it' : 'each one'} with your file-reading tool before you answer, and act on what you see:\n${files.map((f) => `- ${f.path}`).join('\n')}]`;
}
