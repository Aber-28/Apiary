// Run Apiary automatically at login, as a systemd *user* service (no root needed).
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './exec.js';
import { which } from './providers.js';

const BIN = path.resolve(fileURLToPath(new URL('../bin/apiary.js', import.meta.url)));
export const unitFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', 'apiary.service');
const sc = (...a) => run('systemctl', ['--user', ...a], { timeout: 20000 });
const q = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;

export async function status() {
  if (process.platform !== 'linux' || !which('systemctl')) return { supported: false, reason: 'systemd was not found on this machine, so Apiary cannot be set up as a service here.' };
  const probe = await sc('show-environment');
  if (probe.code !== 0) return { supported: false, reason: 'The systemd user session is not reachable from here (for example inside a container, or over su/sudo). Log in normally and try again.' };
  const [en, ac] = await Promise.all([sc('is-enabled', 'apiary'), sc('is-active', 'apiary')]);
  return { supported: true, installed: existsSync(unitFile()), enabled: en.stdout.trim() === 'enabled', active: ac.stdout.trim() === 'active', file: unitFile() };
}

export function unitText({ lan = false } = {}) {
  const lines = ['[Unit]', 'Description=Apiary', 'After=network-online.target', '', '[Service]',
    `ExecStart=${q(process.execPath)} ${q(BIN)} start${lan ? ' --lan' : ''}`, 'Restart=on-failure',
    // so the service finds claude, codex and gh exactly as this session does
    `Environment=${q('PATH=' + (process.env.PATH || '/usr/local/bin:/usr/bin:/bin'))}`];
  if (process.env.APIARY_HOME) lines.push(`Environment=${q('APIARY_HOME=' + process.env.APIARY_HOME)}`);
  if (process.env.APIARY_PORT) lines.push(`Environment=${q('APIARY_PORT=' + process.env.APIARY_PORT)}`);
  lines.push('', '[Install]', 'WantedBy=default.target', '');
  return lines.join('\n');
}

export async function install(opts = {}) {
  const st = await status();
  if (!st.supported) throw Object.assign(new Error(st.reason), { status: 409 });
  mkdirSync(path.dirname(unitFile()), { recursive: true });
  writeFileSync(unitFile(), unitText(opts));
  await sc('daemon-reload');
  const r = await sc('enable', 'apiary');
  if (r.code !== 0) throw Object.assign(new Error(`Could not enable the service: ${(r.stderr || r.stdout).trim().slice(0, 300)}`), { status: 500 });
  // keep it running after logout (best effort; may be refused on locked-down systems)
  if (process.env.APIARY_NO_LINGER !== '1') await run('loginctl', ['enable-linger', os.userInfo().username], { timeout: 10000 });
  return status();
}

export async function uninstall() {
  const st = await status();
  if (!st.supported) throw Object.assign(new Error(st.reason), { status: 409 });
  await sc('disable', 'apiary');            // does not stop a running instance
  if (existsSync(unitFile())) rmSync(unitFile());
  await sc('daemon-reload');
  return status();
}
