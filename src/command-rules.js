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
