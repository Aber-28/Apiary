// Deciding which shell commands an agent may run without asking, and which must always be asked about.
// Everything here is conservative: when in doubt a command is treated as needing a person's answer.

// Anything that chains, redirects, backgrounds, substitutes or expands. Such a command is judged as a whole and never matches a narrow rule.
const COMPOUND = /[;&|<>`\n\r]|\$/;
// Where one command ends and the next begins (a single & starts a background command).
const SEPARATORS = /&&|\|\||;|\||&|\n|\r/;

// Programs that wrap another command. The command they run is classified in its place.
const WRAPPERS = new Set(['sudo', 'doas', 'su', 'nohup', 'nice', 'ionice', 'time', 'timeout', 'stdbuf', 'command', 'exec', 'env', 'xargs', 'chroot']);
// Wrappers that raise privileges: at least risk 2, even when the command inside is harmless.
const PRIVILEGE = new Set(['sudo', 'doas', 'su', 'chroot']);

const DESTRUCTIVE_PROGRAMS = new Set(['rm', 'rmdir', 'unlink', 'dd', 'mkfs', 'shred', 'reboot', 'shutdown', 'poweroff', 'halt', 'init', 'kill', 'killall', 'pkill', 'wipefs', 'truncate', 'fdisk', 'parted']);
const DESTRUCTIVE_SUBCOMMANDS = {
  apt: ['remove', 'purge', 'autoremove'], 'apt-get': ['remove', 'purge', 'autoremove'], dpkg: ['-r', '--remove', '-P', '--purge'],
  pct: ['destroy', 'delete'], qm: ['destroy', 'delete'], zfs: ['destroy'], zpool: ['destroy'],
  docker: ['rm', 'rmi', 'prune'], systemctl: ['reboot', 'poweroff'], git: ['reset', 'clean'],
};
// Changes something: services, packages, containers, network writes, file ownership or moves.
const CHANGE_PROGRAMS = new Set(['mv', 'chown', 'chgrp', 'tee', 'sed', 'passwd', 'useradd', 'userdel', 'crontab', 'iptables', 'nft', 'ufw', 'mount', 'umount', 'ssh', 'scp', 'rsync', 'sftp', 'nc', 'ncat', 'telnet', 'wget', 'make', 'npm', 'npx', 'yarn', 'pnpm', 'pip', 'pip3', 'cargo', 'go', 'gradle', 'mvn', 'apt-key', 'systemd-run']);
const CHANGE_SUBCOMMANDS = {
  apt: ['install', 'upgrade', 'full-upgrade', 'dist-upgrade', 'update'], 'apt-get': ['install', 'upgrade', 'full-upgrade', 'dist-upgrade', 'update'], dpkg: ['-i', '--install', '--configure'],
  pct: ['create', 'stop', 'start', 'shutdown', 'reset', 'set', 'resize', 'rollback', 'restore', 'migrate', 'move-volume'],
  qm: ['create', 'stop', 'start', 'shutdown', 'reset', 'set', 'resize', 'rollback', 'restore', 'migrate', 'move-disk'],
  systemctl: ['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'unmask', 'kill', 'daemon-reload', 'edit'],
  docker: ['stop', 'start', 'restart', 'kill', 'run', 'exec', 'build', 'pull', 'push', 'create', 'update', 'network', 'volume', 'compose'],
  zfs: ['create', 'set', 'rename', 'receive'], zpool: ['create', 'add', 'offline', 'online', 'replace', 'import', 'export', 'clear'],
  git: ['push', 'checkout', 'rebase', 'commit', 'merge', 'pull', 'fetch', 'rm', 'add', 'stash', 'tag'],
};
// Scripts and code runners: what they run is unknown, so they are at least risk 2.
const INTERPRETERS = new Set(['python', 'python3', 'perl', 'ruby', 'node', 'bash', 'sh', 'zsh', 'dash', 'eval', 'exec', 'awk', 'gawk']);
// Destructive words that make code passed to an interpreter risk 3.
const DESTRUCTIVE_TEXT = /\b(rm|rmdir|unlink|rmtree|remove|dd|mkfs|shred|reboot|shutdown|poweroff|halt|kill|killall|pkill|destroy|delete|drop|truncate|wipefs|format|chmod|chown|sudo)\b|>/i;

// Programs that only look at things. Options that change things are checked in readOnlyTokens().
const READ_ONLY_PROGRAMS = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'wc', 'df', 'du', 'free', 'uptime', 'uname', 'date', 'hostname', 'whoami', 'id', 'ps', 'pwd', 'stat', 'file', 'which', 'pveversion', 'ss', 'dig', 'nslookup', 'journalctl', 'lsblk', 'lscpu', 'sensors', 'sort', 'uniq', 'cut', 'tr', 'find', 'echo', 'printf', 'true', 'false', 'cd', 'sleep', 'test', '[', 'basename', 'dirname', 'realpath', 'readlink', 'printenv', 'type', 'history', 'clear']);
// Tools whose read-only use is only some of their subcommands.
const READ_ONLY_SUBCOMMANDS = {
  docker: ['ps', 'logs', 'inspect', 'images', 'stats', 'version', 'info', 'top', 'port'],
  systemctl: ['status', 'is-active', 'is-enabled', 'list-units', 'list-unit-files', 'show', 'cat'],
  pct: ['list', 'status', 'config'], qm: ['list', 'status', 'config'],
  apt: ['list', 'show', 'policy'], 'apt-get': ['changelog'],
  zfs: ['list', 'get', 'status'], zpool: ['list', 'status', 'get'],
  git: ['status', 'log', 'diff', 'show', 'branch'],
  ip: ['addr', 'address', 'link', 'route', 'neigh', 'rule', 'a', 'l', 'r', 'n'],
  curl: [], wget: [], ss: [],
};
const IP_CHANGE_WORDS = ['add', 'del', 'delete', 'set', 'change', 'replace', 'flush', 'append', 'sync', 'up', 'down'];
const GIT_BRANCH_READ_OPTIONS = ['-a', '-r', '-v', '-vv', '--all', '--remotes', '--verbose', '--list', '-l', '--show-current'];
const CURL_LONG_WRITE = /^--(request|data|form|upload-file|output|remote-name|remote-header-name|json|user|continue-at|create-dirs|output-dir)/;

// Every program the classifier knows about (used to tell "unrecognised" from "known and harmless").
const TOOLS = new Set([...Object.keys(READ_ONLY_SUBCOMMANDS), ...READ_ONLY_PROGRAMS, 'curl', 'wget', 'ip', 'git', 'ss']);
const base = (word) => String(word).split('/').pop();
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Does this curl argument send or write data?
function curlWriteArg(arg) {
  if (arg.startsWith('--')) return CURL_LONG_WRITE.test(arg);
  if (arg.startsWith('-') && arg.length > 1) return /[XdFTouOJCu]/.test(arg.slice(1));   // short options, also when combined (-sO, -sd, -XPOST)
  return false;
}

// Is this program with these arguments read-only? Call only for known programs.
function readOnlyTokens(prog, args) {
  const sub = args.find((a) => !a.startsWith('-')) || '';
  if (prog === 'curl') return !args.some(curlWriteArg);
  if (prog === 'wget') return false;
  if (prog === 'date') return !args.some((a) => /^(-s|--set)/.test(a)) && args.every((a) => a.startsWith('+') || a.startsWith('-'));
  if (prog === 'hostname') return args.every((a) => a.startsWith('-') && !/^(-F|--file|-b|--boot)/.test(a));
  if (prog === 'journalctl') return !args.some((a) => /^--(vacuum|rotate|flush|setup-keys|update-catalog)/.test(a));
  if (prog === 'ss') return !args.some((a) => a === '--kill' || (/^-[a-zA-Z]+$/.test(a) && a.includes('K')));
  if (prog === 'sort') return !args.some((a) => /^-o|^--output/.test(a));
  if (prog === 'git') {
    if (sub === 'branch') { const rest = args.slice(args.indexOf('branch') + 1); return rest.every((a) => GIT_BRANCH_READ_OPTIONS.includes(a)); }
    if (['log', 'diff', 'show'].includes(sub)) return !args.some((a) => a.startsWith('--output'));
    return ['status'].includes(sub);
  }
  if (prog === 'ip') {
    const at = args.findIndex((a) => READ_ONLY_SUBCOMMANDS.ip.includes(a));
    if (at < 0) return false;
    return !args.some((a) => IP_CHANGE_WORDS.includes(a));
  }
  if (READ_ONLY_SUBCOMMANDS[prog]) return READ_ONLY_SUBCOMMANDS[prog].includes(sub);
  return READ_ONLY_PROGRAMS.has(prog);
}

// Strip leading VAR=value assignments and wrapper programs. Returns the command they run, and what was removed.
function unwrap(tokens) {
  let t = tokens.slice();
  const wrappers = [];
  let floor = 0;
  while (t.length) {
    if (ASSIGN.test(t[0])) { t.shift(); continue; }
    const name = base(t[0]);
    if (!WRAPPERS.has(name)) break;
    wrappers.push(name);
    if (PRIVILEGE.has(name)) floor = 2;
    t.shift();
    // Skip the wrapper's own options and the values it takes (a duration, a niceness, a count).
    while (t.length && (t[0].startsWith('-') || ASSIGN.test(t[0]) || /^[\d.]+[smhd]?$/.test(t[0]))) {
      const takesValue = ['-n', '-I', '-P', '-L', '-d', '-s', '-a', '-u', '-g'].includes(t[0]);
      t.shift();
      if (takesValue && t.length) t.shift();
    }
  }
  return { tokens: t, wrappers, floor };
}

// The destructive words that appear in code passed to an interpreter, or in the arguments of xargs.
function destructiveIn(words) {
  return DESTRUCTIVE_TEXT.test(words.join(' '));
}

// Risk of one simple command (no chaining), with its wrappers already removed.
function tokenRisk(tokens) {
  if (!tokens.length) return 0;
  const prog = base(tokens[0]), args = tokens.slice(1);
  const sub = args.find((a) => !a.startsWith('-')) || '';
  const pathLike = tokens[0].includes('/') || tokens[0].startsWith('.') || tokens[0].startsWith('~');
  if (DESTRUCTIVE_PROGRAMS.has(prog)) return 3;
  // apiary-ssh runs its command on another machine. Only a known read-only command is harmless; anything else is judged by the same rules, and unknown is risk 3.
  if (prog === 'apiary-ssh') {
    const at = args.indexOf('--');
    if (at < 0 || at === args.length - 1) return 3;            // an interactive shell on the remote machine
    const remote = args.slice(at + 1).join(' ');
    if (isReadOnly(remote)) return 0;
    const r = riskOf(remote);
    return r >= 2 ? r : 3;
  }
  if ((DESTRUCTIVE_SUBCOMMANDS[prog] || []).some((d) => d === sub || args.includes(d))) return 3;
  if (prog === 'find' && args.some((a) => ['-delete', '-exec', '-execdir', '-ok'].includes(a))) return 3;
  if (prog === 'eval') return destructiveIn(args) ? 3 : 2;   // eval runs whatever it is given
  if (INTERPRETERS.has(prog)) {
    const code = args.findIndex((a) => /^-[a-zA-Z]*[ce]$/.test(a));
    if (code >= 0) return destructiveIn(args.slice(code + 1)) ? 3 : 2;
    return 2;                                                   // a script file, or code from standard input
  }
  if (CHANGE_PROGRAMS.has(prog)) return 2;
  if ((CHANGE_SUBCOMMANDS[prog] || []).some((d) => d === sub || args.includes(d))) return 2;
  if (TOOLS.has(prog)) return readOnlyTokens(prog, args) ? 0 : 2;
  if (pathLike) return 2;                                       // a script or program run by its path
  return 1;                                                     // unrecognised: asked at slider 2, run from slider 3
}

// Risk of any shell command, from the least to the most serious:
// 0 = simple, read or harmless; 1 = chained, or a program we do not recognise; 2 = changes something, or runs a script, interpreter or build tool; 3 = destroys, deletes or reboots.
export function riskOf(command) {
  const cmd = String(command ?? '');
  if (!cmd.trim()) return 3;
  let risk = 0;
  if (/[<>`]|\$/.test(cmd)) risk = 2;                          // redirects, writes, substitutions and variables
  const parts = cmd.split(SEPARATORS).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1) risk = Math.max(risk, 1);              // chained or backgrounded commands
  for (const part of parts) {
    const tokens = part.split(/\s+/).filter(Boolean);
    const { tokens: inner, wrappers, floor } = unwrap(tokens);
    risk = Math.max(risk, floor);
    if (!inner.length) continue;
    if (wrappers.includes('xargs') && inner.some((w) => DESTRUCTIVE_PROGRAMS.has(base(w)))) { risk = 3; continue; }
    risk = Math.max(risk, tokenRisk(inner));
  }
  return risk;
}

// The command split into program and arguments, or null for anything chained, redirected, substituted or wrapped.
export function parseCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd || COMPOUND.test(cmd)) return null;
  const tokens = cmd.split(/\s+/);
  const { tokens: inner, wrappers } = unwrap(tokens);
  if (!inner.length || wrappers.length) return null;
  return { program: base(inner[0]), args: inner.slice(1), text: cmd, tokens: inner };
}

export const isCompound = (command) => !parseCommand(command);

// Always asked, regardless of a narrower rule: anything at risk 2 or above.
export function isDangerous(command) {
  return riskOf(command) >= 2;
}

// True for commands that only read: one plain command that is known and harmless.
export function isReadOnly(command) {
  const p = parseCommand(command);
  if (!p) return false;
  return riskOf(command) === 0 && readOnlyTokens(p.program, p.args);
}

// Does a command rule cover this command? scope: 'exact' (the same command text), 'program' (any use of one program, not risky), 'readonly' (read-only commands).
export function commandRuleCovers(rule, command) {
  const p = parseCommand(command);
  if (!p) return false;
  if (rule.scope === 'exact') return p.text === String(rule.command || '').trim();
  if (rule.scope === 'program') return p.program === rule.command && riskOf(command) <= 1;
  if (rule.scope === 'readonly') return isReadOnly(command);
  return false;
}

export const COMMAND_SCOPES = { exact: 'this exact command', program: 'any command that runs this program', readonly: 'read-only commands (status, lists, logs, GET-only web requests)' };

// ---------- trust levels (the slider on the Access and safety page) ----------
// The six positions of the slider. Index 0 asks for every command; index 5 runs everything.
// Keep these texts in step with TRUST_LABELS in public/app.js.
export const TRUST_LEVELS = [
  'Ask me for every command',
  'Read-only commands run; everything else asks',
  'Simple commands run; chains, scripts and changes ask',
  'Chains run too; scripts, changes and destructive commands ask',
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
