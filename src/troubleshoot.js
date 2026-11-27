// Troubleshooting a device that is down or not reachable. Everything here is read-only except isSafeFix(), which is the
// short list of repairs the troubleshooter may run after you approve it once.
import dns from 'node:dns/promises';
import net from 'node:net';

export const UP_MS = 15 * 60 * 1000;   // after this long back up, the case closes and the next click starts a fresh one (and asks again)

const SVC = '[A-Za-z0-9@._:-]{1,80}';
const SUDO = '(?:sudo -n )?';
// One plain command per line, no shell tricks. Only these shapes ever run.
const SAFE = [
  new RegExp(`^${SUDO}systemctl (?:restart|start|status|is-active|is-enabled|is-failed) ${SVC}$`),
  new RegExp(`^${SUDO}systemctl --failed$`),
  new RegExp(`^${SUDO}journalctl -u ${SVC} -n \\d{1,3} --no-pager$`),
  new RegExp(`^${SUDO}(?:docker|podman) (?:restart|start) ${SVC}$`),
  new RegExp(`^${SUDO}(?:docker|podman) (?:ps|ps -a)$`),
  new RegExp(`^${SUDO}(?:qm|pct) (?:start|status|reboot) \\d{1,6}$`),
  new RegExp(`^${SUDO}(?:qm|pct) list$`),
  new RegExp(`^${SUDO}reboot$`),
  /^(?:uptime|df -h|free -m|ip -br addr|ip route|hostname|date|whoami|uname -a)$/,
  /^ping -c [1-5] [A-Za-z0-9.:-]{1,253}$/,
];
export const isSafeFix = (cmd) => typeof cmd === 'string' && cmd.length <= 200 && !/[\n\r;&|<>`$(){}\\'"*?~!#]/.test(cmd) && SAFE.some((r) => r.test(cmd.trim()));
export const isRepair = (cmd) => /\b(restart|start|reboot)\b/.test(cmd) && isSafeFix(cmd);

// The AI may end its answer with one ```apiary-fix block: {"commands":["..."],"on":"device|host","why":"..."}
export function parseFix(text) {
  const m = /```apiary-fix\s*([\s\S]*?)```/i.exec(String(text || ''));
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]);
    const commands = [].concat(j.commands || []).map((c) => String(c).trim()).filter(Boolean).slice(0, 8);
    return commands.length ? { commands, on: j.on === 'host' ? 'host' : 'device', why: String(j.why || '').slice(0, 300) } : null;
  } catch { return null; }
}
export const stripFix = (text) => String(text || '').replace(/```apiary-fix[\s\S]*?```/gi, '').trim();

const tcp = (host, port, ms = 4000) => new Promise((res) => {
  const s = net.connect({ host, port, timeout: ms });
  s.once('connect', () => { s.destroy(); res({ open: true }); });
  s.once('timeout', () => { s.destroy(); res({ open: false, why: 'no answer' }); });
  s.once('error', (e) => { s.destroy(); res({ open: false, why: e.code === 'ECONNREFUSED' ? 'refused' : (e.code || e.message) }); });
});

// What Apiary can see from here, without logging in anywhere.
export async function gatherFacts(infra, it, { lookup = (h) => dns.lookup(h), probe = tcp } = {}) {
  const f = { name: it.name, type: it.type, address: it.address || '', url: it.url || '', lastTest: it.status ? { ok: it.status.ok, detail: it.status.detail, since: it.status.since } : null, dns: null, ports: {} };
  const host = it.address || (it.url ? (() => { try { return new URL(it.url).hostname; } catch { return ''; } })() : '');
  if (host && !net.isIP(host)) { try { f.dns = { ok: true, ip: (await lookup(host)).address }; } catch (e) { f.dns = { ok: false, why: e.code || e.message }; } }
  if (host && (f.dns?.ok !== false)) {
    const main = it.port || (it.url ? (/^https:/i.test(it.url) ? 443 : 80) : 22);
    for (const p of [...new Set([main, 22, 443])].slice(0, 3)) f.ports[p] = await probe(host, p);
  }
  const parent = it.parentId && infra.get(it.parentId);
  if (parent) f.runsOn = { name: parent.name, ok: parent.status?.ok ?? null, detail: parent.status?.detail || 'not tested' };
  f.neighbours = infra.items.filter((x) => x.id !== it.id && x.state !== 'proposed' && x.status && (x.parentId === it.parentId && it.parentId || (it.links || []).some((l) => l.to === x.id) || (x.links || []).some((l) => l.to === it.id)))
    .slice(0, 8).map((x) => ({ name: x.name, ok: x.status.ok }));
  return f;
}

// Plain-words reasoning that needs no AI, so the button always helps.
export function basicAdvice(f) {
  const checks = []; let summary;
  const d = f.lastTest?.detail || '';
  if (f.dns && f.dns.ok === false) { summary = `The name "${f.address || f.url}" cannot be found.`; checks.push('Check the address is spelled right and that your DNS (router or Pi-hole) knows this name.', 'Try the IP address instead of the name.'); }
  else if (f.runsOn && f.runsOn.ok === false) { summary = `${f.name} runs on ${f.runsOn.name}, and ${f.runsOn.name} is not reachable either. That is the most likely cause.`; checks.push(`Fix ${f.runsOn.name} first (power, network cable, is it switched on?).`, `Then test ${f.name} again.`); }
  else if (/refused/i.test(d) || Object.values(f.ports).some((p) => p.why === 'refused')) { summary = `${f.name} answers, but nothing is listening on that port ("connection refused"). The machine is up; the service is not.`; checks.push('Is the service or app running? Try restarting it.', 'Check the port number is the one the service really uses.', 'Look at the machine\'s firewall.'); }
  else if (/timed out|no answer/i.test(d) || (Object.values(f.ports).length && Object.values(f.ports).every((p) => !p.open))) {
    summary = `${f.name} gives no answer at all. It is probably off, asleep, disconnected from the network, or blocked by a firewall.`;
    checks.push('Is it powered on? Look for lights, or check its power plug.', 'Is its network cable or Wi-Fi connected? Try another cable or port.', 'Can another device on the same network reach it?', 'If it is a virtual machine, check it is started on its host.');
    if (f.neighbours.length && f.neighbours.every((n) => n.ok === false)) checks.unshift('Everything near it is down too, so check the switch, router or power for that whole area first.');
  } else if (f.lastTest?.ok) summary = `${f.name} is reachable now.`;
  else { summary = d ? `The test says: ${d}.` : `${f.name} could not be tested.`; checks.push('Press Test connection again in a minute.'); }
  return { summary, checks };
}

export const SYSTEM = 'You are the troubleshooter inside Apiary, a home and small-office infrastructure app. Explain to a non-expert, in plain words, what is probably happening to a device that is down or unreachable, and what to check, most likely cause first. Be short: a few sentences, then a numbered list of at most 5 checks. Use only the facts given; say when you are guessing. If a safe repair could help (restarting a service, starting a VM, rebooting), end with ONE fenced block named apiary-fix like ```apiary-fix\n{"on":"device","commands":["systemctl restart nginx"],"why":"The web server is not answering"}\n``` using plain single commands only (systemctl, docker, qm, pct, reboot, journalctl, ping, uptime, df -h). Use "on":"host" when the command must run on the machine the device runs on (for example qm start 101 on the Proxmox host). Never ask for passwords or keys and never suggest deleting anything.';

// A readable list of what Apiary itself checked from the network, for the "what was tried" part of the report.
export function triedFromFacts(f) {
  const t = [];
  if (f.dns) t.push(f.dns.ok ? `Looked up the name: found ${f.dns.ip}.` : `Looked up the name: not found (${f.dns.why}).`);
  for (const [port, r] of Object.entries(f.ports || {})) t.push(`Knocked on port ${port}: ${r.open ? 'it answered' : `no answer (${r.why})`}.`);
  if (f.runsOn) t.push(`Checked ${f.runsOn.name}, which it runs on: ${f.runsOn.ok === true ? 'reachable' : f.runsOn.ok === false ? 'not reachable' : 'not tested yet'}.`);
  if (f.neighbours?.length) t.push(`Looked at nearby devices: ${f.neighbours.map((n) => `${n.name} ${n.ok ? 'up' : 'down'}`).join(', ')}.`);
  return t;
}

// The agent is asked to answer under four headings. Returns null when it did not, so the old free-text answer still shows.
export function parseReport(text) {
  const t = String(text || ''), H = /^\s*(?:#+\s*|\*\*)?(TRIED|FOUND|COULD NOT|YOU NEED TO)\s*:?\s*(?:\*\*)?:?\s*$/gim;
  const marks = [...t.matchAll(H)]; if (marks.length < 2) return null;
  const out = { tried: [], found: '', couldnt: [], needYou: [] };
  const items = (x) => x.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter((l) => l && !/^(none|nothing|n\/a)\.?$/i.test(l));
  marks.forEach((m, i) => { const body = t.slice(m.index + m[0].length, marks[i + 1]?.index ?? t.length).replace(/```apiary-fix[\s\S]*?```/gi, '').trim(), k = m[1].toUpperCase(); if (k === 'TRIED') out.tried = items(body); else if (k === 'FOUND') out.found = body; else if (k === 'COULD NOT') out.couldnt = items(body); else out.needYou = items(body); });
  return out;
}
