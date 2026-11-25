// Discovery: ask a host over SSH which virtual machines and containers it runs, so they can be added to the map.
//
// It is READ-ONLY by construction. The remote script is built only from the fixed list of listing commands
// below (DETECTORS), never from anything a person or an agent types, and nothing is written to the host.
// A test pins the exact set of commands, so adding a command that changes things fails the build.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'apiary-ssh');
const lines = (t) => String(t).split('\n').map((l) => l.replace(/\r$/, ''));
const cols = (l) => l.trim().split(/\s+/);
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const firstIp = (s) => (String(s).match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/) || [''])[0];
const ok = (name) => /^[^\s\u0000-\u001f][^\u0000-\u001f]{0,58}$/.test(name);

// Every detector is one listing command and a parser. tool = the program that must exist on the host.
export const DETECTORS = [
  { tag: 'proxmox-vm', label: 'Proxmox virtual machines', kind: 'vm', tool: 'qm', args: ['list'],
    parse: (t) => lines(t).map((l) => l.match(/^\s*(\d+)\s+(\S+)\s+(\S+)/)).filter(Boolean).map((m) => ({ ref: m[1], name: m[2], status: m[3] })) },
  { tag: 'proxmox-ct', label: 'Proxmox containers', kind: 'container', tool: 'pct', args: ['list'],
    parse: (t) => lines(t).filter((l) => /^\s*\d+\s/.test(l)).map((l) => { const c = cols(l); return { ref: c[0], name: c[c.length - 1], status: c[1] }; }).filter((x) => x.name && x.name !== x.ref) },
  { tag: 'libvirt', label: 'KVM / libvirt virtual machines', kind: 'vm', tool: 'virsh', args: ['-c', 'qemu:///system', 'list', '--all'],
    parse: (t) => lines(t).map((l) => l.match(/^\s*(\d+|-)\s+(\S+)\s+(.+?)\s*$/)).filter(Boolean).map((m) => ({ ref: m[2], name: m[2], status: m[3] })) },
  { tag: 'esxi', label: 'VMware ESXi virtual machines', kind: 'vm', tool: 'vim-cmd', args: ['vmsvc/getallvms'],
    parse: (t) => lines(t).map((l) => l.match(/^\s*(\d+)\s+(.+?)\s+\[[^\]]+\]/)).filter(Boolean).map((m) => ({ ref: m[1], name: m[2], status: 'unknown' })) },
  { tag: 'xcp', label: 'XCP-ng / XenServer virtual machines', kind: 'vm', tool: 'xe', args: ['vm-list', 'is-control-domain=false', 'params=name-label,power-state'],
    parse: (t) => { const out = []; let cur = {}; for (const l of [...lines(t), '']) { const m = l.match(/^\s*(name-label|power-state)\s*\(.*?\)\s*:\s*(.*)$/); if (m) cur[m[1]] = m[2].trim(); else if (!l.trim() && cur['name-label']) { out.push({ ref: cur['name-label'], name: cur['name-label'], status: cur['power-state'] || 'unknown' }); cur = {}; } } return out; } },
  { tag: 'docker', label: 'Docker containers', kind: 'container', tool: 'docker', args: ['ps', '-a', '--format', '{{.Names}}|{{.State}}|{{.Image}}'],
    parse: (t) => lines(t).filter((l) => l.includes('|')).map((l) => { const [name, status] = l.split('|'); return { ref: name, name, status }; }) },
  { tag: 'lxc', label: 'LXC containers', kind: 'container', tool: 'lxc-ls', args: ['-f'],
    parse: (t) => lines(t).filter((l) => l.trim() && !/^NAME\b/.test(l)).map((l) => { const c = cols(l); return { ref: c[0], name: c[0], status: (c[1] || 'unknown').toLowerCase(), address: IPV4.test((c[4] || '').split(',')[0]) ? c[4].split(',')[0] : '' }; }) },
  { tag: 'incus', label: 'Incus containers and VMs', kind: 'container', tool: 'incus', args: ['list', '--format', 'csv', '-c', 'ns4'],
    parse: (t) => lines(t).map((l) => l.match(/^"?([^",]+)"?,([A-Za-z]+),(.*)$/)).filter(Boolean).map((m) => ({ ref: m[1], name: m[1], status: m[2].toLowerCase(), address: firstIp(m[3]) })) },
  { tag: 'lxd', label: 'LXD containers and VMs', kind: 'container', tool: 'lxc', args: ['list', '--format', 'csv', '-c', 'ns4'],
    parse: (t) => lines(t).map((l) => l.match(/^"?([^",]+)"?,([A-Za-z]+),(.*)$/)).filter(Boolean).map((m) => ({ ref: m[1], name: m[1], status: m[2].toLowerCase(), address: firstIp(m[3]) })) },
];
// Windows: Hyper-V is read through PowerShell. It is the only detector that is not run by sh.
export const HYPERV = { tag: 'hyperv', label: 'Hyper-V virtual machines', kind: 'vm', cmd: 'Get-VM',
  parse: (t) => lines(t).filter((l) => l.includes('|')).map((l) => { const [name, status] = l.split('|'); return { ref: name.trim(), name: name.trim(), status: (status || '').trim().toLowerCase() }; }) };

export const BY_TAG = new Map([...DETECTORS, HYPERV].map((d) => [d.tag, d]));
export const commandOf = (d) => (d.cmd ? d.cmd : [d.tool, ...d.args].join(' '));
export const COMMANDS = [...DETECTORS.map(commandOf), commandOf(HYPERV)];

const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
// The same listing command is retried through passwordless sudo if the first try is refused, since hypervisor tools usually need root.
export function posixScript() {
  return [
    'run() { tag="$1"; shift; out=$("$@" 2>&1); rc=$?; if [ "$rc" -ne 0 ] && [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1; then o2=$(sudo -n "$@" 2>&1); if [ $? -eq 0 ]; then out="$o2"; rc=0; fi; fi; printf \'@@APIARY %s rc=%s\\n%s\\n\' "$tag" "$rc" "$out"; }',
    "echo '@@APIARY begin'",
    ...DETECTORS.map((d) => `if command -v ${d.tool} >/dev/null 2>&1; then run ${d.tag} ${d.tool} ${d.args.map(shq).join(' ')}; fi`),
    "echo '@@APIARY end'", '',
  ].join('\n');
}
export function powershellScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "'@@APIARY begin'",
    `if (Get-Command Get-VM -ErrorAction SilentlyContinue) { try { $o = @(${HYPERV.cmd} | ForEach-Object { "$($_.Name)|$($_.State)" }); '@@APIARY ${HYPERV.tag} rc=0'; $o } catch { '@@APIARY ${HYPERV.tag} rc=1'; $_.Exception.Message } }`,
    "'@@APIARY end'", '',
  ].join('\n');
}

// Turn the host's output into sections: { begun, ended, sections: [{ tag, rc, text }] }
export function parseSections(stdout) {
  const res = { begun: false, ended: false, sections: [] }; let cur = null;
  for (const l of lines(stdout)) {
    const m = l.match(/^@@APIARY (\S+)(?: rc=(\d+))?\s*$/);
    if (m) {
      if (m[1] === 'begin') { res.begun = true; cur = null; continue; }
      if (m[1] === 'end') { res.ended = true; cur = null; continue; }
      cur = { tag: m[1], rc: Number(m[2] ?? 0), text: '' }; res.sections.push(cur); continue;
    }
    if (cur) cur.text += l + '\n';
  }
  return res;
}

// What was found, per detector, and the machines themselves.
export function interpret(parsed, redact = (x) => x) {
  const detected = [], found = [];
  for (const s of parsed.sections) {
    const d = BY_TAG.get(s.tag); if (!d) continue;
    if (s.rc !== 0) { detected.push({ tag: d.tag, label: d.label, ok: false, count: 0, note: redact((s.text.trim().split('\n')[0] || 'could not list').slice(0, 160)) }); continue; }
    const items = d.parse(s.text).filter((x) => x.name && ok(x.name));
    detected.push({ tag: d.tag, label: d.label, ok: true, count: items.length, note: '' });
    for (const x of items) found.push({ tag: d.tag, label: d.label, kind: d.kind, key: `${d.tag}:${x.ref}`, name: x.name, status: x.status || 'unknown', address: x.address || '' });
  }
  return { detected, found };
}

// Plain-English reasons for the usual SSH failures.
export function explainSsh(stderr, code) {
  const t = String(stderr);
  if (/Permission denied|Authentication failed/i.test(t)) return 'The server refused the login. Check the username and password or key stored in the vault.';
  if (/Connection refused/i.test(t)) return 'The server refused the connection. Is SSH switched on, and is the port right?';
  if (/timed out|Operation timed out|No route to host|Network is unreachable/i.test(t)) return 'The server did not answer. Check the address and that it is switched on.';
  if (/Could not resolve|Name or service not known|nodename nor servname/i.test(t)) return 'The address could not be found. Check the spelling.';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(t)) return 'The server\'s identity changed since the last connection, so Apiary stopped. If you reinstalled it, remove its line from the known_hosts file in the Apiary data folder.';
  if (/ssh is not installed|ssh-agent is not installed/i.test(t)) return 'The SSH program is not installed on this computer. Install it with: sudo apt install openssh-client';
  return `Could not log in${code ? ` (code ${code})` : ''}. ${t.trim().split('\n').pop() || ''}`.trim();
}
const looksWindows = (r) => /is not recognized|not recognized as|not found|The term 'sh'/i.test(r.stdout + r.stderr) || r.code === 127 || r.code === 1;

// Runs one script on the host through apiary-ssh (which keeps the password or key out of files and command lines).
export function sshRun({ name, env, shell, script, timeoutMs = 60000 }) {
  const remote = shell === 'powershell' ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', '-'] : ['sh', '-s'];
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (k.startsWith('APIARY_SECRET_')) delete childEnv[k];
  Object.assign(childEnv, env);
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const c = spawn(process.execPath, [BIN, name, '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3', '--', ...remote], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const fin = (r) => { if (done) return; done = true; clearTimeout(t); resolve(r); };
    const t = setTimeout(() => { try { c.kill('SIGTERM'); } catch { /* gone */ } fin({ code: 124, stdout: out, stderr: err + '\ntimed out' }); }, timeoutMs);
    c.stdout.on('data', (d) => { if (out.length < 1e6) out += d; });
    c.stderr.on('data', (d) => { if (err.length < 1e5) err += d; });
    c.on('error', (e) => fin({ code: 127, stdout: out, stderr: String(e.message) }));
    c.on('close', (code) => fin({ code: code ?? 1, stdout: out, stderr: err }));
    c.stdin.on('error', () => {}); c.stdin.end(script);
  });
}

// Look at a host: try the Linux/Unix way first, then Windows PowerShell. Returns { detected, found }.
export async function probe(run, redact) {
  let r = await run('sh', posixScript()), p = parseSections(r.stdout);
  if (!p.begun) {
    if (r.code === 255 || (r.code === 124)) throw Object.assign(new Error(explainSsh(r.stderr, r.code)), { status: 502 });
    if (looksWindows(r)) { r = await run('powershell', powershellScript()); p = parseSections(r.stdout); }
  }
  if (!p.begun) throw Object.assign(new Error(explainSsh(r.stderr, r.code)), { status: 502 });
  return interpret(p, redact);
}
