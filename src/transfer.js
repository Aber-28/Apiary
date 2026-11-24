// Export everything to one file and import it into another Apiary (to move from one computer to another).
//
// The bundle is a .tar.gz of the data folder (state, memory, agent profiles, minutes, project folders and
// repositories) plus a small manifest. The vault is included only when asked, and stays encrypted: it can only be
// opened on the other side with its passphrase, which is checked before anything is changed.
// Importing never deletes: what was there before is moved to a backup-before-import-* folder.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, lstatSync, chmodSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { Vault } from './vault.js';

const DATA = ['state.json', 'memory.json', 'infra.json', 'agents', 'org', 'meetings'];
const FILES = ['workspaces', 'repos', 'worktrees'];
const MANIFEST = 'apiary-export.json';
const MAX_BYTES = 8 * 1024 ** 3;
const err = (status, message, extra = {}) => Object.assign(new Error(message), { status }, extra);

// Where an agent works outside the data folder cannot travel with the bundle; the manifest lists those.
function externalFolders(store, base) {
  const out = new Set();
  for (const a of Object.values(store.data.agents || {})) if (a.cwd && !a.cwd.startsWith(base + path.sep)) out.add(a.cwd);
  return [...out];
}

export function exportInfo(store, { vault = true, files = true } = {}) {
  const base = path.dirname(store.file);
  const size = (p) => { try { const r = spawnSync('du', ['-sk', p], { encoding: 'utf8' }); return Number(r.stdout.split('\t')[0]) * 1024 || 0; } catch { return 0; } };
  const parts = [...DATA, ...(vault ? ['vault.json'] : []), ...(files ? FILES : [])].filter((n) => existsSync(path.join(base, n)));
  return { parts, bytes: parts.reduce((n, p) => n + size(path.join(base, p)), 0), hasVault: existsSync(path.join(base, 'vault.json')), external: externalFolders(store, base) };
}

// Streams the bundle to `out` (an HTTP response or a file stream).
export function exportTo(engine, out, { vault = true, files = true, version = '' } = {}) {
  const store = engine.store, base = path.dirname(store.file);
  store.flush(); engine.memory.flush();
  const info = exportInfo(store, { vault, files });
  const tmp = mkdtempSync(path.join(base, '.export-'));
  const manifest = { apiary: 1, version, createdAt: new Date().toISOString(), home: base, includes: info.parts, vault: info.parts.includes('vault.json'), notIncluded: info.external };
  writeFileSync(path.join(tmp, MANIFEST), JSON.stringify(manifest, null, 2));
  const tar = spawn('tar', ['-czf', '-', '--exclude=node_modules', '--exclude=*.tmp', '-C', base, ...info.parts, '-C', tmp, MANIFEST], { stdio: ['ignore', 'pipe', 'pipe'] });
  let msg = '';
  tar.stderr.on('data', (d) => { msg += d; });
  const done = new Promise((resolve, reject) => {
    tar.on('error', (e) => reject(err(500, 'Could not run tar: ' + e.message)));
    tar.on('close', (code) => (code === 0 || code === 1 ? resolve(manifest) : reject(err(500, 'Export failed: ' + msg.trim().slice(0, 200)))));  // 1 = a file changed while reading
  }).finally(() => rmSync(tmp, { recursive: true, force: true }));
  tar.stdout.pipe(out);
  return { done, manifest };
}

function listEntries(file) {
  const r = spawnSync('tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw err(400, 'This is not a valid Apiary export file.');
  return r.stdout.split('\n').filter(Boolean);
}

// A tampered file could plant a link and then write a file "through" it to somewhere outside the data folder.
// Links themselves are fine (a project may contain some), but nothing may be stored beneath a link,
// hard links must stay inside the export, and special files (devices, pipes) are refused.
export function checkLinks(file) {
  const r = spawnSync('tar', ['-tvzf', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw err(400, 'This is not a valid Apiary export file.');
  const links = [], names = [];
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const kind = line[0];
    if (!['-', 'd', 'l', 'h'].includes(kind)) throw err(400, 'The file contains special files and was not imported.');
    const m = /^\S+\s+\S+\s+\d+\s+\d{4}-\d\d-\d\d \d\d:\d\d (.*)$/.exec(line); if (!m) continue;
    let name = m[1], target = '';
    if (kind === 'l') { [name, target] = [name.split(' -> ')[0], name.split(' -> ').slice(1).join(' -> ')]; links.push(name.replace(/^\.\//, '').replace(/\/$/, '')); }
    else if (kind === 'h') { [name, target] = [name.split(' link to ')[0], name.split(' link to ').slice(1).join(' link to ')]; if (target.startsWith('/') || target.split('/').includes('..')) throw err(400, 'The file contains links that point outside the data folder and was not imported.'); }
    names.push(name.replace(/^\.\//, ''));
  }
  for (const n of names) for (const l of links) if (n.startsWith(l + '/')) throw err(400, 'The file stores something beneath a link and was not imported.');
}

function fixPaths(dir, from, to, depth = 0) {
  if (depth > 4) return;
  let names; try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (n === 'node_modules') continue;
    const p = path.join(dir, n);
    if (n === '.git') {
      let st; try { st = lstatSync(p); } catch { continue; }
      if (st.isFile()) { try { const t = readFileSync(p, 'utf8'); if (t.includes(from)) writeFileSync(p, t.split(from).join(to)); } catch { /* skip */ } }
      else { const wt = path.join(p, 'worktrees'); try { for (const w of readdirSync(wt)) { const g = path.join(wt, w, 'gitdir'); const t = readFileSync(g, 'utf8'); if (t.includes(from)) writeFileSync(g, t.split(from).join(to)); } } catch { /* no worktrees */ } }
      continue;
    }
    let st; try { st = lstatSync(p); } catch { continue; }
    if (st.isDirectory()) fixPaths(p, from, to, depth + 1);
  }
}

// Receives the uploaded stream, checks it, and swaps the data in. Returns what was imported.
export async function importFrom(engine, input, { passphrase = '' } = {}) {
  const store = engine.store, base = path.dirname(store.file), stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const work = path.join(base, `.import-${stamp}`), file = work + '.tar.gz', ex = path.join(work, 'x');
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const cleanup = () => { rmSync(work, { recursive: true, force: true }); rmSync(file, { force: true }); };
  try {
    let n = 0;
    input.on('data', (d) => { n += d.length; if (n > MAX_BYTES) input.destroy(err(413, 'The file is too large')); });
    await pipeline(input, createWriteStream(file, { mode: 0o600 }));
    if (!n) throw err(400, 'No file was received.');
    const entries = listEntries(file);
    for (const e of entries) {
      if (e.startsWith('/') || e.split('/').includes('..')) throw err(400, 'The file contains unsafe paths and was not imported.');
      const top = e.replace(/^\.\//, '').split('/')[0];
      if (![...DATA, ...FILES, 'vault.json', MANIFEST].includes(top)) throw err(400, `The file contains something unexpected (${top}) and was not imported.`);
    }
    checkLinks(file);
    if (!entries.some((e) => e.replace(/^\.\//, '') === MANIFEST)) throw err(400, 'This is not an Apiary export (no manifest).');
    mkdirSync(ex, { recursive: true });
    const r = spawnSync('tar', ['-xzf', file, '-C', ex, '--no-same-owner'], { encoding: 'utf8' });
    if (r.status !== 0) throw err(400, 'Could not read the file: ' + (r.stderr || '').trim().slice(0, 200));
    let man; try { man = JSON.parse(readFileSync(path.join(ex, MANIFEST), 'utf8')); } catch { throw err(400, 'The export manifest is damaged.'); }
    if (man.apiary !== 1) throw err(400, 'This export was made by a newer Apiary. Update this one first.');
    if (!existsSync(path.join(ex, 'state.json'))) throw err(400, 'The file has no Apiary data in it.');
    try { JSON.parse(readFileSync(path.join(ex, 'state.json'), 'utf8')); } catch { throw err(400, 'The data in the file is damaged.'); }

    const hasVault = existsSync(path.join(ex, 'vault.json'));
    if (hasVault) {                       // the passphrase is checked first so a wrong one changes nothing
      if (!passphrase) throw err(400, 'This export contains a secrets vault. Enter its passphrase to import it.', { needsPassphrase: true });
      try { await new Vault(path.join(ex, 'vault.json')).unlock(passphrase); } catch { throw err(403, 'Wrong passphrase for the vault in this file. Nothing was imported.', { needsPassphrase: true }); }
    }

    // from here on nothing of the running process may write over what is imported
    for (const id of Object.keys(engine.agents)) { try { engine.stop(id); } catch { /* ignore */ } }
    clearTimeout(store._t); clearTimeout(engine.memory._t);
    store.save = store.flush = () => {}; engine.memory.save = engine.memory.flush = () => {};

    const incoming = readdirSync(ex).filter((x) => x !== MANIFEST);
    const backup = path.join(base, `backup-before-import-${stamp}`);
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    for (const name of incoming) if (existsSync(path.join(base, name))) renameSync(path.join(base, name), path.join(backup, name));
    for (const name of incoming) renameSync(path.join(ex, name), path.join(base, name));
    if (man.home && man.home !== base) {
      for (const f of ['state.json', 'memory.json']) {
        const p = path.join(base, f); if (!existsSync(p)) continue;
        const a = JSON.stringify(man.home).slice(1, -1), b = JSON.stringify(base).slice(1, -1);
        writeFileSync(p, readFileSync(p, 'utf8').split(a).join(b), { mode: 0o600 });
      }
      for (const d of FILES) if (existsSync(path.join(base, d))) fixPaths(path.join(base, d), man.home, base);
    }
    for (const f of ['state.json', 'memory.json', 'infra.json', 'vault.json', 'token']) { try { chmodSync(path.join(base, f), 0o600); } catch { /* not there */ } }
    return { imported: incoming, vault: hasVault, backup: path.basename(backup), from: man.createdAt, version: man.version, notIncluded: man.notIncluded || [] };
  } finally { cleanup(); }
}
