// Deciding which shell commands an agent may run without asking, and which must always be asked about.
// Everything here is conservative: when in doubt a command is treated as needing a person's answer.

// Characters that let one command chain, redirect or substitute another: any command that has them is judged as a whole and never matches a narrow rule.
const COMPOUND = /[;&|<>`\n\r]|\$\(|\$\{/;

// Programs that change something or can be used to. Always asked, even when a broader rule would allow it.
const DANGEROUS_PROGRAMS = new Set(['rm', 'rmdir', 'dd', 'mkfs', 'shred', 'reboot', 'shutdown', 'poweroff', 'halt', 'init', 'kill', 'killall', 'pkill', 'chown', 'chgrp', 'mv', 'sudo', 'su', 'passwd', 'useradd', 'userdel', 'crontab', 'iptables', 'nft', 'ufw', 'mount', 'umount', 'fdisk', 'parted', 'wipefs', 'truncate', 'tee', 'sed', 'eval', 'exec', 'python', 'python3', 'perl', 'ruby', 'node', 'bash', 'sh', 'zsh', 'env', 'xargs', 'find', 'awk', 'nc', 'ncat', 'telnet', 'ssh', 'scp', 'rsync', 'sftp']);

// Subcommands of tools that change state (checked after the program name).
const DANGEROUS_SUBCOMMANDS = {
  apt: ['install', 'remove', 'purge', 'upgrade', 'full-upgrade', 'dist-upgrade', 'autoremove', 'update'],
  'apt-get': ['install', 'remove', 'purge', 'upgrade', 'full-upgrade', 'dist-upgrade', 'autoremove', 'update'],
  dpkg: ['-i', '--install', '-r', '--remove', '-P', '--purge', '--configure'],
  pct: ['create', 'destroy', 'stop', 'start', 'shutdown', 'reboot', 'reset', 'set', 'resize', 'rollback', 'restore', 'migrate', 'move-volume', 'delete'],
  qm: ['create', 'destroy', 'stop', 'start', 'shutdown', 'reboot', 'reset', 'set', 'resize', 'rollback', 'restore', 'migrate', 'move-disk', 'delete'],
  systemctl: ['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'unmask', 'reboot', 'poweroff', 'kill', 'daemon-reload', 'edit'],
  docker: ['rm', 'rmi', 'stop', 'start', 'restart', 'kill', 'prune', 'run', 'exec', 'build', 'pull', 'push', 'create', 'update', 'network', 'volume', 'compose'],
  zfs: ['destroy', 'create', 'set', 'rollback', 'rename', 'receive'],
  zpool: ['destroy', 'create', 'add', 'remove', 'offline', 'online', 'replace', 'import', 'export', 'clear'],
  git: ['push', 'reset', 'clean', 'checkout', 'rebase', 'commit', 'merge', 'pull', 'fetch', 'rm', 'add'],
};

// Programs that only look at things. A command with one of these as its program can run without asking
// when a read-only rule applies, as long as it passes the checks below.
const READ_ONLY_PROGRAMS = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'wc', 'df', 'du', 'free', 'uptime', 'uname', 'date', 'hostname', 'whoami', 'id', 'ps', 'pwd', 'stat', 'file', 'which', 'pveversion', 'ss', 'dig', 'nslookup', 'journalctl', 'lsblk', 'lscpu', 'sensors']);
// For these programs only the listed first arguments are read-only.
const READ_ONLY_SUBCOMMANDS = {
  docker: ['ps', 'logs', 'inspect', 'images', 'stats', 'version', 'info', 'top', 'port'],
  systemctl: ['status', 'is-active', 'is-enabled', 'list-units', 'list-unit-files', 'show', 'cat'],
  pct: ['list', 'status', 'config'],
  qm: ['list', 'status', 'config'],
  apt: ['list', 'show', 'policy'],
  'apt-get': ['changelog'],
  zfs: ['list', 'get', 'status'],
  zpool: ['list', 'status', 'get'],
  git: ['status', 'log', 'diff', 'show', 'branch'],
  ip: ['addr', 'address', 'route', 'link', 'show'],
};
// curl and wget may read, but these options send or change data.
const CURL_WRITE = /^(-X|--request|-d|--data|--data-|-F|--form|-T|--upload-file|-o|--output|-O|--remote-name|--json|-u|--user)/;

// The program name and arguments of a plain command (no chaining), or null if it is compound or empty.
export function parseCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd || COMPOUND.test(cmd)) return null;
  const parts = cmd.split(/\s+/);
  return { program: parts[0].split('/').pop(), args: parts.slice(1), text: cmd };
}

export const isCompound = (command) => !parseCommand(command);

// Always asked, regardless of a narrower rule.
export function isDangerous(command) {
  const p = parseCommand(command);
  if (!p) return true;
  if (DANGEROUS_PROGRAMS.has(p.program)) return true;
  const sub = p.args.find((a) => !a.startsWith('-')) || '';
  if ((DANGEROUS_SUBCOMMANDS[p.program] || []).some((d) => d === sub || p.args.includes(d))) return true;
  if ((p.program === 'curl' || p.program === 'wget') && p.args.some((a) => CURL_WRITE.test(a))) return true;
  return false;
}

// True for commands that only read. Used by the read-only preset.
export function isReadOnly(command) {
  const p = parseCommand(command);
  if (!p || isDangerous(command)) return false;
  if (READ_ONLY_PROGRAMS.has(p.program)) return true;
  if (READ_ONLY_SUBCOMMANDS[p.program]) {
    const sub = p.args.find((a) => !a.startsWith('-')) || '';
    return READ_ONLY_SUBCOMMANDS[p.program].includes(sub);
  }
  if (p.program === 'curl' || p.program === 'wget') return !p.args.some((a) => CURL_WRITE.test(a));
  return false;
}

// Does a command rule cover this command? scope: 'exact' (the same command text), 'program' (any use of one program), 'readonly' (read-only commands).
export function commandRuleCovers(rule, command) {
  const p = parseCommand(command);
  if (!p) return false;
  if (rule.scope === 'exact') return p.text === String(rule.command || '').trim();
  if (rule.scope === 'program') return p.program === rule.command && !isDangerous(command);
  if (rule.scope === 'readonly') return isReadOnly(command);
  return false;
}

export const COMMAND_SCOPES = { exact: 'this exact command', program: 'any command that runs this program', readonly: 'read-only commands (status, lists, logs, GET-only web requests)' };

// ---------- trust levels (the slider on the Access and safety page) ----------
// Risk of a shell command, from the least to the most serious:
// 0 = simple, read or harmless; 1 = chained (&&, ||, ;, |) or runs a script or interpreter;
// 2 = changes something (writes, redirects, service or package changes, network writes); 3 = destroys or reboots.
const DESTRUCTIVE_PROGRAMS = new Set(['rm', 'rmdir', 'dd', 'mkfs', 'shred', 'reboot', 'shutdown', 'poweroff', 'halt', 'init', 'kill', 'killall', 'pkill', 'wipefs', 'truncate', 'fdisk', 'parted']);
const DESTRUCTIVE_SUBCOMMANDS = {
  apt: ['remove', 'purge', 'autoremove'], 'apt-get': ['remove', 'purge', 'autoremove'], dpkg: ['-r', '--remove', '-P', '--purge'],
  pct: ['destroy', 'delete'], qm: ['destroy', 'delete'], zfs: ['destroy'], zpool: ['destroy'],
  docker: ['rm', 'rmi', 'prune'], systemctl: ['reboot', 'poweroff'], git: ['reset', 'clean'],
};
const CHANGE_PROGRAMS = new Set(['mv', 'chown', 'chgrp', 'tee', 'sed', 'sudo', 'su', 'passwd', 'useradd', 'userdel', 'crontab', 'iptables', 'nft', 'ufw', 'mount', 'umount', 'ssh', 'scp', 'rsync', 'sftp', 'nc', 'ncat', 'telnet']);
const INTERPRETERS = new Set(['python', 'python3', 'perl', 'ruby', 'node', 'bash', 'sh', 'zsh', 'env', 'xargs', 'awk', 'eval', 'exec']);
const SEPARATORS = /&&|\|\||;|\||\n/;

function partRisk(part) {
  const tokens = part.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  const prog = tokens[0].split('/').pop(), args = tokens.slice(1);
  const sub = args.find((a) => !a.startsWith('-')) || '';
  if (DESTRUCTIVE_PROGRAMS.has(prog)) return 3;
  if ((DESTRUCTIVE_SUBCOMMANDS[prog] || []).some((d) => d === sub || args.includes(d))) return 3;
  if (prog === 'find' && args.some((a) => ['-delete', '-exec', '-execdir', '-ok'].includes(a))) return 3;
  if (CHANGE_PROGRAMS.has(prog)) return 2;
  if ((DANGEROUS_SUBCOMMANDS[prog] || []).some((d) => d === sub || args.includes(d))) return 2;
  if ((prog === 'curl' || prog === 'wget') && args.some((a) => CURL_WRITE.test(a))) return 2;
  if (INTERPRETERS.has(prog)) return 1;
  return 0;
}

export function riskOf(command) {
  const cmd = String(command || '');
  if (!cmd.trim()) return 3;
  let risk = 0;
  if (/[`<>]|\$\(|\$\{/.test(cmd)) risk = 2;                  // redirects, writes and substitutions
  const parts = cmd.split(SEPARATORS).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1) risk = Math.max(risk, 1);            // chained commands
  for (const part of parts) risk = Math.max(risk, partRisk(part));
  return risk;
}

// The six positions of the slider. Index 0 asks for every command; index 5 runs everything.
export const TRUST_LEVELS = [
  'Ask me for every command',
  'Read-only commands run; everything else asks',
  'Simple commands run; chains, scripts and changes ask',
  'Chains and scripts run too; changes and destructive commands ask',
  'Everything runs except deleting, rebooting and destroying',
  'Everything runs without asking',
];

export function levelAllows(level, command) {
  const L = Math.min(5, Math.max(0, Math.trunc(Number(level)) || 0));
  if (L >= 5) return true;
  if (L <= 0) return false;
  if (L === 1) return isReadOnly(command);
  const risk = riskOf(command);
  if (L === 2) return risk === 0;
  if (L === 3) return risk <= 1;
  return risk <= 2;
}

