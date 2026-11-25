// Apiary web UI: vanilla JS, no build step. All text is inserted with textContent (never innerHTML),
// so agent output can never inject markup.
const S = { agents: [], providers: [], limits: {}, defs: [], approvals: [], approvalsDefault: true, onboardingDone: true, defaultProvider: '', conns: null, msgs: {}, logs: {}, stream: {}, activity: {}, sel: null, tab: 'chat', open: {}, version: '' };
const $ = (s) => document.querySelector(s);
const view = $('#view');
let page = null; // { update?() } for the current route

const ICON = {
  shield: 'M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z M9 12l2 2 4-4',
  infra: 'M2 4h20v6H2z M2 14h20v6H2z M6 7h.01 M6 17h.01',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  agents: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  sliders: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M12 1v2 M12 21v2 M4.22 4.22l1.42 1.42 M18.36 18.36l1.42 1.42 M1 12h2 M21 12h2 M4.22 19.78l1.42-1.42 M18.36 5.64l1.42-1.42',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  plus: 'M12 5v14 M5 12h14', chev: 'M6 9l6 6 6-6',
};
// replaceChildren would print "null" for empty slots (conditional pieces); drop them instead.
const _replaceChildren = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...kids) { return _replaceChildren.apply(this, kids.flat().filter((k) => k != null && k !== false)); };
const NS = 'http://www.w3.org/2000/svg';
function svg(d, size = 20, sw = 1.8) {
  const s = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
  const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p);
  return s;
}
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}
let toastT;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = 'toast'), err ? 6000 : 2500);
}
async function api(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && j.error === 'Sign in required') { location.replace('/login'); throw new Error('Signed out. Opening the sign-in page…'); }
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
// A secret is never typed into the browser's plain prompt (it shows the text). This dialog hides it.
// For a private key you can choose the key file instead of pasting it, so it is never displayed at all.
const askSecret = (title, label, { key = false } = {}) => new Promise((resolve) => {
  const inp = key ? h('textarea', { rows: '5', class: 'masked', spellcheck: 'false', autocomplete: 'off', 'aria-label': label }) : h('input', { type: 'password', autocomplete: 'new-password', spellcheck: 'false', 'aria-label': label });
  const file = key ? h('input', { type: 'file', 'aria-label': 'Choose the private key file', onchange: async (e) => { const f = e.target.files[0]; if (f) inp.value = await f.text(); } }) : null;
  const show = h('input', { type: 'checkbox', onchange: () => { if (key) inp.classList.toggle('masked', !show.checked); else inp.type = show.checked ? 'text' : 'password'; } });
  const ok = h('button', { class: 'btn primary', type: 'submit', value: 'ok' }, 'Save');
  const dlg = h('dialog', {}, h('form', { method: 'dialog' }, h('h2', {}, title), key ? h('label', { class: 'f' }, 'Choose the key file (best)', file) : null, h('label', { class: 'f' }, key ? 'or paste the key' : label, inp), h('label', { class: 'check' }, show, ' Show what I type'), h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'submit', value: 'cancel' }, 'Cancel'), ok)));
  dlg.addEventListener('close', () => { const v = dlg.returnValue === 'ok' ? inp.value : null; inp.value = ''; dlg.remove(); resolve(v || null); });
  document.body.append(dlg); dlg.showModal(); (key ? file : inp).focus();
});
const copy = (text) => navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Copy failed', true));
const cmdBox = (text) => h('div', { class: 'cmd mono' }, h('code', {}, text), h('button', { type: 'button', onclick: () => copy(text) }, 'Copy'));
const ago = (ts) => { const s = (Date.now() - ts) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`; };
const STATUS = { idle: ['ok', 'Idle'], working: ['work', 'Working'], waiting: ['info', 'Waiting for team'], error: ['err', 'Error'] };
const STAGES = { building: ['Building', 'Being made for the first time', 'work'], maintenance: ['Maintenance', 'Finished. Fixes, security updates and small changes', 'ok'], closed: ['Closed', 'Finished for good. Kept, but not worked on', ''] };
const stageOf = (a) => a.stage || 'building';
const stagePill = (a) => h('span', { class: 'pill ' + STAGES[stageOf(a)][2], title: STAGES[stageOf(a)][1] }, STAGES[stageOf(a)][0]);
const pill = (status) => { const [c, t] = STATUS[status] || ['', status]; return h('span', { class: 'pill ' + c }, t); };
const PNAME = { claude: 'Claude', codex: 'Codex', mock: 'Mock' };
const pending = () => S.approvals.filter((a) => a.status === 'pending');
const pendingCount = () => pending().length;
function updateBadge() { document.title = pendingCount() ? `(${pendingCount()}) Apiary` : 'Apiary'; }
const leads = () => S.agents.filter((a) => !a.parentId && !a.kind).sort((a, b) => b.createdAt - a.createdAt);
const kidsOf = (id) => S.agents.filter((a) => a.parentId === id).sort((a, b) => a.createdAt - b.createdAt);
const rootOf = (a) => { while (a.parentId) a = S.agents.find((x) => x.id === a.parentId) || { id: null }; return a; };

// ---------- theme ----------
function applyTheme(t) {
  document.documentElement.className = t;
  try { localStorage.setItem('apiary-theme', t); } catch { /* private mode */ }
  const b = $('#theme'); b.replaceChildren(svg(t === 'dark' ? ICON.sun : ICON.moon));
  const label = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  b.setAttribute('aria-label', label); b.title = label;
}
// Over plain http from another device, the access link, API keys and the vault passphrase travel unencrypted.
if (location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  const live = document.querySelector('.live');
  if (live) { live.replaceChildren(h('span', { class: 'dot warn' }), 'Not encrypted. Use only on a network you trust.'); live.title = 'You are connected over plain http. Use an SSH tunnel, Tailscale or an https reverse proxy for anything you do not fully trust.'; }
}
$('#theme').onclick = () => applyTheme(document.documentElement.className === 'dark' ? 'light' : 'dark');
$('#menu').onclick = () => $('#side').classList.toggle('open');
applyTheme(document.documentElement.className || 'dark');

// ---------- sidebar ----------
const DOCS_URL = 'https://aber-28.gitbook.io/aber-28-docs/';
// A menu entry is [href, label] or { id, label, items: [...] } (a folder; folders can hold folders).
const NAV = [
  { id: 'workspace', label: 'Workspace', icon: ICON.chat, items: [['#/chat', 'Chat'], ['#/activity', 'Live activity'], ['#/projects', 'Projects'], ['#/tasks', 'Tasks'], ['#/approvals', 'Approvals'], ['#/tickets', 'Support tickets'], ['#/terminal', 'Terminal sessions'],
    { id: 'reuse', label: 'Plan and reuse', items: [['#/project-templates', 'Project templates'], ['#/runbooks', 'Runbooks'], ['#/reports', 'Weekly report']] }] },
  { id: 'agents', label: 'Agents', icon: ICON.agents, items: [['#/agents', 'All agents'], ['#/organisation', 'Organisation'], ['#/meetings', 'Team meetings'],
    { id: 'library', label: 'Library', items: [['#/teams', 'Teams'], ['#/templates', 'Saved agents'], ['#/rules', 'Delegation rules']] },
    { id: 'knowledge', label: 'Knowledge', items: [['#/memory', 'Memory'], ['#/repositories', 'Repositories']] }] },
  { id: 'infra', label: 'Infrastructure', icon: ICON.infra, items: [['#/infrastructure', 'Devices'], ['#/infrastructure/map', 'Map'], ['#/health', 'Health']] },
  { id: 'connections', label: 'Connections', icon: ICON.link, items: [['#/connections', 'Overview'], ['#/usage', 'Usage'], { id: 'ai', label: 'AI tools', items: [['#/connections/claude', 'Claude Code'], ['#/connections/codex', 'Codex']] }, ['#/connections/github', 'GitHub']] },
  { id: 'security', label: 'Security', icon: ICON.shield || ICON.sliders, items: [['#/signin', 'Sign-in'], ['#/secrets', 'Secrets vault'], ['#/policy', 'Approval rules'], ['#/access', 'Access and safety'], ['#/audit', 'Audit log']] },
  { id: 'settings', label: 'Settings', icon: ICON.sliders, items: [['#/appearance', 'Appearance'], ['#/telegram', 'Telegram alerts'],
    { id: 'data', label: 'Data', items: [['#/backups', 'Backups'], ['#/transfer', 'Export and import'], ['#/reset', 'Factory reset']] },
    { id: 'system', label: 'System', items: [['#/updates', 'Updates'], ['#/startup', 'Startup'], ['#/folders', 'Folders']] }, ['#/setup', 'Setup guide']] },
];
const navLeaves = (items) => items.flatMap((it) => (Array.isArray(it) ? [it] : navLeaves(it.items)));
const cur = () => location.hash.replace(/\?.*$/, '') || '#/chat';
const isActive = (href) => cur() === href || (href === '#/projects' && cur().startsWith('#/project/'));
function renderSide() {
  const side = $('#side');
  const newBtn = h('button', { class: 'btn primary big', onclick: () => openNewProject() }, svg(ICON.plus, 16, 2.2), 'New project');
  const badgeFor = (href) => {
    if (href === '#/approvals' && pendingCount()) return { n: pendingCount(), label: 'waiting' };
    if (href === '#/runbooks' && S.runbookDrafts) return { n: S.runbookDrafts, label: 'to review' };
    if (href === '#/health' && S.health?.count) return { n: S.health.count, label: 'warnings', err: S.health.level === 'err' };
    return null;
  };
  const sumBadge = (items) => { const bs = navLeaves(items).map(([href]) => badgeFor(href)).filter(Boolean); return bs.length ? { n: bs.reduce((x, b) => x + b.n, 0), label: 'need attention', err: bs.some((b) => b.err) } : null; };
  const badgeEl = (b) => (b ? h('span', { class: 'badge', style: b.err ? 'background:var(--err)' : '', 'aria-label': `${b.n} ${b.label}` }, b.n) : null);
  S.navOpen ||= {};
  const draw = (items, depth) => items.map((it) => {
    if (Array.isArray(it)) { const [href, label] = it; return h('a', { class: 'nav-item', href, 'aria-current': isActive(href) ? 'page' : null, onclick: () => $('#side').classList.remove('open') }, h('span', { style: 'flex:1' }, label), badgeEl(badgeFor(href))); }
    const has = navLeaves(it.items).some(([href]) => isActive(href)), open = S.navOpen[it.id] === undefined ? has : S.navOpen[it.id];
    return h('div', { class: `nav-group nested${has ? ' has-active' : ''}${open ? '' : ' closed'}` },
      h('button', { 'aria-expanded': String(open), onclick: () => { S.navOpen[it.id] = !open; renderSide(); } }, h('span', { style: 'flex:1' }, it.label), open ? null : badgeEl(sumBadge(it.items)), h('span', { class: 'chev' }, svg(ICON.chev, 14, 2))),
      h('div', { class: 'sub' }, draw(it.items, depth + 1)));
  });
  const groups = NAV.map((g) => {
    const has = navLeaves(g.items).some(([href]) => isActive(href));
    const open = S.openGroup === undefined ? has : S.openGroup === g.id;
    return h('div', { class: `nav-group${has ? ' has-active' : ''}${open ? '' : ' closed'}` },
      h('button', { 'aria-expanded': String(open), onclick: () => { S.openGroup = open ? null : g.id; renderSide(); } }, svg(g.icon), h('span', { style: 'flex:1' }, g.label), open ? null : badgeEl(sumBadge(g.items)), h('span', { class: 'chev' }, svg(ICON.chev, 16, 2))),
      h('div', { class: 'sub' }, draw(g.items, 1)));
  });
  const conn = (S.conns || []).map((c) => {
    const ok = c.id === 'github' ? c.status?.ok : c.ready;
    const way = c.method === 'cli' ? 'Terminal' : c.method === 'api' ? 'Web · API' : 'Web · token';
    return h('div', { class: 'conn-row' }, h('span', { class: 'dot ' + (ok ? 'ok' : 'err') }), h('span', {}, c.id === 'claude' ? 'Claude Code' : c.id === 'codex' ? 'Codex' : 'GitHub'), h('small', {}, ok ? way : 'Not connected'), c.id !== 'github' && ok ? usageLine(c.id) : null);
  });
  side.replaceChildren(
    h('div', { class: 'brand' }, (() => { const s = svg('M12 2.5l8 4.6v9.8l-8 4.6-8-4.6V7.1z', 28); s.style.color = 'var(--accent)'; return s; })(), 'Apiary'),
    newBtn, S.onboardingDone && S.account && !S.account.exists ? h('a', { href: '#/signin', class: 'signin-nag', role: 'alert' }, 'No sign-in yet. Anyone who can reach this page can use it. Create one now') : null, h('nav', { 'aria-label': 'Main', style: 'display:flex;flex-direction:column;gap:6px' }, groups),
    h('a', { class: 'nav-item doclink', href: DOCS_URL, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Documentation (opens in a new tab)' }, h('span', { style: 'flex:1' }, 'Documentation'), h('span', { 'aria-hidden': 'true' }, '↗')),
    workingBox(), h('div', { class: 'conn-box' }, h('h4', {}, 'Connections'), conn.length ? conn : h('small', { class: 'hint' }, 'Checking…')));
}
function navPath(items, label, trail = []) {
  for (const it of items) {
    if (Array.isArray(it)) { if (it[1] === label) return [...trail, it[1]]; }
    else { const r = navPath(it.items, label, [...trail, it.label]); if (r) return r; }
  }
  return null;
}
function crumbs(...parts) {
  const last = parts[parts.length - 1];
  if (parts.length === 2) for (const g of NAV) { const r = navPath(g.items, last, [g.label]); if (r) { parts = r; break; } }   // the trail follows the menu
  $('#crumbs').replaceChildren(...parts.flatMap((p, i) => [i ? h('span', {}, '/') : null, i === parts.length - 1 ? h('b', {}, p) : h('span', {}, p)]).filter(Boolean));
}

// ---------- routing ----------
const ROUTES = [
  [/^#\/chat$/, () => pageChat()],
  [/^#\/task\/([\w-]+)$/, (m) => pageTask(m[1])],
  [/^#\/organisation$/, () => { S.nextTab = 'org'; pageChat(); }],
  [/^#\/meetings$/, () => pageMeetings()],
  [/^#\/tasks$/, () => pageTasks()],
  [/^#\/tickets$/, () => pageTickets()],
  [/^#\/repositories$/, () => pageRepos()],
  [/^#\/usage$/, () => pageUsage()],
  [/^#\/secrets$/, () => pageSecrets()],
  [/^#\/infrastructure$/, () => pageInfra('devices')],
  [/^#\/infrastructure\/map$/, () => pageInfra('map')],
  [/^#\/signin$/, () => pageSignin()],
  [/^#\/backups$/, () => pageBackups()],
  [/^#\/audit$/, () => pageAudit()],
  [/^#\/health$/, () => pageHealth()],
  [/^#\/runbooks$/, () => pageRunbooks()],
  [/^#\/policy$/, () => pagePolicy()],
  [/^#\/reports$/, () => pageReports()],
  [/^#\/project-templates$/, () => pageProjectTemplates()],
  [/^#\/telegram$/, () => pageTelegram()],
  [/^#\/reset$/, () => pageReset()],
  [/^#\/updates$/, () => pageUpdates()],
  [/^#\/transfer$/, () => pageTransfer()],
  [/^#\/teams$/, () => pageTeams()],
  [/^#\/memory$/, () => pageMemory()],
  [/^#\/activity$/, () => pageActivity()],
  [/^#\/projects$/, () => pageProjects()],
  [/^#\/project\/([\w-]+)$/, (m) => pageProject(m[1])],
  [/^#\/approvals$/, () => pageApprovals()],
  [/^#\/terminal$/, () => pageTerminals()],
  [/^#\/agents$/, () => pageAgents()],
  [/^#\/templates$/, () => pageTemplates()],
  [/^#\/rules$/, () => pageRules()],
  [/^#\/connections$/, () => pageConnections()],
  [/^#\/connections\/(claude|codex|github)$/, (m) => pageConnection(m[1])],
  [/^#\/appearance$/, () => pageAppearance()],
  [/^#\/startup$/, () => pageStartup()],
  [/^#\/setup$/, () => { pageProjects(); openSetup(); }],
  [/^#\/access$/, () => pageAccess()],
  [/^#\/folders$/, () => pageFolders()],
];
function route() {
  const hash = cur();
  view.className = 'view'; page = null;
  const r = ROUTES.find(([re]) => re.test(hash));
  if (!r) { location.hash = '#/chat'; return; }
  S.openGroup = NAV.find((g) => navLeaves(g.items).some(([href]) => isActive(href)))?.id ?? S.openGroup; // only one submenu stays open
  renderSide();
  r[1](r[0].exec(hash));
}
addEventListener('hashchange', route);

// ---------- live updates ----------
function refreshConns() { return api('/api/connections').then((c) => { S.conns = c; renderSide(); }).catch(() => {}); }
async function loadState() {
  const st = await api('/api/state');
  Object.assign(S, { agents: st.agents, providers: st.providers, limits: st.limits, defs: st.defs, teams: st.teams || [], memory: st.memory || { enabled: true, count: 0 }, approvals: st.approvals || [], approvalsDefault: st.approvalsDefault !== false, onboardingDone: st.onboardingDone !== false, orgDone: !!st.orgDone, account: st.account || { exists: false }, defaultProvider: st.defaultProvider || '', version: st.version, meeting: st.meeting || { frequency: 'off' }, autoUpdate: st.autoUpdate !== false, updateCheck: st.updateCheck || 'daily', vault: st.vault || { exists: false, unlocked: false }, update: st.update || null, plainEnglish: st.plainEnglish !== false });
  S.health = st.health; S.runbookDrafts = st.runbookDrafts || 0; renderUpdateChip(); renderSignOut();
  updateBadge();
}
function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'agent') {
      const i = S.agents.findIndex((a) => a.id === ev.agent.id);
      if (i >= 0) S.agents[i] = ev.agent; else S.agents.push(ev.agent);
      if (ev.agent.status !== 'working') delete S.stream[ev.agent.id];
    } else if (ev.type === 'removed') {
      S.agents = S.agents.filter((a) => a.id !== ev.id);
      if (S.sel === ev.id) S.sel = null;
    } else if (ev.type === 'message') {
      (S.msgs[ev.agentId] ||= []).push(ev.message);
      if (ev.message.role === 'agent') delete S.stream[ev.agentId];
    } else if (ev.type === 'approval') {
      const i = S.approvals.findIndex((a) => a.id === ev.approval.id);
      if (i >= 0) S.approvals[i] = ev.approval; else S.approvals.unshift(ev.approval);
      updateBadge(); renderSide();
      if (ev.approval.status === 'pending' && document.hidden) try { new Notification('Apiary needs your approval', { body: ev.approval.title }); } catch { /* not allowed */ }
    } else if (ev.type === 'delta') S.stream[ev.agentId] = (S.stream[ev.agentId] || '') + ev.text;
    else if (ev.type === 'runbook') { S.runbookDrafts = ev.drafts; renderSide(); }
    else if (ev.type === 'health') { S.health = { level: ev.level, count: ev.count }; renderSide(); }
    else if (ev.type === 'activity') S.activity[ev.agentId] = ev.text;
    else if (ev.type === 'log') { (S.logs[ev.agentId] ||= []).push(ev.line); }
    if (['agent', 'removed'].includes(ev.type)) renderSide(); else if (ev.type === 'activity') updateWorking();
    if (ev.type === 'approval') toastIfPending(ev.approval);
    page?.update?.(ev);
  };
}

function toastIfPending(a) { if (a.status === 'pending' && !(page && page.shows?.(a))) toast(`Needs your approval: ${a.title}`); }

// ---------- approvals ----------
function diffView(d) {
  const pre = h('pre', { class: 'diff mono', tabindex: '0' });
  for (const line of (d.patch || '').split('\n')) pre.append(h('span', { class: line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : line.startsWith('diff ') ? 'file' : '' }, line), '\n');
  return h('div', {}, d.stat ? h('pre', { class: 'diffstat mono' }, d.stat) : h('p', { class: 'hint' }, 'No changes.'),
    d.patch ? h('details', {}, h('summary', {}, 'Show the full changes'), pre, d.truncated ? h('p', { class: 'hint' }, 'Only the first part is shown. Review the rest on the branch.') : null) : null);
}
// An agent asked to save a secret it made. The value is typed here and goes straight to the vault; it is not kept on the request.
function newSecretForm(ap, decide) {
  const nm = h('input', { type: 'text', value: ap.secretName || '', maxlength: '80', 'aria-label': 'Secret name' });
  const ty = h('select', { 'aria-label': 'Kind of secret' }, [['login', 'Login (username and password)'], ['token', 'Token or API key'], ['ssh', 'SSH login (server, username, password or key)']].map(([k, t]) => h('option', { value: k, selected: (ap.secretType || 'login') === k }, t)));
  const us = h('input', { type: 'text', value: ap.username || '', placeholder: 'Username (if any)', 'aria-label': 'Username' });
  const ho = h('input', { type: 'text', value: ap.host || '', placeholder: 'Server (SSH logins only)', 'aria-label': 'Server' });
  const po = h('input', { type: 'text', value: '22', inputmode: 'numeric', 'aria-label': 'Port (SSH logins only)' });
  const va = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Password, token or private key', 'aria-label': 'Secret value' });
  const save = guard(async () => {
    if (!va.value) throw new Error('Type the secret value first');
    await api(`/api/approvals/${ap.id}/decide`, 'POST', { decision: 'approve', secret: { name: nm.value, type: ty.value, username: us.value, host: ho.value, port: po.value, value: va.value } });
    va.value = ''; toast(`Saved "${nm.value}" to the vault`);
  });
  return h('div', { class: 'kv', style: 'margin-top:12px;flex-wrap:wrap;gap:8px;align-items:stretch' },
    h('div', { style: 'width:100%;display:grid;gap:6px' }, nm, ty, us, ho, po, va),
    h('button', { class: 'btn primary', onclick: save }, 'Save to the vault'),
    h('button', { class: 'btn danger', onclick: decide('deny') }, 'Deny'));
}
function approvalCard(ap) {
  const isPending = ap.status === 'pending';
  const note = h('input', { type: 'text', placeholder: 'Optional note to the agent', 'aria-label': 'Note to the agent' });
  const checks = (ap.items || []).map((it, i) => h('input', { type: 'checkbox', checked: true, 'aria-label': `${ap.kind === 'hire' ? 'Hire' : 'Create'} ${it.name}`, 'data-i': i }));
  const nameIn = (ap.kind === 'hire' ? ap.items : []).map((it) => h('input', { type: 'text', value: it.name, 'aria-label': `Name for the ${it.title || it.role}` }));
  const modelIn = (ap.kind === 'hire' ? ap.items : []).map((it) => it.suggestedModel ? h('select', { 'aria-label': `AI model for ${it.title || it.name}` }, h('option', { value: it.suggestedModel }, `Suggested: ${it.suggestedModel}`), h('option', { value: '' }, 'Default model'), (it.modelOptions || []).filter((m) => m !== it.suggestedModel).map((m) => h('option', { value: m }, m))) : null);
  const decide = (decision, mode) => guard(async () => {
    const body = { decision, note: note.value };
    if (mode) body.mode = mode;
    if (decision === 'approve' && modelIn.some(Boolean)) { body.models = {}; modelIn.forEach((m, i) => { if (m) body.models[i] = m.value; }); }
    if (decision === 'approve' && nameIn.length) { const names = {}; nameIn.forEach((n, i) => { if (n.value.trim() && n.value.trim() !== ap.items[i].name) names[i] = n.value.trim(); }); if (Object.keys(names).length) body.names = names; }
    if (decision === 'approve' && checks.length) { const only = checks.filter((c) => c.checked).map((c) => Number(c.dataset.i)); if (!only.length) { toast('Select at least one, or choose Deny', true); return; } if (only.length < checks.length) body.only = only; }
    await api(`/api/approvals/${ap.id}/decide`, 'POST', body);
  });
  const label = { approved: ['ok', 'Approved'], denied: ['err', 'Denied'], cancelled: ['', 'Cancelled'], expired: ['', 'Expired'], pending: ['work', 'Waiting for you'] }[ap.status];
  return h('section', { class: 'approval' + (isPending ? ' pending' : ''), 'aria-label': ap.title },
    h('div', { class: 'kv', style: 'justify-content:space-between;align-items:flex-start' }, h('b', {}, ap.title), h('span', { class: 'pill ' + label[0] }, label[1])),
    ap.detail ? h('p', { class: 'hint', style: 'margin:4px 0 8px' }, ap.detail) : null,
    ap.kind === 'plan' ? h('ol', { class: 'plan-list' }, (ap.phases || []).map((p) => h('li', {}, h('b', {}, p.title), p.goal ? ` — ${p.goal}` : '', p.steps?.length ? h('ul', {}, p.steps.map((t) => h('li', {}, t))) : null))) :
    ap.kind === 'hire' ? h('div', { class: 'items' }, ap.items.map((it, i) => h('label', { class: 'item' }, isPending ? checks[i] : null, h('span', { style: 'flex:1' }, isPending ? nameIn[i] : h('b', {}, it.name), ` · ${it.title ? it.title + ' · ' : ''}${it.departmentLabel}${it.role ? ' · ' + it.role : ''}`, h('span', { class: 'task' }, `Why: ${it.reason || 'not given'}`), it.modelWhy ? h('span', { class: 'task' }, `Model: ${it.modelWhy}`) : null, isPending && modelIn[i] ? modelIn[i] : null, h('small', { class: 'hint', style: 'display:block' }, `Reports to ${it.reportsTo} · ${PNAME[it.provider] || it.provider}`), h('details', {}, h('summary', {}, 'Profile and guardrails (written for you)'), h('pre', { class: 'diffstat mono', style: 'white-space:pre-wrap' }, it.instructions)))))) :
    ap.items ? h('div', { class: 'items' }, ap.items.map((it, i) => h('label', { class: 'item' }, isPending ? checks[i] : null, h('span', {}, h('b', {}, it.name), ` · ${PNAME[it.provider] || it.provider}`, it.role ? ` · ${it.role}` : '', h('span', { class: 'task' }, it.task))))) : null,
    ap.diff ? diffView(ap.diff) : null,
    isPending && ap.kind === 'newsecret' ? newSecretForm(ap, decide)
    : isPending && ap.kind === 'command' ? h('div', { class: 'kv', style: 'margin-top:12px;flex-wrap:wrap' }, note,
      h('button', { class: 'btn primary', onclick: decide('approve', 'once') }, 'Allow once'),
      ap.canExact ? h('button', { class: 'btn', onclick: decide('approve', 'exact') }, 'Always allow this exact command') : null,
      ap.program ? h('button', { class: 'btn', onclick: decide('approve', 'program') }, `Always allow "${ap.program}" commands`) : null,
      h('button', { class: 'btn', onclick: decide('approve', 'readonly') }, 'Always allow read-only commands'),
      h('button', { class: 'btn', onclick: () => { if (confirm('Allow every command this agent runs, including ones that delete or change things? You can take this back on Approval rules.')) decide('approve', 'agent')(); } }, 'Allow everything for this agent'),
      h('button', { class: 'btn danger', onclick: decide('deny') }, 'Deny'))
    : isPending && ap.kind === 'secret' ? h('div', { class: 'kv', style: 'margin-top:12px' }, note, h('button', { class: 'btn primary', onclick: decide('approve', 'once') }, 'Allow once'), h('button', { class: 'btn', onclick: decide('approve', 'always') }, 'Allow always'), h('button', { class: 'btn danger', onclick: decide('deny') }, 'Deny'))
    : isPending ? h('div', { class: 'kv', style: 'margin-top:12px' }, note, h('button', { class: 'btn primary', onclick: decide('approve') }, ap.kind === 'merge' ? 'Approve merge' : ap.kind === 'plan' ? 'Approve plan' : ap.kind === 'hire' ? 'Approve hiring' : 'Approve'), h('button', { class: 'btn danger', onclick: decide('deny') }, 'Deny'))
      : ap.note ? h('p', { class: 'hint', style: 'margin-top:8px' }, `Your note: ${ap.note}`) : null);
}
function pageApprovals() {
  crumbs('Workspace', 'Approvals');
  const draw = () => {
    const p = pending(), done = S.approvals.filter((a) => a.status !== 'pending' && !a.archived), old = S.approvals.filter((a) => a.status !== 'pending' && a.archived);
    view.replaceChildren(h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Approvals'), h('p', { class: 'sub-title' }, 'Agents ask you before they create sub-agents or merge their work. Nothing is pushed to GitHub until you open a pull request.'))),
      p.length ? p.map(approvalCard) : h('div', { class: 'card empty' }, 'Nothing is waiting for you.'),
      done.length ? h('h2', { style: 'margin-top:28px' }, 'Earlier decisions') : null, ...done.slice(0, 30).map(approvalCard),
      old.length ? h('details', { style: 'margin-top:28px' }, h('summary', {}, h('b', {}, `Archived decisions (${old.length})`), ' · decisions move here after 24 hours'), ...old.slice(0, 100).map(approvalCard)) : null);
  };
  draw(); page = { shows: () => true, update: (ev) => ev.type === 'approval' && draw() };
}
async function openReview(agent) {
  const body = h('div', {}, h('p', { class: 'hint' }, 'Loading…'));
  const dlg = h('dialog', {}, h('form', { method: 'dialog' }, h('h2', {}, `Review changes: ${agent.name}`), body, h('div', { class: 'dlg-actions' }, h('button', { class: 'btn primary' }, 'Close'))));
  document.body.append(dlg); dlg.addEventListener('close', () => dlg.remove()); dlg.showModal();
  try { const d = await api(`/api/agents/${agent.id}/diff`); body.replaceChildren(h('p', { class: 'hint' }, `Compared with ${d.from}`), diffView(d)); }
  catch (e) { body.replaceChildren(h('p', { class: 'hint' }, e.message)); }
}

// ---------- projects ----------
function stagePicker(a) {
  const sel = h('select', { 'aria-label': 'Project stage', class: 'model-pick', onchange: guard(async (e) => {
    const to = e.target.value;
    if (to === 'closed' && !confirm(`Close "${a.name}"? Running work stops. Nothing is deleted and you can reopen it at any time.`)) { e.target.value = stageOf(a); return; }
    await api(`/api/projects/${a.id}/stage`, 'PUT', { stage: to });
    toast(`Moved to ${STAGES[to][0]}`);
  }) }, Object.entries(STAGES).map(([k, [label]]) => h('option', { value: k, selected: stageOf(a) === k }, label)));
  return h('label', { class: 'model-box' }, h('small', {}, 'Stage'), sel);
}
// Who is responsible for a project: the CEO unless you choose someone else.
function ownerOf(a) { return S.agents.find((x) => x.id === a.ownerId) || S.agents.find((x) => x.kind === 'general'); }
function ownerPicker(a) {
  const sel = h('select', { 'aria-label': 'Responsible agent', class: 'model-pick', onchange: guard(async (e) => {
    await api(`/api/projects/${a.id}/owner`, 'PUT', { agent: e.target.value });
    toast(`${e.target.selectedOptions[0].textContent.replace(' (default)', '')} is now responsible.`);
  }) }, h('option', {}, ownerOf(a)?.name || 'CEO'));
  api('/api/tasks/agents').then((list) => { const cur = ownerOf(a)?.id; sel.replaceChildren(...list.filter((x) => x.id !== a.id).map((x) => h('option', { value: x.id, selected: x.id === cur }, x.label + (x.ceo ? ' (default)' : '')))); }).catch(() => {});
  return h('label', { class: 'model-box' }, h('small', {}, 'Responsible'), sel);
}
function pageProjects() {
  crumbs('Workspace', 'Projects');
  const draw = () => {
    const ls = leads();
    view.replaceChildren(
      h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Projects'), h('p', { class: 'sub-title' }, 'Every project is led by your CEO (or whoever you set as Responsible), who hands work to your specialists.')),
        h('button', { class: 'btn primary big', onclick: () => openNewProject() }, svg(ICON.plus, 16, 2.2), 'New project')),
      ls.length ? Object.keys(STAGES).map((k) => { const g = ls.filter((a) => stageOf(a) === k); if (!g.length) return null;
        const grid = h('div', { class: 'grid' }, g.map((a) => h('a', { class: 'card', href: `#/project/${a.id}`, style: 'display:block' },
        h('div', { class: 'kv', style: 'justify-content:space-between' }, h('b', {}, a.name), h('span', { class: 'kv' }, stagePill(a), pill(a.status))),
        h('p', { class: 'hint', style: 'margin:8px 0' }, `${PNAME[a.provider] || a.provider} · ${a.method === 'api' ? 'Web' : 'Terminal'} · ${kidsOf(a.id).length} sub-agents`), h('div', { class: 'hint' }, `Responsible: ${ownerOf(a)?.name || 'not set'}`),
        a.git ? h('div', { class: 'mono hint' }, a.git.branch) : h('div', { class: 'hint' }, 'Plain folder'),
        a.plan ? (() => { const st = planStats(a.plan); return h('div', { style: 'margin-top:10px' }, bar(st.pct, `${a.name} progress`), h('small', { class: 'hint' }, `${st.pct}% · ${st.current ? `Phase ${st.index} of ${st.phases}: ${st.current.title}` : 'All phases done'}`)); })() : null,
        h('div', { class: 'hint', style: 'margin-top:6px' }, `Started ${ago(a.createdAt)}`))));
        const head = h('h2', { style: 'margin:22px 0 4px' }, `${STAGES[k][0]} `, h('small', { class: 'hint' }, `(${g.length})`)), hint = h('p', { class: 'hint', style: 'margin:0 0 10px' }, STAGES[k][1]);
        return k === 'closed' ? h('details', { class: 'stage-closed' }, h('summary', {}, head), hint, grid) : h('section', { 'aria-label': STAGES[k][0] }, head, hint, grid); })
        : h('div', { class: 'card empty' }, h('p', {}, 'No projects yet. Describe a goal and your CEO gets started.'), h('button', { class: 'btn primary big', onclick: () => openNewProject() }, 'Start your first project')));
  };
  draw(); page = { update: (ev) => ['agent', 'removed'].includes(ev.type) && draw() };
}

// ---------- project plan: where a big project stands ----------
const PH = { pending: ['', 'Not started'], active: ['work', 'In progress'], done: ['ok', 'Done'], blocked: ['err', 'Blocked'] };
function planStats(plan) {
  if (!plan) return null;
  const total = plan.phases.reduce((n, p) => n + p.steps.length, 0) || plan.phases.length;
  const done = plan.phases.reduce((n, p) => n + (p.steps.length ? p.steps.filter((x) => x.done).length : p.status === 'done' ? 1 : 0), 0);
  const cur = plan.phases.find((p) => p.status === 'active' || p.status === 'blocked');
  return { total, done, pct: total ? Math.round((done / total) * 100) : 0, current: cur, index: cur ? plan.phases.indexOf(cur) + 1 : plan.phases.length, phases: plan.phases.length };
}
const bar = (pct, label, tone = 'ok') => h('div', { class: 'ubar big', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': label }, h('span', { class: tone, style: `width:${pct}%` }));

// ---------- which model an agent uses: a list that fills itself from the AI it runs on ----------
S.models = {};
function modelPicker(a) {
  if (!a || a.provider === 'mock') return null;
  const list = S.models[a.provider];
  if (!list) { api(`/api/connections/${a.provider}/models`).then((r) => { S.models[a.provider] = r.models || []; page?.redrawHead?.(); }).catch(() => { S.models[a.provider] = []; }); }
  const opts = [...(list || [])]; if (a.model && !opts.some((m) => m.id === a.model)) opts.unshift({ id: a.model, label: a.model });
  const sel = h('select', { class: 'model-pick', 'aria-label': `AI model for ${a.name}`, title: 'Which AI model this agent uses', onchange: guard(async (e) => {
    let v = e.target.value;
    if (v === '__other') { v = (prompt('Type the model name exactly as the provider calls it') || '').trim(); if (!v) { e.target.value = a.model || ''; return; } }
    await api(`/api/agents/${a.id}/model`, 'PUT', { model: v }); toast(v ? `${a.name} now uses ${v}` : `${a.name} now uses the default model`);
  }) }, h('option', { value: '' }, 'Default model'), opts.map((m) => h('option', { value: m.id, selected: m.id === a.model }, m.label || m.id)), h('option', { value: '__other' }, 'Other…'));
  sel.value = a.model || '';
  return h('label', { class: 'model-box' }, h('small', {}, 'Model'), sel);
}

async function ensureMsgs(id) {
  if (!S.msgs[id]) S.msgs[id] = await api(`/api/agents/${id}/messages`);
  if (!S.logs[id]) S.logs[id] = await api(`/api/agents/${id}/logs`);
}

function pageProject(leadId, general = false) {
  const lead = S.agents.find((a) => a.id === leadId);
  if (!lead && !pageProject.retried) { pageProject.retried = true; loadState().then(() => { pageProject.retried = false; route(); }).catch(() => { pageProject.retried = false; }); return; }
  if (!lead) { view.replaceChildren(h('div', { class: 'card empty' }, 'This project no longer exists. ', h('a', { href: '#/projects', style: 'text-decoration:underline' }, 'Back to projects'))); crumbs('Workspace', 'Projects'); return; }
  if (general) crumbs('Workspace', 'Chat'); else crumbs('Workspace', 'Projects', lead.name);
  view.className = 'view flush';
  if (!S.sel || rootOf(S.agents.find((a) => a.id === S.sel) || { id: null }).id !== leadId) S.sel = leadId;
  S.tab = S.nextTab || 'chat'; S.nextTab = null;
  const el = { head: h('div', { class: 'chat-head' }), tabs: h('div', { class: 'tabs', role: 'tablist' }), body: h('div', { style: 'flex:1;display:flex;flex-direction:column;min-height:0' }), team: h('aside', { class: 'team', 'aria-label': 'Team' }) };
  view.replaceChildren(h('div', { class: 'ws' }, h('section', { class: 'chat' }, el.head, el.tabs, el.body), el.team));
  let msgsEl, termEl, liveEl, input;

  const sel = () => S.agents.find((a) => a.id === S.sel) || lead;
  const drawHead = () => {
    const a = sel(), l = S.agents.find((x) => x.id === leadId) || lead;
    el.head.replaceChildren(...[
      h('div', { class: 't' }, h('h1', {}, a.name), h('div', { class: 'hint' }, `${!a.parentId && !a.kind && !a.member ? `Led by ${ownerOf(a)?.name || 'your CEO'}` : a.role || ''} · ${PNAME[a.provider] || a.provider} · ${a.method === 'api' ? 'Web' : 'Terminal'}`, a.git ? h('span', { class: 'mono' }, ` · ${a.git.branch}`) : '')),
      !a.parentId && a.plan ? (() => { const st = planStats(a.plan); return h('a', { class: 'chip s-inprogress', href: '#', onclick: (e) => { e.preventDefault(); S.tab = 'plan'; drawTabs(); drawBody(); }, 'aria-label': `Project ${st.pct} percent done. Open the plan` }, `${st.pct}% done`); })() : null,
      modelPicker(a),
      !a.parentId && !a.kind ? stagePicker(a) : null,
      !a.parentId && !a.kind ? ownerPicker(a) : null,
      pill(a.status),
      a.kind === 'general' || a.title || a.mdFile ? h('button', { class: 'btn', onclick: () => openProfile(a) }, 'Edit profile') : null,
      a.status !== 'idle' ? h('button', { class: 'btn', onclick: guard(() => api(`/api/agents/${a.id}/stop`, 'POST', {})) }, 'Stop') : null,
      a.git ? h('button', { class: 'btn', onclick: () => openReview(a) }, 'Review changes') : null,
      a.method !== 'api' ? h('button', { class: 'btn', onclick: guard(() => takeOver(a)) }, 'Take over') : null,
      l.git && a.id === l.id ? (l.git.prUrl ? h('a', { class: 'btn', href: l.git.prUrl, target: '_blank', rel: 'noopener' }, 'View pull request') : h('button', { class: 'btn', onclick: () => openPrDialog(l) }, 'Open pull request')) : null,
      a.id === l.id && !general ? h('button', { class: 'btn', title: 'Keep this goal, plan and team to start similar projects', onclick: () => openSaveTemplate(l) }, 'Save as template') : null,
      a.id === l.id && !general ? h('button', { class: 'btn danger', onclick: guard(async () => { if (!confirm(`Delete "${a.name}" and its sub-agents for good? To keep everything, set the stage to Closed instead. Git branches are kept.`)) return; await api(`/api/agents/${a.id}`, 'DELETE'); location.hash = '#/projects'; }) }, 'Delete') : null].filter(Boolean));
  };
  const TABS = { chat: 'Chat', plan: 'Plan', org: 'Organisation', files: 'Files', terminal: 'Terminal' };
  const drawTabs = () => el.tabs.replaceChildren(...(general ? (S.orgDone ? ['chat', 'org'] : ['chat']) : Object.keys(TABS)).map((t) => h('button', { role: 'tab', 'aria-selected': String(S.tab === t), onclick: () => { S.tab = t; drawTabs(); drawBody(); } }, TABS[t])));
  if (general && !S.orgDone) el.tabs.style.display = 'none';
  const drawTeam = () => {
    if (general && !kidsOf(leadId).length) { el.team.style.display = 'none'; return; }
    el.team.style.display = '';
    const node = (a, d) => h('button', { class: 'node', style: `padding-left:${10 + d * 18}px`, 'aria-current': String(a.id === S.sel), onclick: () => { S.sel = a.id; drawAll(); } },
      h('span', { class: 'dot ' + ({ working: 'work pulse', waiting: 'info pulse', error: 'err' }[a.status] || 'ok') }),
      h('span', { class: 'n' }, h('b', {}, a.name), h('small', {}, S.activity[a.id] || `${PNAME[a.provider] || a.provider}${a.role ? ' · ' + a.role : ''}`)));
    const walk = (a, d) => [node(a, d), ...kidsOf(a.id).flatMap((k) => walk(k, d + 1))];
    el.team.replaceChildren(h('h3', {}, 'Team'), ...walk(S.agents.find((x) => x.id === leadId) || lead, 0));
  };
  const drawMsgs = () => {
    if (!msgsEl) return;
    if (msgsEl.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return; // don't wipe a note being typed
    const a = sel(), near = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
    refreshTaskIndex();
    const list = (S.msgs[a.id] || []).map((m) => {
      const t = timeOf(m.ts);
      if (m.role === 'system') {
        // "Asked Neo: …", "Told Neo: …" and "Assigned to Neo: …" are handoffs: shown as @Name with their text, from this chat's agent.
        const d = /^(Asked|Told|Assigned to) (.+?): ([\s\S]*)$/.exec(m.text || '');
        if (d && m.agentId) return bubble('them', a.name, colourOf(a.id), t, [h('span', { class: 'cb-mention', style: `color:${colourOf(m.agentId)}` }, `@${d[2]}: `), ...linkify(d[3]), h('small', { class: 'cb-note' }, ` (${d[1].toLowerCase()})`)]);
        return h('div', { class: 'cb-line' + (m.error ? ' error' : '') }, ...linkify(m.text || ''));
      }
      if (m.role === 'user' && !m.from) return bubble('me', null, null, t, linkify(m.text || ''));
      if (m.role === 'user' && m.from) return bubble('them', m.from.name, colourOf(m.from.id), t, linkify(m.text || ''));
      if (m.role === 'report') return bubble('them', 'Reports from sub-agents', '#64748b', t, linkify(m.text || ''));
      const who = m.by ? m.by.name : (!a.parentId && !a.kind && !a.member ? ownerOf(a)?.name : null) || a.name;
      return bubble('them', who, colourOf(m.by?.id || a.id), t, linkify(m.text || ''));
    });
    if (S.stream[a.id]) list.push(bubble('them', a.name, colourOf(a.id), '', S.stream[a.id]));
    for (const ap of pending().filter((x) => x.projectId === leadId)) list.push(approvalCard(ap));
    if (!list.length) list.push(h('div', { class: 'empty' }, 'Nothing here yet.'));
    msgsEl.replaceChildren(...list);
    if (near) msgsEl.scrollTop = msgsEl.scrollHeight;
    if (liveEl) liveEl.replaceChildren(...(a.status === 'working' || a.status === 'waiting' ? [h('span', { class: 'dot work pulse' }), S.activity[a.id] || (a.status === 'waiting' ? 'Waiting for sub-agents…' : 'Working…')] : []));
  };
  window.__drawChat = drawMsgs;   // lets the task index redraw the chat when it loads
  const drawTerm = () => {
    if (!termEl) return;
    const near = termEl.scrollHeight - termEl.scrollTop - termEl.clientHeight < 80;
    termEl.replaceChildren(...(S.logs[S.sel] || []).flatMap((l) => [h('span', { class: l.startsWith('$') || l.startsWith('──') ? 'c' : l.startsWith('!') ? 'e' : l.startsWith('✔') ? 'o' : '' }, l), '\n']));
    if (!(S.logs[S.sel] || []).length) termEl.textContent = 'No terminal activity yet.';
    if (near) termEl.scrollTop = termEl.scrollHeight;
  };
  // ----- organisation chart -----
  const deptOf = (a) => a.profile?.departmentLabel || (a.department === 'leadership' ? 'Leadership' : a.department ? a.department[0].toUpperCase() + a.department.slice(1) : 'General');
  const drawOrg = () => {
    const l = S.agents.find((x) => x.id === leadId) || lead;
    const members = S.agents.filter((a) => a.member && a.parentId === leadId);
    const boss = (a) => (members.some((m) => m.id === a.reportsTo) ? a.reportsTo : leadId);
    const under = (id) => members.filter((m) => boss(m) === id);
    const card = (a) => h('button', { class: 'org-card', 'aria-label': `${a.name}, ${deptOf(a)}`, title: a.role || deptOf(a), onclick: () => { S.sel = a.id; S.tab = 'chat'; drawAll(); } },
      h('b', {}, a.name), h('small', {}, deptOf(a)));
    const branch = (a) => h('div', { class: 'org-branch' }, card(a), under(a.id).length ? h('div', { class: 'org-sub' }, under(a.id).map(branch)) : null);
    const direct = under(leadId), depts = [...new Set(direct.map(deptOf))];
    const ask = guard(async () => { await api(`/api/agents/${leadId}/messages`, 'POST', { text: 'Look at this project and propose the permanent specialists we need to do it well (use apiary-hire, with a real reason for each). Do not propose anyone we do not need.' }); S.tab = 'chat'; drawTabs(); drawBody(); });
    return h('div', { class: 'org-wrap' },
      pending().filter((x) => x.projectId === leadId && x.kind === 'hire').map(approvalCard),
      h('div', { class: 'org' }, h('div', { class: 'org-top' }, card(l)),
        depts.length ? h('div', { class: 'org-row' }, depts.map((d) => h('div', { class: 'org-col' }, h('h4', {}, d), direct.filter((m) => deptOf(m) === d).map(branch))))
          : h('div', { class: 'card empty' }, h('p', {}, 'No one has been hired yet. The lead suggests hires when the work needs a specialist, with the reason and a ready-made profile for you to approve.'), h('button', { class: 'btn primary', onclick: ask }, 'Ask the lead for a hiring plan'))),
      (() => { const n = S.agents.filter((a) => !a.member && a.parentId && rootOf(a).id === leadId).length; return n ? h('p', { class: 'hint', style: 'text-align:center' }, `${n} temporary helper${n > 1 ? 's' : ''} created for one-off tasks are not shown here.`) : null; })());
  };

  // ----- project files -----
  const fs = { dir: '', file: null };
  const drawFiles = async () => {
    const box = h('div', { class: 'files' });
    el.body.replaceChildren(box);
    const q = (p) => encodeURIComponent(p);
    const crumbBar = () => h('div', { class: 'kv', style: 'flex-wrap:wrap' }, h('button', { class: 'btn', onclick: () => { fs.dir = ''; fs.file = null; drawFiles(); } }, 'Project folder'),
      ...fs.dir.split('/').filter(Boolean).map((part, i, arr) => h('button', { class: 'btn', onclick: () => { fs.dir = arr.slice(0, i + 1).join('/'); fs.file = null; drawFiles(); } }, part)));
    if (fs.file) {
      const f = await api(`/api/agents/${leadId}/file?path=${q(fs.file)}`).catch((e) => ({ error: e.message }));
      const area = h('textarea', { rows: '22', class: 'mono', 'aria-label': 'File contents', style: 'width:100%' }); area.value = f.content ?? '';
      box.replaceChildren(crumbBar(), h('h2', { style: 'margin:14px 0 8px;font-size:14px' }, fs.file),
        f.error ? h('p', { class: 'hint' }, f.error) : f.binary ? h('p', { class: 'hint' }, `This file is not text (${f.size} bytes). Download it to open it.`) : area,
        h('div', { class: 'kv', style: 'margin-top:12px' },
          !f.binary && !f.error ? h('button', { class: 'btn primary', onclick: guard(async () => { await api(`/api/agents/${leadId}/file?path=${q(fs.file)}`, 'PUT', { content: area.value }); toast('Saved'); }) }, 'Save') : null,
          h('a', { class: 'btn', href: `/api/agents/${leadId}/file?path=${q(fs.file)}&raw=1` }, 'Download'),
          h('button', { class: 'btn danger', onclick: guard(async () => { if (!confirm(`Delete ${fs.file}?`)) return; await api(`/api/agents/${leadId}/file?path=${q(fs.file)}`, 'DELETE'); fs.file = null; drawFiles(); }) }, 'Delete'),
          h('button', { class: 'btn', onclick: () => { fs.file = null; drawFiles(); } }, 'Back')));
      return;
    }
    let ls; try { ls = await api(`/api/agents/${leadId}/files?path=${q(fs.dir)}`); } catch (e) { box.replaceChildren(crumbBar(), h('p', { class: 'hint' }, e.message)); return; }
    const newDoc = () => {
      const name = h('input', { type: 'text', value: (fs.dir ? fs.dir + '/' : 'documents/') + 'notes.md', 'aria-label': 'File path' }), err = h('p', { class: 'hint', style: 'color:var(--err)', role: 'alert' });
      const go = h('button', { class: 'btn primary', type: 'button' }, 'Create');
      const dlg = h('dialog', {}, h('form', { method: 'dialog' }, h('h2', {}, 'New document'), h('label', { class: 'f' }, 'Path inside the project', name), err, h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', value: 'cancel' }, 'Cancel'), go)));
      go.onclick = async () => { try { await api(`/api/agents/${leadId}/file?path=${q(name.value.trim())}`, 'PUT', { content: '' }); fs.file = name.value.trim(); dlg.close(); drawFiles(); } catch (e) { err.textContent = e.message; } };
      document.body.append(dlg); dlg.addEventListener('close', () => dlg.remove()); dlg.showModal(); name.focus();
    };
    const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
    box.replaceChildren(h('div', { class: 'head-row' }, crumbBar(), h('button', { class: 'btn primary', onclick: newDoc }, svg(ICON.plus, 16, 2.2), 'New document')),
      h('p', { class: 'hint' }, 'Documents and data for this project. Agents work in this same folder, so anything saved here is visible to them.'),
      ls.items.length ? h('div', { class: 'filelist' }, ls.items.map((it) => h('button', { class: 'filerow', onclick: () => { if (it.type === 'dir') fs.dir = (fs.dir ? fs.dir + '/' : '') + it.name; else fs.file = (fs.dir ? fs.dir + '/' : '') + it.name; drawFiles(); } }, h('span', { 'aria-hidden': 'true' }, it.type === 'dir' ? '📁' : '📄'), h('b', { style: 'flex:1;text-align:left' }, it.name), h('small', {}, it.type === 'dir' ? '' : kb(it.size)), h('small', {}, ago(it.mtime)))))
        : h('div', { class: 'card empty' }, 'This folder is empty.'));
  };

  const drawPlan = () => {
    const l = S.agents.find((x) => x.id === leadId) || lead, plan = l.plan, st = planStats(plan);
    const call = guard(async (body) => { await api(`/api/projects/${leadId}/plan`, 'PUT', body); });
    if (!plan) return h('div', {}, h('h2', {}, 'Plan'), h('div', { class: 'card empty' }, h('p', {}, 'No plan yet.'), h('p', { class: 'hint' }, 'Big projects work best in phases. Ask the lead to plan it: you will see the phases and approve them before any work starts.'),
      h('button', { class: 'btn primary', onclick: guard(async () => { await api(`/api/projects/${leadId}/plan/ask`, 'POST', {}); S.tab = 'chat'; drawTabs(); drawBody(); toast('The lead is making a plan'); }) }, 'Ask the lead to make a plan')));
    return h('div', {}, h('div', { class: 'kv', style: 'justify-content:space-between;align-items:baseline' }, h('h2', { style: 'margin:0' }, 'Plan'), h('b', {}, `${st.pct}% done`)),
      bar(st.pct, 'Project progress', plan.phases.some((p) => p.status === 'blocked') ? 'warn' : 'ok'),
      h('p', { class: 'hint' }, `${st.current ? `Phase ${st.index} of ${st.phases}: ${st.current.title}` : 'All phases are done.'} · ${st.done} of ${st.total} steps finished`), plan.goal ? h('p', {}, h('b', {}, 'Goal: '), plan.goal) : null,
      plan.phases.map((p, i) => { const [tone, label] = PH[p.status] || PH.pending;
        return h('section', { class: 'card phase' + (p.status === 'active' ? ' current' : ''), style: 'margin-bottom:10px', 'aria-label': `Phase ${i + 1}: ${p.title}` },
          h('div', { class: 'kv', style: 'justify-content:space-between' }, h('b', {}, `${i + 1}. ${p.title}`), h('span', { class: 'pill ' + tone }, label)),
          p.goal ? h('p', { class: 'hint', style: 'margin:4px 0 8px' }, p.goal) : null, p.note ? h('p', { class: 'hint', style: 'margin:0 0 8px' }, `Note: ${p.note}`) : null,
          p.steps.map((t, j) => h('label', { class: 'check step' + (t.done ? ' done' : '') }, h('input', { type: 'checkbox', checked: t.done, 'aria-label': t.text, onchange: (e) => call({ phase: i + 1, step: j + 1, done: e.target.checked }) }), ` ${t.text}`)),
          h('div', { class: 'kv', style: 'margin-top:8px' }, p.status !== 'done' ? h('button', { class: 'btn', onclick: () => call({ phase: i + 1, status: 'done' }) }, 'Mark phase done') : null, p.status === 'blocked' ? h('button', { class: 'btn', onclick: () => call({ phase: i + 1, status: 'active' }) }, 'Unblock') : p.status !== 'done' ? h('button', { class: 'btn', onclick: () => { const n = prompt('Why is it blocked?') ; if (n !== null) call({ phase: i + 1, status: 'blocked', note: n }); } }, 'Mark blocked') : null));
      }),
      h('div', { class: 'kv' }, h('button', { class: 'btn', onclick: guard(async () => { await api(`/api/projects/${leadId}/plan/ask`, 'POST', { text: prompt('What should change in the plan?') || '' }); S.tab = 'chat'; drawTabs(); drawBody(); }) }, 'Ask the lead to revise it'), h('button', { class: 'btn danger', onclick: guard(async () => { if (!confirm('Remove the plan? The work already done is kept.')) return; await api(`/api/projects/${leadId}/plan`, 'DELETE'); }) }, 'Remove plan')));
  };
  const drawBody = () => {
    const a = sel();
    if (S.tab === 'plan') { msgsEl = null; termEl = null; el.body.replaceChildren(h('div', { class: 'pane' }, drawPlan())); return; }
    if (S.tab === 'org') { msgsEl = null; termEl = null; el.body.replaceChildren(h('div', { class: 'pane' }, drawOrg())); return; }
    if (S.tab === 'files') { msgsEl = null; termEl = null; drawFiles().catch((e) => toast(e.message, true)); return; }
    if (S.tab === 'terminal') {
      termEl = h('pre', { class: 'term', tabindex: '0', 'aria-label': 'Terminal output' });
      msgsEl = null; el.body.replaceChildren(termEl); drawTerm(); return;
    }
    termEl = null;
    msgsEl = h('div', { class: 'msgs', 'aria-live': 'polite' });
    liveEl = h('div', { class: 'live-line' });
    // Typing @ offers the people who can be called from this chat.
    let cands = null, shown = [], hi = 0, atStart = -1;
    const pop = h('div', { class: 'mention-pop', role: 'listbox', 'aria-label': 'Who do you want to call?', hidden: true });
    const loadCands = () => cands ||= api(`/api/agents/${sel().id}/mentionables`).catch(() => []);
    const closePop = () => { pop.hidden = true; shown = []; atStart = -1; };
    const choose = (c) => {
      const v = input.value, caret = input.selectionStart;
      input.value = v.slice(0, atStart) + '@' + c.name + ' ' + v.slice(caret);
      const pos = atStart + c.name.length + 2; input.setSelectionRange(pos, pos); closePop(); input.focus();
    };
    const drawPop = () => pop.replaceChildren(...shown.map((c, i) => h('button', { type: 'button', role: 'option', class: 'mention-opt', 'aria-selected': String(i === hi), onmousedown: (e) => { e.preventDefault(); choose(c); } }, h('b', {}, c.name), c.title ? h('span', { class: 'hint' }, ` ${c.title}`) : null)));
    const onType = async () => {
      const before = input.value.slice(0, input.selectionStart), m = /(^|[\s(,;:])@([^@\n]{0,40})$/.exec(before);
      if (!m) return closePop();
      const q = m[2].toLowerCase(), list = await loadCands();
      const hits = list.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.title || '').toLowerCase().includes(q))
        .sort((x, y) => Number(y.name.toLowerCase().startsWith(q)) - Number(x.name.toLowerCase().startsWith(q))).slice(0, 6);
      if (!hits.length) return closePop();
      shown = hits; hi = 0; atStart = before.length - m[2].length - 1; pop.hidden = false; drawPop();
    };
    input = h('textarea', { rows: '2', placeholder: (a.parentId ? `Message ${a.name} directly…` : general ? 'Ask anything…' : `Tell ${ownerOf(a)?.name || 'your CEO'} what you need…`) + ' Type @ to call a teammate.', 'aria-label': 'Message', oninput: onType, onblur: () => setTimeout(closePop, 120), onkeydown: (e) => {
      if (!pop.hidden && shown.length) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); hi = (hi + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length; drawPop(); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(shown[hi]); return; }
        if (e.key === 'Escape') { e.preventDefault(); closePop(); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    } });
    const send = guard(async () => {
      const text = input.value.trim(); if (!text) return;
      const r = await api(`/api/agents/${sel().id}/messages`, 'POST', { text });
      input.value = ''; closePop();
      if (r.tagged?.length) toast(`Sent to ${r.tagged.join(' and ')}. The answer will appear here.`);
    });
    el.body.replaceChildren(msgsEl, liveEl, h('div', { class: 'composer' }, pop, input, h('button', { class: 'btn primary big', onclick: send }, 'Send')));
    drawMsgs();
  };
  const drawAll = () => { drawHead(); drawTabs(); drawTeam(); drawBody(); };
  const load = guard(async () => { await Promise.all(S.agents.filter((a) => rootOf(a).id === leadId).map((a) => ensureMsgs(a.id))); drawAll(); });
  drawAll(); load();
  page = {
    redrawHead: () => drawHead(),
    update(ev) {
      if (ev.type === 'agent' || ev.type === 'removed') { if (!S.agents.find((a) => a.id === leadId)) { location.hash = '#/projects'; return; } drawHead(); drawTeam(); if (ev.agent && !S.msgs[ev.agent.id]) ensureMsgs(ev.agent.id).then(drawAll).catch(() => {}); }
      if (['message', 'delta', 'activity', 'agent'].includes(ev.type)) { drawMsgs(); if (ev.type === 'activity') drawTeam(); }
      if (ev.type === 'log') drawTerm();
      if (ev.type === 'approval') { drawMsgs(); drawHead(); }
      if (['org', 'plan'].includes(S.tab) && ['agent', 'approval', 'removed'].includes(ev.type)) drawBody();
    },
    shows: (ap) => ap.projectId === leadId,
  };
}

async function pageChat() {
  crumbs('Workspace', 'Chat');
  view.replaceChildren(h('div', { class: 'card empty' }, 'Opening chat…'));
  try {
    const a = await api('/api/chat');
    if (!S.agents.some((x) => x.id === a.id)) S.agents.push(a);
    if (cur() !== '#/chat' && cur() !== '#/organisation') return;
    await ensureMsgs(a.id);
    if (!S.sel || rootOf(S.agents.find((x) => x.id === S.sel) || { id: null }).id !== a.id) S.sel = a.id;
    pageProject(a.id, true);
    if (!S.orgDone) { const cta = h('div', { class: 'card', style: 'margin:12px 16px 0;display:flex;gap:12px;align-items:center;flex-wrap:wrap' }, h('div', { style: 'flex:1;min-width:240px' }, h('b', {}, 'You have not set up your CEO yet'), h('p', { class: 'hint', style: 'margin:2px 0 0' }, 'A short interview about your setup lets Apiary propose the team you need and write each person\'s profile for you.')), h('button', { class: 'btn primary', onclick: () => openSetup(3) }, 'Set up my CEO')); view.querySelector('.chat')?.prepend(cta); }
  } catch (e) { view.replaceChildren(...[getStartedCard(() => route()), h('div', { class: 'card empty' }, getStartedCard() ? 'No AI is connected yet.' : e.message, ' ', h('a', { href: '#/connections', style: 'text-decoration:underline' }, 'Open Connections'))].filter(Boolean)); }
}

// ---------- profile editor ----------
async function openProfile(agent) {
  const err = h('p', { class: 'hint', style: 'color:var(--err)', role: 'alert' });
  let p;
  try { p = await api(`/api/agents/${agent.id}/profile`); } catch (e) { toast(e.message, true); return; }
  const name = h('input', { type: 'text', value: p.name || agent.name, 'aria-label': 'Name' });
  const text = h('textarea', { rows: '16', style: 'font-family:var(--mono,monospace)', 'aria-label': 'Profile in Markdown' }); text.value = p.text || '';
  let adv = null; if (agent.provider !== 'mock') { try { adv = await api(`/api/agents/${agent.id}/model-advice`); } catch { /* none */ } }
  const advBox = adv ? h('div', { class: 'card', style: 'margin:8px 0' }, h('b', {}, 'Which AI model?'), h('p', { class: 'hint', style: 'margin:4px 0' }, adv.why), h('div', { class: 'kv' }, h('span', {}, `Now: ${adv.current || 'default'}`), adv.differs ? h('button', { class: 'btn', onclick: (e) => { e.preventDefault(); guard(async () => { await api(`/api/agents/${agent.id}/model`, 'PUT', { model: adv.model }); toast(`Now using ${adv.model}`); advBox.querySelector('.kv').replaceChildren(`Now: ${adv.model}`); })(); } }, `Use ${adv.model}`) : h('span', { class: 'pill ok' }, 'Already a good fit'))) : null;
  const dlg = h('dialog', {}, h('form', { method: 'dialog' }, h('h2', {}, `Profile: ${agent.title || agent.name}`),
    h('p', { class: 'hint' }, p.file ? `Saved as a Markdown file: ${p.file}` : 'Saved as a Markdown file.'),
    advBox, h('label', { class: 'f' }, 'Name', name), h('label', { class: 'f' }, 'Standing instructions and guardrails (Markdown)', text), err,
    h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', value: 'cancel' }, 'Cancel'), h('button', { class: 'btn primary', value: 'save', onclick: (e) => { e.preventDefault(); guard(async () => { await api(`/api/agents/${agent.id}/profile`, 'PUT', { name: name.value, text: text.value }); dlg.close(); await loadState(); route(); toast('Profile saved'); })(); } }, 'Save'))));
  document.body.append(dlg); dlg.addEventListener('close', () => dlg.remove()); dlg.showModal();
}

// ---------- team meetings ----------
function pageMeetings() {
  crumbs('Agents', 'Team meetings');
  const draw = async () => {
    const list = await api('/api/meetings').catch(() => []);
    const m = { frequency: S.meeting.frequency || 'off', time: S.meeting.time || '00:00', weekday: S.meeting.weekday ?? 0 };
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const freq = h('select', { 'aria-label': 'How often' }, [['off', 'Never'], ['daily', 'Every day'], ['weekly', 'Every week']].map(([v, t]) => h('option', { value: v, selected: m.frequency === v }, t)));
    const day = h('select', { 'aria-label': 'Day of the week' }, days.map((d, i) => h('option', { value: i, selected: m.weekday === i }, d)));
    const time = h('input', { type: 'time', value: m.time, 'aria-label': 'Time' });
    const sync = () => { day.style.display = freq.value === 'weekly' ? '' : 'none'; time.style.display = freq.value === 'off' ? 'none' : ''; }; freq.onchange = sync; sync();
    view.replaceChildren(h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Team meetings'), h('p', { class: 'sub-title' }, 'Your agents meet to stay in sync. Each says what they did and what changed, then reacts to the others. Minutes are saved as Markdown and added to everyone\'s memory.'))),
      h('div', { class: 'card' }, h('div', { class: 'kv' }, freq, day, time, h('button', { class: 'btn primary', onclick: guard(async () => { await api('/api/settings', 'PUT', { meeting: { frequency: freq.value, time: time.value || '00:00', weekday: Number(day.value) } }); await loadState(); toast('Meeting schedule saved'); }) }, 'Save schedule'),
        h('button', { class: 'btn', onclick: guard(async () => { await api('/api/meetings/run', 'POST', {}); toast('Meeting started. Minutes will appear below.'); setTimeout(draw, 4000); }) }, 'Hold a meeting now'))),
      h('h2', { style: 'margin-top:24px' }, 'Minutes'),
      list.length ? list.map((x) => h('div', { class: 'card', style: 'display:flex;gap:12px;align-items:center;margin-bottom:8px' }, h('b', { style: 'flex:1' }, `${x.date} · ${x.scopeName || x.scope}`), h('button', { class: 'btn', onclick: guard(async () => { const d = await api(`/api/meetings/${encodeURIComponent(x.scope)}/${x.date}`); const dlg = h('dialog', {}, h('form', { method: 'dialog' }, h('h2', {}, `Meeting ${x.date}`), h('pre', { class: 'diffstat mono', style: 'white-space:pre-wrap;max-height:60vh;overflow:auto' }, d.text || d.markdown || ''), h('div', { class: 'dlg-actions' }, h('button', { class: 'btn primary' }, 'Close')))); document.body.append(dlg); dlg.addEventListener('close', () => dlg.remove()); dlg.showModal(); }) }, 'Read'))) : h('div', { class: 'card empty' }, 'No meetings yet.'));
  };
  draw(); page = { shows: () => true };
}

// ---------- secrets vault ----------
const SECRET_TYPES = { ssh: 'SSH login', login: 'Login', token: 'API key or token' };
// The "Add a secret" card. Each kind asks for what it needs, and agents can use all of them.
function secretForm(draw) {
  const I = (ph, label, extra = {}) => h('input', { type: 'text', autocomplete: 'off', placeholder: ph, 'aria-label': label, ...extra });
  const nm = I('Name, e.g. Router or GitHub token', 'Secret name'), note = I('What is it for? (optional)', 'Note'), usr = I('Username', 'Username');
  const host = I('Server, e.g. 10.0.0.5 or server.example.com', 'Server'), port = I('Port', 'Port', { value: '22', inputmode: 'numeric' });
  const type = h('select', { 'aria-label': 'Kind of secret', onchange: () => drawF() }, [['ssh', 'SSH login (log in to a server)'], ['login', 'Login (username and password)'], ['token', 'API key or long-lived token']].map(([k, t]) => h('option', { value: k }, t)));
  const auth = h('select', { 'aria-label': 'Log in with', onchange: () => drawF() }, [['password', 'Password'], ['key', 'Private key']].map(([k, t]) => h('option', { value: k }, t)));
  const pw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Password', 'aria-label': 'Password' });
  const tok = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'API key or token', 'aria-label': 'API key or token' });
  const key = h('textarea', { rows: '4', class: 'masked', spellcheck: 'false', autocomplete: 'off', placeholder: 'or paste the private key here', 'aria-label': 'Private key' });
  const keyFile = h('input', { type: 'file', 'aria-label': 'Choose the private key file', onchange: async (e) => { const f = e.target.files[0]; if (f) { key.value = await f.text(); toast('Key loaded. It is not shown.'); } } });
  const fields = h('div', { class: 'secret-fields' });
  const row = (...c) => h('div', { class: 'formrow', style: 'margin-top:8px' }, ...c);
  const hints = { ssh: 'Agents log in with the built-in apiary-ssh command. They never see the password or key. Keys must not have a passphrase.', login: 'Agents get the password and username as environment variables for one task, after you approve.', token: 'Agents get it as an environment variable for one task, after you approve.' };
  function drawF() {
    const t = type.value;
    fields.replaceChildren(...(t === 'ssh' ? [row(host, port), row(usr, auth), auth.value === 'key' ? h('div', { style: 'margin-top:8px' }, h('label', { class: 'f' }, 'Choose the key file (best, it is never shown)', keyFile), key) : row(pw)] : t === 'login' ? [row(usr, pw)] : [row(tok)]), h('small', { class: 'hint', style: 'display:block;margin-top:6px' }, hints[t]));
  }
  const save = guard(async () => {
    const t = type.value, value = t === 'ssh' ? (auth.value === 'key' ? key.value : pw.value) : t === 'login' ? pw.value : tok.value;
    await api('/api/vault/secrets', 'POST', { name: nm.value, value, note: note.value, type: t, username: t === 'token' ? '' : usr.value, host: host.value, port: port.value, auth: auth.value });
    for (const x of [pw, tok, key]) x.value = '';
    draw();
  });
  drawF();
  return h('div', { class: 'card', style: 'margin-bottom:16px' }, h('h2', {}, 'Add a secret'), row(type), row(nm, note), fields, h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn primary', onclick: save }, 'Save to vault')));
}
function pageSecrets() {
  crumbs('Settings', 'Secrets vault');
  const draw = async () => {
    let v; try { v = await api('/api/vault'); } catch (e) { view.replaceChildren(h('div', { class: 'card empty' }, e.message)); return; }
    S.vault = { exists: v.exists, unlocked: v.unlocked, auto: v.auto };
    const head = h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Secrets vault'), h('p', { class: 'sub-title' }, 'Passwords and keys are encrypted with your passphrase and never stored in plain text. Assign each secret to the agents that may use it. When an agent asks to use one you approve it once or always. Never paste secrets into a chat.')),
      v.exists && v.unlocked ? h('button', { class: 'btn', onclick: guard(async () => { await api('/api/vault/lock', 'POST', {}); draw(); }) }, 'Lock now') : null);
    if (!v.exists) {
      const a = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Passphrase' }), b = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Repeat passphrase' });
      view.replaceChildren(head, h('div', { class: 'card' }, h('h2', {}, 'Create the vault'), h('label', { class: 'f' }, 'Passphrase (8+ characters)', a), h('label', { class: 'f' }, 'Repeat it', b), h('p', { class: 'hint' }, 'If you forget it the secrets cannot be recovered.'), h('button', { class: 'btn primary', onclick: guard(async () => { if (a.value !== b.value) throw new Error('The passphrases differ.'); await api('/api/vault/init', 'POST', { passphrase: a.value }); draw(); }) }, 'Create vault'))); return;
    }
    if (!v.unlocked) {
      const a = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Passphrase', onkeydown: (e) => { if (e.key === 'Enter') go(); } });
      const go = guard(async () => { await api('/api/vault/unlock', 'POST', { passphrase: a.value }); draw(); });
      view.replaceChildren(head, h('div', { class: 'card' }, h('h2', {}, 'The vault is locked'), h('p', { class: 'hint' }, v.auto === 'broken' ? v.autoProblem : v.auto === 'on' ? 'Auto-unlock is on, but the vault was locked by hand. It unlocks by itself after the next restart, or enter the passphrase now.' : 'It locks whenever Apiary restarts, and updates restart it. Agents cannot use secrets while it is locked. You can turn on auto-unlock once it is open.'), h('label', { class: 'f' }, 'Passphrase', a), h('button', { class: 'btn primary', onclick: go }, 'Unlock'))); return;
    }
    const autoCard = (() => {
      const pass = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Passphrase', placeholder: 'Passphrase' });
      const on = guard(async () => { await api('/api/vault/auto', 'POST', { enable: true, passphrase: pass.value }); pass.value = ''; toast('Auto-unlock is on'); draw(); });
      const off = guard(async () => { await api('/api/vault/auto', 'POST', { enable: false }); toast('Auto-unlock is off'); draw(); });
      const isOn = v.auto === 'on';
      return h('div', { class: 'card' }, h('h2', {}, 'Auto-unlock ', h('span', { class: 'pill ' + (isOn ? 'ok' : v.auto === 'broken' ? 'err' : '') }, isOn ? 'On' : v.auto === 'broken' ? 'Needs attention' : 'Off')),
        h('p', { class: 'hint' }, 'After a restart or an update, the vault unlocks by itself using a key file that only your user can read (kept outside the Apiary folder, so exports and backups never include it). Your passphrase still works as a backup. This protects against a stolen backup, but not against someone who is signed in to this computer as you.'),
        v.auto === 'broken' ? h('p', { class: 'hint', role: 'alert' }, v.autoProblem) : null,
        isOn ? h('button', { class: 'btn', onclick: off }, 'Turn off auto-unlock')
          : h('form', { class: 'formrow', onsubmit: (e) => { e.preventDefault(); on(); } }, pass, h('button', { class: 'btn primary', type: 'submit' }, 'Turn on auto-unlock')));
    })();
    const addCard = secretForm(draw);
    const rows = v.secrets.map((x) => {
      const asg = Object.fromEntries((x.assigned || []).map((a) => [a.key, a]));   // the server sends a list; this is the same thing by key
      // Agents that already have access are listed (change or remove); everyone else is added from one drop-down.
      const save = guard(async (next) => { await api(`/api/vault/secrets/${x.id}`, 'PUT', { assigned: Object.entries(next).map(([key, g]) => ({ key, label: g.label, grant: g.grant })) }); draw(); });
      const GRANTS = [['ask', 'Ask me each time'], ['always', 'Always allowed']];
      const has = v.eligible.filter((a) => asg[a.key]);
      const without = v.eligible.filter((a) => !asg[a.key]);
      const current = has.map((a) => {
        const sel = h('select', { 'aria-label': `${a.label} access to ${x.name}`, onchange: () => save({ ...asg, [a.key]: { label: a.label, grant: sel.value } }) }, GRANTS.map(([k, t]) => h('option', { value: k, selected: asg[a.key].grant === k }, t)));
        return h('div', { class: 'kv', style: 'justify-content:space-between;margin:4px 0;gap:8px' }, h('span', { style: 'flex:1' }, a.label), sel,
          h('button', { class: 'btn', 'aria-label': `Remove ${a.label}'s access to ${x.name}`, onclick: () => { const next = { ...asg }; delete next[a.key]; save(next); } }, 'Remove'));
      });
      const who = h('select', { 'aria-label': `Agent to give access to ${x.name}` }, h('option', { value: '' }, 'Choose an agent…'), without.map((a) => h('option', { value: a.key }, a.label)));
      const how = h('select', { 'aria-label': 'Kind of access' }, GRANTS.map(([k, t]) => h('option', { value: k }, t)));
      const add = h('div', { class: 'kv', style: 'margin-top:8px;gap:8px;flex-wrap:wrap' }, who, how,
        h('button', { class: 'btn primary', onclick: () => { const ag = without.find((q) => q.key === who.value); if (!ag) return toast('Choose an agent first.', true); save({ ...asg, [ag.key]: { label: ag.label, grant: how.value } }); } }, 'Add'));
      const picks = [...(current.length ? current : [h('p', { class: 'hint' }, 'No agent can use this yet.')]), without.length ? add : (v.eligible.length ? h('p', { class: 'hint' }, 'Every agent already has access.') : h('p', { class: 'hint' }, 'No agents yet.'))];
      const EV = 'APIARY_SECRET_' + x.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
      const usage = x.type === 'ssh' ? `Agents use it with: apiary-ssh "${x.name}" -- command` : x.type === 'login' ? `Agents get it as $${EV} and $${EV}_USER` : `Agents get it as $${EV}`;
      const detail = x.type === 'ssh' ? `${x.username || '?'}@${x.host}:${x.port} · ${x.auth === 'key' ? 'private key' : 'password'}` : x.type === 'login' && x.username ? `Username: ${x.username}` : '';
      const editConn = () => {
        const host = h('input', { type: 'text', value: x.host, 'aria-label': 'Server' }), port = h('input', { type: 'text', value: String(x.port), inputmode: 'numeric', 'aria-label': 'Port' }), usr = h('input', { type: 'text', value: x.username, 'aria-label': 'Username' });
        const au = h('select', { 'aria-label': 'Log in with' }, [['password', 'Password'], ['key', 'Private key']].map(([k, t]) => h('option', { value: k, selected: x.auth === k }, t)));
        const d = dlgOpen(`Connection: ${x.name}`, h('label', { class: 'f' }, 'Server (name or IP address)', host), h('label', { class: 'f' }, 'Port', port), h('label', { class: 'f' }, 'Username', usr), h('label', { class: 'f' }, 'Log in with', au), h('p', { class: 'hint' }, 'Switching between password and key also needs the new password or key: use Replace secret afterwards.'),
          h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', value: 'x' }, 'Cancel'), h('button', { class: 'btn primary', value: 's', onclick: (e) => { e.preventDefault(); guard(async () => { await api(`/api/vault/secrets/${x.id}`, 'PUT', { host: host.value, port: port.value, username: usr.value, auth: au.value }); d.close(); draw(); })(); } }, 'Save')));
      };
      const replaceLabel = x.type === 'ssh' ? (x.auth === 'key' ? 'New private key' : 'New password') : x.type === 'login' ? 'New password' : 'New token or key';
      // The full details and actions open in a window; the box on the page shows only the title and who it is assigned to.
      const full = h('div', {}, h('div', { class: 'kv', style: 'justify-content:space-between' }, h('div', {}, h('span', { class: 'chip' }, SECRET_TYPES[x.type] || 'Secret'), detail ? h('small', { style: 'display:block' }, detail) : null, x.note ? h('small', { class: 'hint', style: 'display:block' }, x.note) : null, h('small', { class: 'hint mono', style: 'display:block' }, usage)),
        h('div', { class: 'kv' }, x.type === 'ssh' ? h('button', { class: 'btn', onclick: editConn }, 'Edit connection') : null, x.type === 'login' ? h('button', { class: 'btn', onclick: guard(async () => { const nu = prompt(`Username for ${x.name}`, x.username || ''); if (nu !== null) { await api(`/api/vault/secrets/${x.id}`, 'PUT', { username: nu }); draw(); } }) }, 'Username') : null, h('button', { class: 'btn', onclick: guard(async () => { const nv = await askSecret(`Replace ${x.name}`, replaceLabel, { key: x.type === 'ssh' && x.auth === 'key' }); if (nv) { await api(`/api/vault/secrets/${x.id}`, 'PUT', { value: nv }); toast('Replaced'); } }) }, 'Replace secret'), h('button', { class: 'btn danger', onclick: guard(async () => { if (!confirm(`Delete ${x.name}?`)) return; await api(`/api/vault/secrets/${x.id}`, 'DELETE'); draw(); }) }, 'Delete'))),
        h('details', { open: Object.keys(asg).length > 0 }, h('summary', {}, 'Who may use it'), picks));
      const assignedNames = (x.assigned || []).map((a) => a.label);
      return h('div', { class: 'card secret-card', style: 'margin-bottom:8px;padding:10px 14px' }, h('div', { class: 'kv', style: 'justify-content:space-between;gap:12px;flex-wrap:wrap' },
        h('button', { class: 'btn', 'aria-label': `Open ${x.name}`, style: 'background:none;border:0;padding:0;font-weight:600;color:var(--accent);cursor:pointer;text-align:left;font-size:inherit', onclick: () => dlgOpen(x.name, full, h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', value: 'x' }, 'Close'))) }, x.name),
        h('small', { class: 'hint' }, assignedNames.length ? `Assigned to: ${assignedNames.join(', ')}` : 'Not assigned to anyone yet')));
    });
    view.replaceChildren(head, autoCard, addCard, rows.length ? rows : h('div', { class: 'card empty' }, 'No secrets yet.'));
  };
  draw(); page = { shows: () => true };
}

// ---------- updates ----------
function renderUpdateChip() {
  let c = document.getElementById('upd');
  const u = S.update;
  if (!u || u.state !== 'ready') { c?.remove(); return; }
  if (!c) { c = h('a', { id: 'upd', class: 'btn primary', href: '#/updates', style: 'padding:4px 12px;font-size:12px' }); $('#theme').before(c); }
  c.textContent = `Update ready: ${u.latest}`;
}
async function refreshUpdate() { try { S.update = await api('/api/update'); renderUpdateChip(); } catch { /* ignore */ } }
setInterval(() => { if (!document.hidden) refreshUpdate(); }, 5 * 60 * 1000);
// A full-screen view of the installation, so nobody thinks it has frozen.
// ---------- install the AI tools from inside Apiary ----------
const TOOLNAME = { claude: 'Claude Code', codex: 'Codex', gh: 'the GitHub tool' };
function installOverlay(ids, after) {
  if (document.getElementById('inst-overlay')) return;
  const bar2 = h('span', { style: 'width:0%' }), log = h('pre', { class: 'term upd-log', tabindex: '0', 'aria-label': 'Install log' }), list = h('ol', { class: 'upd-steps' });
  const title = h('h2', {}, `Installing ${ids.map((i) => TOOLNAME[i]).join(' and ')}`), sub = h('p', { class: 'hint', role: 'status' }, 'Please keep this page open. This usually takes one to three minutes.');
  const secs = h('small', { class: 'hint' }), actions = h('div', { class: 'kv', style: 'justify-content:flex-end;margin-top:10px' }), next = h('div');
  const ov = h('div', { id: 'inst-overlay', class: 'upd-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Installing' }, h('div', { class: 'card upd-card' }, title, sub, h('div', { class: 'ubar big' }, bar2), list, log, h('div', { class: 'kv', style: 'justify-content:space-between;margin-top:6px' }, secs), next, actions));
  document.body.append(ov);
  const close = () => { ov.remove(); clearInterval(tick); stop = true; };
  const t0 = Date.now(); let stop = false;
  const tick = setInterval(() => { secs.textContent = `${Math.round((Date.now() - t0) / 1000)} s`; }, 500);
  const icon = { wait: '○', run: '◐', done: '✔', skip: '✔', fail: '✖' };
  const begin = async () => { try { await api('/api/tools/install', 'POST', { tools: ids }); } catch (e) { if (!/already running/i.test(e.message)) { sub.textContent = e.message; actions.replaceChildren(h('button', { class: 'btn', onclick: close }, 'Close')); return; } } stop = false; poll(); };
  const poll = async () => {
    if (stop) return;
    try {
      const { install: st } = await api('/api/tools');
      bar2.style.width = st.pct + '%'; bar2.className = st.state === 'failed' ? 'err' : '';
      list.replaceChildren(...st.steps.map((x) => h('li', { class: 'st-' + (x.state === 'skip' ? 'done' : x.state) }, h('span', { 'aria-hidden': 'true' }, icon[x.state]), ` ${x.label}${x.state === 'skip' ? ' (already there)' : ''}`)));
      log.textContent = st.log.join('\n'); log.scrollTop = log.scrollHeight;
      if (st.state === 'failed') {
        stop = true; clearInterval(tick); title.textContent = 'The install did not finish'; sub.textContent = st.failed?.message || 'Something went wrong.';
        actions.replaceChildren(h('button', { class: 'btn', onclick: close }, 'Close'), h('button', { class: 'btn primary', onclick: () => { clearInterval(tick); ov.remove(); installOverlay(ids, after); } }, 'Try again')); return;
      }
      if (st.state === 'done') {
        if (ids.length === 1 && ids[0] === 'gh') { await loadState().catch(() => {}); await refreshConns(); close(); if (after) after(); else route(); return; }
        stop = true; clearInterval(tick); bar2.style.width = '100%'; title.textContent = 'Installed'; sub.textContent = 'One last step: sign in once, so Apiary can use your account.';
        await loadState().catch(() => {}); await refreshConns();
        next.replaceChildren(...ids.flatMap((i) => [h('p', { style: 'margin:10px 0 4px' }, h('b', {}, TOOLNAME[i]), ': run this in a terminal on this computer. It shows a link to open in your browser.'), cmdBox(CINFO[i].login)]), h('p', { class: 'hint' }, 'You can also use a web API key instead of signing in: open Connections.'));
        actions.replaceChildren(h('button', { class: 'btn', onclick: close }, 'Close'), h('button', { class: 'btn primary', onclick: () => { close(); if (after) after(); else location.hash = `#/connections/${ids[0]}`; route(); } }, 'I have signed in. Check now')); return;
      }
    } catch { /* the page keeps trying */ }
    setTimeout(poll, 600);
  };
  begin();
}
const installBtn = (id, after, label) => h('button', { class: 'btn primary', onclick: () => installOverlay([id], after) }, label || `Install ${TOOLNAME[id]} for me`);
function getStartedCard(after) {
  if (!S.providers || S.providers.some((p) => p.id !== 'mock')) return null;
  return h('div', { class: 'card start-card', role: 'region', 'aria-label': 'Get an AI onto this computer' },
    h('h2', { style: 'margin-top:0' }, 'Let us get an AI onto this computer'),
    h('p', {}, 'Apiary needs an AI to work with, and none is installed yet. Click one and Apiary downloads and installs it for you. You will see what is happening.'),
    h('div', { class: 'kv' }, installBtn('claude', after), installBtn('codex', after), h('button', { class: 'btn', onclick: () => installOverlay(['claude', 'codex'], after) }, 'Install both')),
    h('p', { class: 'hint', style: 'margin-bottom:0' }, 'Already have an API key? ', h('a', { href: '#/connections', style: 'text-decoration:underline' }, 'Use it under Connections'), ' instead.'));
}

// ---------- export and import: move everything to another computer ----------
function pageTransfer() {
  crumbs('Settings', 'Export and import');
  const vault = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Include the secrets vault' }), files = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Include project files and repositories' });
  const info = h('p', { class: 'hint', role: 'status' }, 'Checking what will be included…');
  const refresh = () => api(`/api/export?info=1&vault=${vault.checked ? 1 : 0}&files=${files.checked ? 1 : 0}`).then((i) => {
    const mb = (i.bytes / 1048576).toFixed(i.bytes > 1e8 ? 0 : 1);
    info.replaceChildren(`About ${mb} MB. `, i.hasVault ? (vault.checked ? 'The vault is included and stays encrypted.' : 'The vault is left out.') : 'You have no vault yet.', i.external.length ? h('div', { style: 'margin-top:6px' }, 'These folders are outside Apiary and cannot travel in the file. Copy them yourself and keep the same path, or point the agents at the new place: ', h('span', { class: 'mono' }, i.external.join(', '))) : '');
  }).catch(() => {});
  vault.onchange = files.onchange = refresh; refresh();
  const exportBtn = h('a', { class: 'btn primary big', href: '#', onclick: (e) => { e.preventDefault(); const a = h('a', { href: `/api/export?vault=${vault.checked ? 1 : 0}&files=${files.checked ? 1 : 0}`, download: '' }); document.body.append(a); a.click(); a.remove(); toast('Your download is starting. A large export can take a minute to begin.'); } }, 'Download export');
  const file = h('input', { type: 'file', accept: '.gz,.tgz,application/gzip', 'aria-label': 'Export file' }), pass = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Vault passphrase', 'aria-label': 'Vault passphrase' });
  const prog = h('div', { class: 'ubar big', style: 'display:none', role: 'progressbar', 'aria-label': 'Upload progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('span', { style: 'width:0%' })), msg = h('p', { class: 'hint', role: 'status' });
  const importBtn = h('button', { class: 'btn primary big', onclick: () => {
    const f = file.files[0];
    if (!f) return toast('Choose the export file first', true);
    if (!confirm('Import this file? Everything in this Apiary is replaced by what is in the file. What is here now is not deleted: it is moved to a backup folder inside ~/.apiary. Apiary restarts afterwards.')) return;
    importBtn.disabled = true; prog.style.display = ''; msg.textContent = 'Uploading…';
    const x = new XMLHttpRequest(); x.open('POST', '/api/import');
    x.setRequestHeader('content-type', 'application/gzip'); x.setRequestHeader('x-apiary-import', '1'); x.setRequestHeader('x-vault-passphrase', encodeURIComponent(pass.value));
    x.upload.onprogress = (e) => { if (e.lengthComputable) { const pc = Math.round((e.loaded / e.total) * 100); prog.firstChild.style.width = pc + '%'; prog.setAttribute('aria-valuenow', pc); msg.textContent = pc < 100 ? `Uploading… ${pc}%` : 'Checking and importing… this can take a moment.'; } };
    x.onerror = () => { importBtn.disabled = false; msg.textContent = 'The upload failed. Check the connection and try again.'; };
    x.onload = () => {
      let r = {}; try { r = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status !== 200) { importBtn.disabled = false; prog.style.display = 'none'; msg.replaceChildren(h('span', { style: 'color:var(--err)', role: 'alert' }, r.error || `Import failed (${x.status}).`)); if (r.needsPassphrase) pass.focus(); return; }
      msg.textContent = 'Imported. Restarting Apiary…'; prog.firstChild.style.width = '100%';
      const t0 = Date.now(), wait = async () => { try { await fetch('/api/state', { cache: 'no-store' }).then((q) => q.json()); if (Date.now() - t0 > 2500) { location.hash = '#/chat'; location.reload(); return; } } catch { /* still restarting */ } setTimeout(wait, 1000); };
      setTimeout(wait, 2000);
    };
    x.send(f);
  } }, 'Import');
  view.replaceChildren(h('div', {}, h('h1', {}, 'Export and import'), h('p', { class: 'sub-title' }, 'Move everything to another computer: your projects, agents, chats, memory, tasks, tickets, settings and project files in one file.'),
    h('div', { class: 'card', style: 'max-width:640px' }, h('h2', {}, 'Export'),
      h('label', { class: 'check' }, files, ' Include project files and repositories'), h('label', { class: 'check' }, vault, ' Include the secrets vault (stays encrypted)'), info,
      h('p', { class: 'hint' }, 'The file also holds your connection keys and tokens, so keep it private and delete it after the move.'), exportBtn),
    h('div', { class: 'card', style: 'max-width:640px;margin-top:16px' }, h('h2', {}, 'Import'),
      h('p', { class: 'hint' }, 'Do this on the new computer, after installing Apiary. If the file has a vault, its passphrase is required and is checked before anything changes.'),
      h('label', { class: 'f' }, 'Export file', file), h('label', { class: 'f' }, 'Vault passphrase (only if the file has a vault)', pass), prog, msg, importBtn)));
}
function updateOverlay(from) {
  if (document.getElementById('upd-overlay')) return;
  const bar2 = h('span', { style: 'width:0%' }), log = h('pre', { class: 'term upd-log', tabindex: '0', 'aria-label': 'Update log' }), list = h('ol', { class: 'upd-steps' }), title = h('h2', {}, 'Updating Apiary'), sub = h('p', { class: 'hint', role: 'status' }, 'Please keep this page open. It refreshes by itself when the update is done.');
  const secs = h('small', { class: 'hint' }), close = h('button', { class: 'btn', style: 'display:none', onclick: () => ov.remove() }, 'Close');
  const ov = h('div', { id: 'upd-overlay', class: 'upd-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Updating Apiary' }, h('div', { class: 'card upd-card' }, title, sub, h('div', { class: 'ubar big' }, bar2), list, log, h('div', { class: 'kv', style: 'justify-content:space-between' }, secs, close)));
  document.body.append(ov);
  const t0 = Date.now(); let restarting = false, stop = false;
  const icon = { wait: '○', run: '◐', done: '✔', skip: '–', fail: '✖' };
  const tick = setInterval(() => { secs.textContent = `${Math.round((Date.now() - t0) / 1000)} s`; }, 500);
  const poll = async () => {
    if (stop) return;
    try {
      if (restarting) {
        const st = await fetch('/api/state', { cache: 'no-store' }).then((r) => r.json());
        if (st.version && st.version !== from) { stop = true; clearInterval(tick); bar2.style.width = '100%'; sub.textContent = `Updated to ${st.version}. Refreshing…`; setTimeout(() => location.reload(), 700); return; }
        if (Date.now() - t0 > 40000) { sub.textContent = 'This is taking longer than usual. If the page does not come back, restart Apiary by hand: systemctl --user restart apiary (or start it again in the terminal). Then refresh this page. Your update is installed.'; close.style.display = ''; }
      } else {
        const u = await fetch('/api/update', { cache: 'no-store' }).then((r) => r.json()), pr = u.progress;
        if (pr) {
          bar2.style.width = pr.pct + '%'; bar2.className = pr.failed ? 'err' : '';
          list.replaceChildren(...pr.steps.map((x) => h('li', { class: 'st-' + x.state }, h('span', { 'aria-hidden': 'true' }, icon[x.state]), ` ${x.label}`)));
          log.textContent = pr.log.join('\n'); log.scrollTop = log.scrollHeight;
          if (pr.failed) { stop = true; clearInterval(tick); title.textContent = 'The update did not work'; sub.textContent = 'Nothing was broken: the old version is still in place. You can try again later.'; close.style.display = ''; return; }
          if (pr.steps[4].state === 'run') { restarting = true; sub.textContent = 'Restarting Apiary. This usually takes a few seconds…'; }
        }
      }
    } catch { if (restarting === false && Date.now() - t0 > 3000) { restarting = true; sub.textContent = 'Restarting Apiary. This usually takes a few seconds…'; } }
    setTimeout(poll, restarting ? 1200 : 500);
  };
  poll();
}
function pageUpdates() {
  crumbs('Settings', 'Updates');
  const draw = () => {
    const u = S.update || { state: 'unsupported' };
    const msg = { uptodate: `You are up to date (version ${S.version}).`, ready: `Version ${u.latest} is downloaded and ready to install.`, error: u.error || 'The last check failed.', unsupported: u.error || 'Updates are not available for this install (it is not a git checkout).', checking: 'Checking…' }[u.state] || 'Not checked yet. Press Check for updates.';
    const busy = h('p', { class: 'hint', role: 'status' });
    const check = h('button', { class: 'btn', onclick: guard(async () => { busy.textContent = 'Checking GitHub…'; S.update = await api('/api/update/check', 'POST', {}); renderUpdateChip(); draw(); }) }, 'Check for updates');
    const install = u.state === 'ready' ? h('button', { class: 'btn primary big', onclick: guard(async () => {
      try { await api('/api/update/install', 'POST', {}); }
      catch (e) { if (/working right now/i.test(e.message) && confirm(`${e.message}\n\nInstall anyway? Running agents will be stopped.`)) await api('/api/update/install', 'POST', { force: true }); else throw e; }
      updateOverlay(S.version);
    }) }, `Install ${u.latest}`) : null;
    const auto = h('select', { 'aria-label': 'How often to check for updates', onchange: guard(async (e) => { const r = await api('/api/settings', 'PUT', { updateCheck: e.target.value }); S.updateCheck = r.updateCheck; S.autoUpdate = r.autoUpdate; toast(e.target.value === 'manual' ? 'Apiary will only check when you press the button' : `Apiary will check ${e.target.value}`); }) }, [['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['manual', 'Only when I press the button']].map(([v, l]) => h('option', { value: v, selected: S.updateCheck === v }, l)));
    view.replaceChildren(h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Updates'), h('p', { class: 'sub-title' }, 'Apiary checks GitHub for a new version and downloads it without installing. You decide when to install; it then restarts and your browser refreshes.'))),
      h('div', { class: 'card' }, h('p', {}, h('b', {}, `Installed: ${S.version}`), u.latest && u.state === 'ready' ? ` · Available: ${u.latest}` : ''), h('p', {}, msg), u.checkedAt ? h('p', { class: 'hint' }, `Last checked ${new Date(u.checkedAt).toLocaleString()}`) : null,
        u.notes?.length ? h('details', { open: true }, h('summary', {}, 'What is new'), h('pre', { class: 'diffstat mono', style: 'white-space:pre-wrap' }, [].concat(u.notes).join('\n'))) : null,
        h('div', { class: 'kv', style: 'margin-top:12px' }, check, install), busy,
        h('label', { class: 'f', style: 'margin-top:12px;max-width:340px' }, 'Look for new versions', auto, h('small', {}, 'A new version is only downloaded. It is never installed until you press Install.'))));
  };
  draw(); refreshUpdate().then(() => { if (cur() === '#/updates') draw(); if (S.update?.state === 'installing') updateOverlay(S.version); }); page = { shows: () => true };
}

// ---------- teams ----------
function pageTeams() {
  crumbs('Agents', 'Teams');
  const draw = async () => {
    const teams = await api('/api/teams'); S.teams = teams;
    view.replaceChildren(h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Teams'), h('p', { class: 'sub-title' }, 'Ready-made organisations. Pick one when you start a project: the lead hands each job to the right member, who first checks with the others.')), h('button', { class: 'btn primary big', onclick: () => editTeam() }, svg(ICON.plus, 16, 2.2), 'New team')),
      teams.length ? h('div', { class: 'grid' }, teams.map((t) => h('div', { class: 'card' }, h('b', {}, t.name), h('p', { class: 'hint', style: 'margin:6px 0' }, t.description || ''),
        h('p', { class: 'hint' }, `Lead: ${t.lead.name}`), h('p', { class: 'hint', style: 'margin-bottom:10px' }, `Members: ${t.members.map((m) => m.name).join(', ')}`),
        h('div', { class: 'kv' }, h('button', { class: 'btn', onclick: () => editTeam(t) }, 'Edit'), h('button', { class: 'btn danger', onclick: guard(async () => { await api('/api/teams/' + t.id, 'DELETE'); draw(); }) }, 'Delete'))))) : h('div', { class: 'card empty' }, 'No teams yet.'));
  };
  function editTeam(t = null) {
    const mk = (m = {}) => ({ name: h('input', { type: 'text', value: m.name || '', placeholder: 'Name' }), role: h('input', { type: 'text', value: m.role || '', placeholder: 'What they do' }), ins: h('textarea', { rows: '2', placeholder: 'Optional specifics. Guardrails are added for you.' }), consult: h('input', { type: 'checkbox', checked: m.consult !== false, 'aria-label': 'Others check with this member first' }) });
    const lead = mk(t?.lead || { name: 'CEO', role: 'Decides who does the work and reports back' }); lead.ins.value = t?.lead.instructions || '';
    const members = (t?.members || [{}]).map((m) => { const r = mk(m); r.ins.value = m.instructions || ''; return r; });
    const name = h('input', { type: 'text', value: t?.name || '' }), desc = h('input', { type: 'text', value: t?.description || '' });
    const box = h('div'), err = h('p', { class: 'hint', style: 'color:var(--err)', role: 'alert' });
    const drawM = () => box.replaceChildren(...members.map((m, i) => h('div', { class: 'card', style: 'margin:8px 0' }, h('div', { class: 'kv' }, m.name, m.role), m.ins, h('div', { class: 'kv', style: 'margin-top:6px' }, h('label', { class: 'check' }, m.consult, h('span', {}, 'Others check with them before a job')), h('button', { type: 'button', class: 'btn danger', onclick: () => { members.splice(i, 1); drawM(); } }, 'Remove')))));
    drawM();
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Save');
    const dlg = h('dialog', {}, h('form', { method: 'dialog' }, h('h2', {}, t ? 'Edit team' : 'New team'), h('label', { class: 'f' }, 'Team name', name), h('label', { class: 'f' }, 'Description', desc),
      h('div', { class: 'f' }, 'Lead'), h('div', { class: 'card' }, h('div', { class: 'kv' }, lead.name, lead.role), lead.ins),
      h('div', { class: 'f', style: 'margin-top:12px' }, 'Members'), box, h('button', { type: 'button', class: 'btn', onclick: () => { members.push(mk()); drawM(); } }, 'Add member'), err,
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', value: 'cancel' }, 'Cancel'), save)));
    save.onclick = async () => {
      try {
        const p = (m) => ({ name: m.name.value, role: m.role.value, instructions: m.ins.value, consult: m.consult.checked });
        await api(t ? '/api/teams/' + t.id : '/api/teams', t ? 'PUT' : 'POST', { name: name.value, description: desc.value, lead: p(lead), members: members.map(p) });
        dlg.close(); draw();
      } catch (e) { err.textContent = e.message; }
    };
    document.body.append(dlg); dlg.addEventListener('close', () => dlg.remove()); dlg.showModal();
  }
  draw().catch((e) => toast(e.message, true));
}

// ---------- memory ----------
function pageMemory() {
  crumbs('Agents', 'Memory');
  const st = { q: '', agent: '', data: null };
  const q = h('input', { type: 'search', placeholder: 'Search everything remembered', 'aria-label': 'Search memory' });
  const sel = h('select', { 'aria-label': 'Filter by agent' });
  const out = h('div'), toggle = h('input', { type: 'checkbox', checked: S.memory?.enabled !== false, 'aria-label': 'Memory on' });
  toggle.onchange = guard(async () => { await api('/api/settings', 'PUT', { memory: toggle.checked }); S.memory = { ...S.memory, enabled: toggle.checked }; toast(toggle.checked ? 'Memory is on' : 'Memory is off: nothing new is recorded or recalled'); });
  const load = guard(async () => {
    const d = await api(`/api/memory?q=${encodeURIComponent(q.value)}&agent=${encodeURIComponent(sel.value)}`);
    const cur = sel.value; sel.replaceChildren(h('option', { value: '' }, 'All agents'), ...d.agents.map((a) => h('option', { value: a, selected: a === cur }, a)));
    out.replaceChildren(h('p', { class: 'hint' }, `${d.total} memories in total${d.items.length < d.total ? ` · showing ${d.items.length}` : ''}`),
      d.items.length ? d.items.map((m) => h('div', { class: 'card', style: 'margin:8px 0' }, h('div', { class: 'kv', style: 'justify-content:space-between' }, h('span', { class: 'hint' }, `${new Date(m.ts).toLocaleString()} · ${m.who || 'someone'} · ${m.agent === null && m.project === null ? 'everyone' : m.project ? 'project' : 'agent'}`), h('span', { class: 'kv' }, h('span', { class: 'pill' }, m.kind === 'note' ? 'Note' : m.digest ? 'Summary' : 'Task'), h('button', { class: 'btn danger', onclick: guard(async () => { await api('/api/memory/' + m.id, 'DELETE'); load(); }) }, 'Forget'))), h('p', { style: 'margin:8px 0 0;white-space:pre-wrap' }, m.text))) : h('div', { class: 'card empty' }, 'Nothing remembered yet. Agents remember each finished task automatically.'));
  });
  let t; q.oninput = () => { clearTimeout(t); t = setTimeout(load, 250); }; sel.onchange = load;
  const addNote = () => {
    const text = h('textarea', { rows: '3', placeholder: 'e.g. I prefer short answers. My server is called Zeus.' }), err = h('p', { class: 'hint', style: 'color:var(--err)', role: 'alert' });
    const go = h('button', { class: 'btn primary', type: 'button' }, 'Remember');
    const dlg = h('dialog', {}, h('form', { method: 'dialog' }, h('h2', {}, 'Add a note for every agent'), text, err, h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', value: 'cancel' }, 'Cancel'), go)));
    go.onclick = async () => { try { await api('/api/memory', 'POST', { text: text.value, scope: 'global' }); dlg.close(); load(); } catch (e) { err.textContent = e.message; } };
    document.body.append(dlg); dlg.addEventListener('close', () => dlg.remove()); dlg.showModal(); text.focus();
  };
  view.replaceChildren(h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Memory'), h('p', { class: 'sub-title' }, 'Every agent remembers what it did tonight, yesterday, last week, last month and last year, plus notes you give it. Older history is folded into monthly summaries, never thrown away.')), h('button', { class: 'btn primary big', onclick: addNote }, svg(ICON.plus, 16, 2.2), 'Add a note')),
    h('label', { class: 'check', style: 'margin-bottom:14px' }, toggle, h('span', {}, h('b', {}, 'Memory on'), h('small', { class: 'hint', style: 'display:block' }, 'Stored on this machine only (memory.json in the Apiary folder).'))),
    h('div', { class: 'kv', style: 'margin-bottom:10px' }, q, sel), out);
  load();
}

async function takeOver(a) {
  const { command } = await api(`/api/agents/${a.id}/takeover`, 'POST', {});
  const dlg = h('dialog', {}, h('form', { method: 'dialog' }, h('h2', {}, `Take over ${a.name}`),
    h('p', {}, 'The agent has been stopped so only one of you writes at a time. Paste this into a terminal to continue the same session yourself:'),
    cmdBox(command), h('p', { class: 'hint' }, 'When you are done, come back and message the agent here to hand it back.'),
    h('div', { class: 'dlg-actions' }, h('button', { class: 'btn primary' }, 'Done'))));
  document.body.append(dlg); dlg.addEventListener('close', () => dlg.remove()); dlg.showModal();
}
function openPrDialog(lead) {
  const title = h('input', { type: 'text', value: lead.name }), body = h('textarea', { rows: '4', placeholder: 'What changed and why (optional)' });
  const go = h('button', { class: 'btn primary', type: 'button' }, 'Open pull request');
  const dlg = h('dialog', {}, h('form', { method: 'dialog' }, h('h2', {}, 'Open a pull request'),
    h('p', { class: 'hint' }, `Pushes ${lead.git.branch} and opens a PR into ${lead.git.base} using your GitHub connection.`),
    h('label', { class: 'f' }, 'Title', title), h('label', { class: 'f' }, 'Description', body),
    h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', value: 'cancel' }, 'Cancel'), go)));
  go.onclick = guard(async () => { go.disabled = true; go.textContent = 'Opening…'; try { const r = await api(`/api/agents/${lead.id}/pr`, 'POST', { title: title.value, body: body.value }); toast('Pull request opened'); dlg.close(); window.open(r.url, '_blank', 'noopener'); } finally { go.disabled = false; go.textContent = 'Open pull request'; } });
  document.body.append(dlg); dlg.addEventListener('close', () => dlg.remove()); dlg.showModal();
}

// ---------- new project dialog ----------
async function openNewProject() {
  if (!S.conns) await refreshConns();
  const st = { approvals: S.approvalsDefault, src: 'empty', ai: S.providers.find((p) => p.id === S.defaultProvider)?.id || S.providers.find((p) => p.id !== 'mock')?.id || S.providers[0]?.id || '', access: 'safe', repo: '', branches: [], base: '', team: '' };
  const goal = h('textarea', { rows: '4', placeholder: 'e.g. Add dark mode to the settings page and write tests', 'aria-label': 'Goal' });
  const name = h('input', { type: 'text', placeholder: 'Optional — defaults to your goal' });
  const sourceBox = h('div'), aiBox = h('div'), accBox = h('div'), err = h('p', { class: 'hint', style: 'color:var(--err);min-height:20px', role: 'alert' });
  const folder = h('input', { type: 'text', placeholder: '/home/you/projects/my-app' });
  const choice = (opts, key, redraw) => h('div', { class: 'choice' }, opts.map(([v, t, s]) => h('button', { type: 'button', 'aria-pressed': String(st[key] === v), onclick: () => { st[key] = v; redraw(); } }, h('b', {}, t), h('small', {}, s))));
  const drawAI = () => aiBox.replaceChildren(S.providers.filter((p) => p.id !== 'mock' || S.providers.length === 1 || true).length
    ? choice(S.providers.map((p) => [p.id, p.label, p.method === 'api' ? 'Web · API key' : 'Terminal']), 'ai', drawAI)
    : h('p', { class: 'hint' }, 'No AI connected yet. Open Connections first.'));
  const teamBox = h('div');
  const drawTeamPick = () => teamBox.replaceChildren(choice([['', 'Just a lead', 'It proposes hires when it needs them'], ...(S.teams || []).map((t) => [t.id, t.name, `${t.members.length} ready members`])], 'team', drawTeamPick));
  const drawAcc = () => accBox.replaceChildren(choice([['safe', 'Safe', 'Edits files in its folder; no unrestricted commands'], ['full', 'Full access', 'Runs any command without asking']], 'access', drawAcc));
  async function drawSource() {
    const ghOk = S.conns?.find((c) => c.id === 'github')?.status?.ok;
    const parts = [choice([['empty', 'Empty workspace', 'A fresh folder'], ['folder', 'Local folder', 'A folder or git repo on this machine'], ['github', 'GitHub repository', ghOk ? 'Pick from your repos' : 'Connect GitHub first']], 'src', drawSource)];
    if (st.src === 'folder') parts.push(h('label', { class: 'f' }, 'Folder path', folder, h('small', {}, 'If it is a git repository, every agent works on its own branch and your checkout stays untouched.')));
    if (st.src === 'github') {
      if (!ghOk) parts.push(h('p', { class: 'hint' }, 'GitHub is not connected. ', h('a', { href: '#/connections/github', style: 'text-decoration:underline', onclick: () => dlg.close() }, 'Connect it')));
      else {
        const q = h('input', { type: 'text', placeholder: 'Search your repositories or type owner/name', 'aria-label': 'Search repositories', value: st.repo });
        const list = h('div', { class: 'repo-list' }), br = h('div');
        const drawBr = () => br.replaceChildren(st.branches.length ? h('label', { class: 'f' }, 'Branch', h('select', { onchange: (e) => (st.base = e.target.value) }, st.branches.map((b) => h('option', { value: b, selected: b === st.base }, b)))) : null);
        const pick = guard(async (r) => { st.repo = r.name; q.value = r.name; st.base = r.defaultBranch; st.branches = await api('/api/github/branches?repo=' + encodeURIComponent(r.name)).catch(() => [r.defaultBranch]); drawList(); drawBr(); });
        let repos = [];
        const drawList = () => list.replaceChildren(...(repos.length ? repos : [{ name: 'Loading…' }]).filter((r) => r.name.toLowerCase().includes(q.value.toLowerCase()) || r.name === 'Loading…').slice(0, 50).map((r) => h('button', { type: 'button', 'aria-pressed': String(r.name === st.repo), onclick: () => r.defaultBranch && pick(r) }, h('span', { style: 'flex:1' }, r.name), r.private ? h('span', { class: 'pill' }, 'private') : null)));
        q.oninput = () => { st.repo = q.value.trim(); drawList(); };
        parts.push(h('label', { class: 'f' }, 'Repository', q), list, br); drawList(); drawBr();
        api('/api/github/repos').then((r) => { repos = r; drawList(); }).catch((e) => { repos = []; list.replaceChildren(h('p', { class: 'hint', style: 'padding:10px' }, e.message)); });
      }
    }
    sourceBox.replaceChildren(...parts);
  }
  const appr = h('input', { type: 'checkbox', checked: st.approvals, 'aria-label': 'Ask me before agents create sub-agents or merge changes' });
  const go = h('button', { class: 'btn primary big', type: 'button' }, 'Start project');
  const dlg = h('dialog', { 'aria-label': 'New project' }, h('form', { method: 'dialog' }, h('h2', { style: 'font-size:20px' }, 'New project'),
    h('label', { class: 'f' }, 'What should the team do?', goal), h('label', { class: 'f' }, 'Project name', name),
    h('div', { class: 'f' }, 'Your CEO uses'), aiBox, h('div', { class: 'f' }, 'Where does the work happen?'), sourceBox, h('div', { class: 'f' }, 'Start with a team?'), teamBox, h('div', { class: 'f' }, 'Access'), accBox, h('label', { class: 'check' }, appr, h('span', {}, h('b', {}, 'Ask me before agents create sub-agents or merge changes'), h('small', { class: 'hint', style: 'display:block' }, 'Recommended. You can review exactly what will happen first.'))), err,
    h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', value: 'cancel' }, 'Cancel'), go)));
  go.onclick = async () => {
    err.textContent = '';
    if (!st.ai) { err.textContent = 'Connect an AI first (Connections).'; return; }
    if (!goal.value.trim() && !name.value.trim()) { err.textContent = 'Describe what you want done.'; return; }
    const body = { provider: st.ai, goal: goal.value.trim(), name: name.value.trim(), access: st.access, approvals: appr.checked };
    if (st.team) body.team = st.team;
    if (st.src === 'folder') { if (!folder.value.trim()) { err.textContent = 'Enter a folder path.'; return; } body.source = folder.value.trim(); }
    if (st.src === 'github') { if (!st.repo) { err.textContent = 'Choose a repository.'; return; } body.source = st.repo; if (st.base) body.base = st.base; }
    go.disabled = true; go.textContent = st.src === 'github' ? 'Cloning…' : 'Starting…';
    try { const a = await api('/api/agents', 'POST', body); if (!S.agents.some((x) => x.id === a.id)) S.agents.push(a); dlg.close(); location.hash = `#/project/${a.id}`; }
    catch (e) { err.textContent = e.message; go.disabled = false; go.textContent = 'Start project'; }
  };
  document.body.append(dlg); dlg.addEventListener('close', () => dlg.remove());
  drawAI(); drawTeamPick(); drawAcc(); drawSource(); dlg.showModal(); goal.focus();
}

// ---------- terminal sessions ----------
function pageTerminals() {
  crumbs('Workspace', 'Terminal sessions');
  const draw = () => view.replaceChildren(
    h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Terminal sessions'), h('p', { class: 'sub-title' }, 'Every agent that runs through a terminal CLI. Take over any of them in your own terminal.'))),
    h('div', { class: 'card scroll-x', style: 'padding:0' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Agent', 'AI', 'Status', 'Folder', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, S.agents.filter((a) => a.method !== 'api').map((a) => h('tr', {}, h('td', {}, h('b', {}, a.name)), h('td', {}, PNAME[a.provider] || a.provider), h('td', {}, pill(a.status)), h('td', { class: 'mono hint' }, a.cwd),
        h('td', {}, h('div', { class: 'kv' }, h('a', { class: 'btn', href: `#/project/${rootOf(a).id}`, onclick: () => (S.sel = a.id) }, 'Open'), h('button', { class: 'btn', onclick: guard(() => takeOver(a)) }, 'Take over'))))))),
      S.agents.length ? null : h('div', { class: 'empty' }, 'No sessions yet.')),
    h('div', { class: 'card' }, h('h2', {}, 'Watch from a terminal'), h('p', { class: 'hint' }, 'Read-only live log of any agent:'), cmdBox('apiary attach <agent-name>')));
  draw(); page = { update: (ev) => ev.type === 'agent' && draw() };
}

// ---------- agents ----------
function pageAgents() {
  crumbs('Agents', 'All agents');
  const draw = () => {
    const rows = []; const walk = (a, d) => { rows.push([a, d]); kidsOf(a.id).forEach((k) => walk(k, d + 1)); }; S.agents.filter((a) => !a.parentId).sort((a, b) => (b.kind === 'general') - (a.kind === 'general') || a.createdAt - b.createdAt).forEach((l) => walk(l, 0));
    view.replaceChildren(h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'All agents'), h('p', { class: 'sub-title' }, `${S.agents.length} agents across ${S.agents.filter((a) => !a.parentId).length} ${S.agents.filter((a) => !a.parentId).length === 1 ? 'group' : 'groups'}.`))),
      rows.length ? h('div', { class: 'card scroll-x', style: 'padding:0' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Name', 'Role', 'AI', 'Via', 'Status', 'Branch'].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows.map(([a, d]) => h('tr', {}, h('td', { style: `padding-left:${16 + d * 22}px` }, h('a', { href: `#/project/${rootOf(a).id}`, onclick: () => (S.sel = a.id), style: 'font-weight:600' }, a.name)), h('td', { class: 'hint' }, a.role), h('td', {}, PNAME[a.provider] || a.provider), h('td', {}, a.method === 'api' ? 'Web' : 'Terminal'), h('td', {}, pill(a.status)), h('td', { class: 'mono hint' }, a.git?.branch || '—')))))) : h('div', { class: 'card empty' }, 'No agents yet.'));
  };
  draw(); page = { update: (ev) => ['agent', 'removed'].includes(ev.type) && draw() };
}

function pageTemplates() {
  crumbs('Agents', 'Saved agents');
  const draw = async () => {
    const defs = await api('/api/defs'); S.defs = defs;
    view.replaceChildren(h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Saved agents'), h('p', { class: 'sub-title' }, 'Reusable specialists. Any agent can call one by name when it delegates.')), h('button', { class: 'btn primary big', onclick: () => editDef() }, svg(ICON.plus, 16, 2.2), 'New saved agent')),
      defs.length ? h('div', { class: 'grid' }, defs.map((d) => h('div', { class: 'card' }, h('b', {}, d.name), h('p', { class: 'hint', style: 'margin:6px 0' }, d.role || 'No role set'), h('p', { class: 'hint' }, d.provider ? `Always uses ${PNAME[d.provider]}` : 'Uses the caller’s AI'),
        h('div', { class: 'kv', style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: () => editDef(d) }, 'Edit'), h('button', { class: 'btn danger', onclick: guard(async () => { await api('/api/defs/' + d.id, 'DELETE'); draw(); }) }, 'Delete'))))) : h('div', { class: 'card empty' }, 'No saved agents yet. Try a “Reviewer” or “Test writer”.'));
  };
  function editDef(d = null) {
    const f = { name: h('input', { type: 'text', value: d?.name || '' }), role: h('input', { type: 'text', value: d?.role || '', placeholder: 'What is it good at?' }), provider: h('select', {}, h('option', { value: '' }, 'Same as the agent that calls it'), S.providers.filter((p) => p.id !== 'mock').map((p) => h('option', { value: p.id, selected: d?.provider === p.id }, p.label))), model: h('input', { type: 'text', value: d?.model || '', placeholder: 'Optional model override' }), instructions: h('textarea', { rows: '5', placeholder: 'Standing instructions, e.g. “Review for security issues first.”' }, d?.instructions || '') };
    f.instructions.value = d?.instructions || '';
    const err = h('p', { class: 'hint', style: 'color:var(--err)', role: 'alert' });
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Save');
    const dlg = h('dialog', {}, h('form', { method: 'dialog' }, h('h2', {}, d ? 'Edit saved agent' : 'New saved agent'), h('label', { class: 'f' }, 'Name', f.name), h('label', { class: 'f' }, 'Role', f.role), h('label', { class: 'f' }, 'AI', f.provider), h('label', { class: 'f' }, 'Model', f.model), h('label', { class: 'f' }, 'Instructions', f.instructions), err, h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', value: 'cancel' }, 'Cancel'), save)));
    save.onclick = async () => { try { const b = Object.fromEntries(Object.entries(f).map(([k, e]) => [k, e.value])); await api(d ? '/api/defs/' + d.id : '/api/defs', d ? 'PUT' : 'POST', b); dlg.close(); draw(); } catch (e) { err.textContent = e.message; } };
    document.body.append(dlg); dlg.addEventListener('close', () => dlg.remove()); dlg.showModal();
  }
  draw().catch((e) => toast(e.message, true));
}

function pageRules() {
  crumbs('Agents', 'Delegation rules');
  const L = S.limits;
  const field = (k, label, help) => ({ k, el: h('input', { type: 'number', value: L[k], min: '0', max: '40', 'aria-label': label }), node: (el) => h('label', { class: 'f' }, label, el, h('small', {}, help)) });
  const fs = [field('maxDepth', 'How deep the team can go', '1 = the lead can create sub-agents, 2 = they can create their own. Lower is simpler and cheaper.'), field('maxAgents', 'Maximum agents per project', 'A hard cap on the whole team, including the lead.'), field('maxRounds', 'Delegation rounds per message', 'How many times the lead may hand out work and read reports before it must answer.'), field('maxPeerMessages', 'Agent-to-agent messages per project', 'How many messages agents may send each other. 0 turns teammate messaging off.')];
  const appr = h('input', { type: 'checkbox', checked: S.approvalsDefault, 'aria-label': 'Ask before agents create sub-agents or merge changes' });
  view.replaceChildren(h('h1', {}, 'Delegation rules'), h('p', { class: 'sub-title' }, 'Guard rails that keep teams small and costs predictable.'),
    h('div', { class: 'card', style: 'max-width:640px' }, h('label', { class: 'check', style: 'margin-bottom:18px' }, appr, h('span', {}, h('b', {}, 'Ask me first (default for new projects)'), h('small', { class: 'hint', style: 'display:block' }, 'Approve or deny new sub-agents and merges of their work. You can change this per project when you create it.'))),
      fs.map((f) => f.node(f.el)), h('button', { class: 'btn primary', onclick: guard(async () => { const r = await api('/api/settings', 'PUT', { approvalsDefault: appr.checked, limits: Object.fromEntries(fs.map((f) => [f.k, Number(f.el.value)])) }); S.limits = r.limits; S.approvalsDefault = r.approvalsDefault; toast('Saved'); }) }, 'Save')));
}

// ---------- connections ----------
const CINFO = {
  claude: { title: 'Claude Code', login: 'claude', install: 'curl -fsSL https://claude.ai/install.sh | bash', key: 'Anthropic API key', keyUrl: 'console.anthropic.com' },
  codex: { title: 'Codex', login: 'codex login', install: 'npm install -g @openai/codex', key: 'OpenAI API key', keyUrl: 'platform.openai.com' },
  github: { title: 'GitHub', login: 'gh auth login', install: 'See cli.github.com', key: 'Personal access token' },
  gh: { title: 'GitHub tool', login: 'gh auth login', install: 'See cli.github.com' },
};
// Sign in to GitHub from the page: the person gets a short code, types it at github.com, and Apiary waits.
function ghSignIn(c, onDone = () => route()) {
  const box = h('div', {}); let timer = null, shownDone = false;
  const redraw = () => { timer = null; onDone(); };
  const poll = async () => {
    if (!box.isConnected) return;
    let st; try { st = await api('/api/github/login'); } catch { timer = setTimeout(poll, 2500); return; }
    draw(st);
    if (st.state === 'waiting' || st.state === 'starting') timer = setTimeout(poll, 1500);
    else if (st.state === 'done' && !shownDone) { shownDone = true; toast('Signed in to GitHub'); refreshConns().then(redraw); }
  };
  const start = guard(async () => { box.replaceChildren(h('p', { class: 'hint', role: 'status' }, 'Getting a code from GitHub…')); draw(await api('/api/github/login', 'POST')); clearTimeout(timer); timer = setTimeout(poll, 1200); });
  const signInBtn = (label) => h('button', { class: 'btn primary big', onclick: start }, label);
  const draw = (st) => {
    if (st.state === 'waiting' || st.state === 'starting') {
      box.replaceChildren(
        h('p', { style: 'margin:0 0 6px' }, h('b', {}, '1.'), ' Open GitHub and type this code:'),
        h('div', { class: 'cmd mono', style: 'justify-content:center;font-size:1.7em;letter-spacing:.14em' }, h('code', { 'aria-label': 'One-time code' }, st.code || '…'), st.code ? h('button', { type: 'button', onclick: () => copy(st.code) }, 'Copy') : null),
        h('div', { class: 'kv', style: 'margin:10px 0' }, h('a', { class: 'btn primary', href: st.url || 'https://github.com/login/device', target: '_blank', rel: 'noopener' }, 'Open github.com'),
          h('button', { class: 'btn', onclick: guard(async () => { await api('/api/github/login', 'DELETE'); clearTimeout(timer); draw({ state: 'idle' }); }) }, 'Cancel')),
        h('p', { class: 'hint', role: 'status' }, h('b', {}, '2.'), ' Approve it on GitHub. This page updates by itself.'));
    } else if (st.state === 'failed') {
      box.replaceChildren(h('p', { class: 'pill err', role: 'alert', style: 'white-space:normal' }, st.message || 'The sign-in did not finish.'), h('div', { class: 'kv', style: 'margin-top:8px' }, signInBtn('Try again')));
    } else if (st.state === 'done') {
      box.replaceChildren(h('p', { class: 'hint', role: 'status' }, 'Signed in. Checking…'));
    } else box.replaceChildren(signInBtn('Sign in with GitHub'), h('p', { class: 'hint' }, 'GitHub shows a short code. You type it on github.com and press approve. Apiary never sees your password.'));
  };
  draw({ state: 'idle' }); poll();
  return box;
}
function connCard(c, full = false) {
  const info = CINFO[c.id], isGh = c.id === 'github', webM = isGh ? 'token' : 'api';
  const ok = isGh ? c.status?.ok : c.ready;
  const key = h('input', { type: 'password', autocomplete: 'off', placeholder: (isGh ? c.token : c.api).saved ? `Saved ${(isGh ? c.token : c.api).hint} — type to replace` : isGh ? 'ghp_… or github_pat_…' : 'Paste key', 'aria-label': info.key });
  const model = isGh ? null : h('input', { type: 'text', value: c.api.model || '', placeholder: c.id === 'codex' ? 'Model name (required for web)' : 'claude-sonnet-5-5' });
  const result = h('p', { class: 'hint', role: 'status' });
  const setMethod = guard(async (m) => { await api('/api/connections/' + c.id, 'PUT', { method: m }); await refreshConns(); route(); });
  const ghBody = () => h('div', {},
    c.status?.ok ? h('p', {}, h('span', { class: 'pill ok' }, `Signed in as ${c.status.account || 'unknown'}`)) : null,
    !c.cli.found
      ? h('div', {}, h('p', {}, 'Apiary needs the free GitHub tool to sign in. It installs for this user only, with no password needed.'), h('div', { class: 'kv' }, installBtn('gh', () => route(), 'Install GitHub tool for me')),
          h('p', { class: 'hint' }, 'Prefer to do it yourself? See cli.github.com, or switch to Web · token above.'))
      : c.status?.ok ? null : ghSignIn(c),
    c.cli.found && c.cli.version ? h('p', { class: 'hint mono' }, c.cli.version) : null,
    c.cli.found && !c.status?.ok && c.status?.reason && !/Not signed in/.test(c.status.reason) ? h('p', { class: 'hint' }, c.status.reason) : null,
    h('details', { style: 'margin-top:10px' }, h('summary', { class: 'hint' }, 'Prefer the terminal?'), h('p', { class: 'hint' }, 'Run this once. Apiary reuses the login:'), cmdBox(info.login)));
  const body = isGh && c.method === 'cli' ? ghBody() : c.method === 'cli'
    ? h('div', {}, h('p', {}, c.cli.found ? h('span', {}, h('span', { class: 'pill ok' }, 'Found'), ' ', h('span', { class: 'mono hint' }, `${c.cli.path}${c.cli.version ? ' · ' + c.cli.version : ''}`)) : h('span', {}, h('span', { class: 'pill err' }, 'Not installed'))),
      c.cli.found ? null : h('div', {}, isGh ? null : h('div', { class: 'kv', style: 'margin-bottom:6px' }, installBtn(c.id, () => route())), h('p', { class: 'hint' }, isGh ? 'Install it:' : 'Or run it yourself:'), cmdBox(info.install)),
      h('p', { class: 'hint' }, isGh ? 'Sign in once in a terminal. Apiary reuses that login:' : 'Log in once in a terminal. Apiary reuses that login — no key needed:'), cmdBox(info.login),
      isGh && c.status ? h('p', { class: 'hint' }, c.status.ok ? `Signed in as ${c.status.account || 'unknown'}` : c.status.reason) : null)
    : h('div', {}, h('label', { class: 'f' }, info.key, key, h('small', {}, isGh ? h('span', {}, 'Needs “repo” access. Stored only on this machine in a private file. ', h('a', { href: 'https://github.com/settings/tokens/new?scopes=repo&description=Apiary', target: '_blank', rel: 'noopener', style: 'text-decoration:underline' }, 'Create one on GitHub (the form is filled in for you)')) : `From ${info.keyUrl}. Stored only on this machine in a private file. Web agents can chat but cannot edit files.`)), model ? h('label', { class: 'f' }, 'Model', model) : null,
      h('button', { class: 'btn', onclick: guard(async () => { const p = { method: webM }; if (key.value) p[isGh ? 'token' : 'apiKey'] = key.value; if (model) p.model = model.value; await api('/api/connections/' + c.id, 'PUT', p); toast('Saved'); await refreshConns(); route(); }) }, 'Save'));
  return h('div', { class: 'card' },
    h('div', { class: 'kv', style: 'justify-content:space-between;margin-bottom:14px' }, h('h2', { style: 'margin:0' }, info.title), h('span', { class: 'pill ' + (ok ? 'ok' : 'err') }, ok ? 'Connected' : 'Not connected')),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Connection method', style: 'margin-bottom:16px' },
      h('button', { 'aria-pressed': String(c.method === 'cli'), onclick: () => c.method !== 'cli' && setMethod('cli') }, isGh ? 'Sign in' : 'Terminal'),
      h('button', { 'aria-pressed': String(c.method === webM), onclick: () => c.method !== webM && setMethod(webM) }, isGh ? 'Web · token' : 'Web · API key')),
    body,
    h('div', { class: 'kv', style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: guard(async (e) => { const b = e.currentTarget; b.disabled = true; result.textContent = 'Testing…'; try { const r = await api(`/api/connections/${c.id}/test`, 'POST', {}); result.textContent = r.ok ? '✔ ' + r.detail : '✘ ' + r.error; result.style.color = r.ok ? 'var(--ok-text)' : 'var(--err)'; } finally { b.disabled = false; } }) }, 'Test connection'), result));
}
function pageConnections() {
  crumbs('Connections', 'Overview');
  view.replaceChildren(h('h1', {}, 'Connections'), h('p', { class: 'sub-title' }, 'Connect each service through your terminal or through the web. You can mix them.'), h('div', { class: 'hint' }, 'Loading…'));
  refreshConns().then(() => view.replaceChildren(h('h1', {}, 'Connections'), h('p', { class: 'sub-title' }, 'Connect each service through your terminal or through the web. You can mix them.'), getStartedCard(() => pageConnections()) || h('span'), h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(340px,1fr))' }, S.conns.map((c) => connCard(c)))));
}
function pageConnection(id) {
  crumbs('Connections', CINFO[id].title);
  refreshConns().then(() => view.replaceChildren(h('h1', {}, CINFO[id].title), h('p', { class: 'sub-title' }, 'Choose how Apiary reaches it.'), h('div', { style: 'max-width:640px' }, connCard(S.conns.find((c) => c.id === id)))));
}

// ---------- shared helpers for the 0.6.0 pages ----------
const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n || 0));
// ---------- chat bubbles ----------
const CB_COLOURS = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#db2777', '#0891b2', '#dc2626', '#4f46e5', '#65a30d', '#c2410c'];
const colourOf = (id) => { let x = 0; for (const c of String(id || '')) x = (x * 31 + c.charCodeAt(0)) >>> 0; return CB_COLOURS[x % CB_COLOURS.length]; };
const timeOf = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
// Task codes (T-0012) become links to the task. The index maps codes to task ids and is refreshed as needed.
const taskIdx = { map: {}, at: 0, loading: false };
async function loadTaskIndex() {
  if (taskIdx.loading) return;
  taskIdx.loading = true;
  try { const r = await api('/api/tasks'); taskIdx.map = Object.fromEntries((r.tasks || []).map((t) => [t.code, t.id])); } catch { /* keep the old index */ }
  taskIdx.at = Date.now(); taskIdx.loading = false;
}
function refreshTaskIndex() { if (!taskIdx.loading && Date.now() - taskIdx.at > 4000) loadTaskIndex().then(() => { const f = window.__drawChat; if (f) f(); }); }
function linkify(text) {
  const str = String(text ?? ''), out = [];
  let last = 0;
  for (const m of str.matchAll(/\bT-\d{4,}\b/g)) {
    out.push(str.slice(last, m.index));
    const id = taskIdx.map[m[0]];
    out.push(id ? h('a', { class: 'cb-task', href: `#/task/${id}`, title: 'Open this task' }, m[0]) : m[0]);
    last = m.index + m[0].length;
  }
  out.push(str.slice(last));
  return out;
}
// side: 'me' (yours, right) or 'them' (an agent, left, in its colour)
function bubble(side, who, colour, time, body) {
  const bub = h('div', { class: 'cb-bub', style: side === 'them' ? `--c:${colour}` : '' },
    who ? h('div', { class: 'cb-who', style: `color:${colour}` }, who) : null,
    h('div', { class: 'cb-text' }, ...(Array.isArray(body) ? body : [body])),
    time ? h('small', { class: 'cb-time' }, time) : null);
  return side === 'me' ? h('div', { class: 'cb-row me' }, bub)
    : h('div', { class: 'cb-row them' }, h('span', { class: 'cb-av', style: `background:${colour}` }, initials(who)), bub);
}

const debounce = (fn, ms = 700) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const dlgOpen = (title, ...body) => { const d = h('dialog', {}, h('form', { method: 'dialog' }, h('h2', {}, title), ...body)); document.body.append(d); d.addEventListener('close', () => d.remove()); d.showModal(); return d; };

// ---------- usage numbers shown next to the connections ----------
async function loadUsage() { try { S.usage = await api('/api/usage?days=14'); const l = await api('/api/provider-usage'); S.reported = l.limits; if (l.pending?.length) setTimeout(loadUsage, 4000); renderSide(); } catch { /* not ready */ } }
setInterval(() => { if (!document.hidden) loadUsage(); }, 60000);
const untilText = (iso) => { const m = Math.round((Date.parse(iso) - Date.now()) / 60000); if (!(m > 0)) return 'resets soon'; if (m < 90) return `resets in ${m} min`; if (m < 2880) return `resets in ${Math.round(m / 60)} h`; return `resets in ${Math.round(m / 1440)} days`; };
const refreshBtn = (id) => h('button', { type: 'button', class: 'icon-btn' + (S.refreshing?.has(id) ? ' spin' : ''), 'aria-label': `Refresh ${PNAME[id] || id} usage`, title: 'Refresh usage now', disabled: S.refreshing?.has(id) || null, onclick: async () => {
  (S.refreshing ||= new Set()).add(id); renderSide();
  try { const l = await api('/api/provider-usage/refresh', 'POST', { id }); S.reported = l.limits; } catch (e) { toast(e.message, true); }
  S.refreshing.delete(id); renderSide(); if (cur() === '#/usage') pageUsage();
} }, '↻');
function reportedLine(id, R) {
  const old = R.source === 'last-session';
  return h('div', { class: 'ulines' },
    ...R.windows.map((w) => { const tone = w.pct >= 100 ? 'err' : w.pct >= 80 ? 'warn' : 'ok';
      return h('div', { class: 'uwin' },
        h('div', { class: 'urow' }, h('small', {}, w.label, w.resetsAt && !w.reset ? h('span', { class: 'hint' }, ` · ${untilText(w.resetsAt)}`) : w.reset ? h('span', { class: 'hint' }, ' · reset since') : null), h('small', { class: tone === 'ok' ? '' : tone }, `${Math.round(w.pct)}%`)),
        h('div', { class: 'ubar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(w.pct)), 'aria-label': `${PNAME[id] || id} ${w.label} usage` }, h('span', { class: tone, style: `width:${Math.min(100, w.pct)}%` })),
      ); }),
    h('div', { class: 'uscale', 'aria-hidden': 'true' }, h('span', {}, '0%'), h('span', {}, '100%')),
    h('div', { class: 'urow' }, h('small', { class: 'hint' }, old ? `From ${PNAME[id]}'s own records, ${ago(Date.parse(R.asOf))}` : `From ${PNAME[id]}${R.plan ? ` (${R.plan})` : ''}, ${ago(R.fetchedAt)}`), refreshBtn(id)),
    old && R.note ? h('small', { class: 'hint' }, R.note) : null);
}
function usageLine(id) {
  const R = S.reported?.[id];
  if (R?.ok) return reportedLine(id, R);
  if (!S.usage) return null;
  const p = S.usage.providers.find((x) => x.id === id) || { id, today: 0, week: 0 };
  const pct = p.pctDay ?? p.pctWeek, lim = p.pctDay != null ? p.daily : p.weekly, used = p.pctDay != null ? p.today : p.week;
  const tone = p.hitAt || (pct != null && pct >= 1) ? 'err' : pct != null && pct >= 0.8 ? 'warn' : 'ok';
  return h('div', { class: 'ulines' },
    h('div', { class: 'ubar' + (pct == null ? ' nolimit' : ''), role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct == null ? 0 : Math.min(100, Math.round(pct * 100))), 'aria-label': `${PNAME[id] || id} usage, 0 to 100 percent` }, h('span', { class: tone, style: `width:${pct == null ? 0 : Math.min(100, Math.round(pct * 100))}%` })),
    h('div', { class: 'uscale', 'aria-hidden': 'true' }, h('span', {}, '0%'), h('span', {}, pct == null ? '' : `${Math.min(100, Math.round(pct * 100))}%`), h('span', {}, '100%')),
    h('small', { class: tone === 'ok' ? '' : tone }, p.hitAt ? 'Limit reached. Wait a while.' : pct != null ? `${fmtTok(used)} of ${fmtTok(lim)} ${p.pctDay != null ? 'today' : 'this week'}${pct >= 0.8 ? ' · nearly full' : ''}` : `${fmtTok(p.today)} today${p.estimated ? ' (estimated)' : ''}. ` , h('a', { href: '#/usage', style: 'text-decoration:underline' }, 'Set a limit to see the %')),
    h('div', { class: 'urow' }, h('small', { class: 'hint' }, R?.error ? `Not the provider's number: ${R.error}` : 'Counted by Apiary only. Checking with the provider…'), refreshBtn(id)));
}

// ---------- usage page: tokens per agent ----------
const PALETTE = ['#f6b73c', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];
function pageUsage() {
  crumbs('Connections', 'Usage');
  const draw = async () => {
    const u = await api('/api/usage?days=14'); S.usage = u; renderSide();
    const top = u.agents.slice(0, 7), colorOf = new Map(top.map((a, i) => [a.id, PALETTE[i]]));
    const W = 760, H = 240, L = 44, B = 28, T = 10, bw = (W - L - 8) / u.series.length;
    const max = Math.max(1, ...u.series.map((d) => d.total)), nice = (() => { const e = Math.pow(10, Math.floor(Math.log10(max))); return Math.ceil(max / e) * e; })();
    const NS = 'http://www.w3.org/2000/svg', el = (t, a = {}, ...kids) => { const n = document.createElementNS(NS, t); for (const [k, v] of Object.entries(a)) n.setAttribute(k, v); kids.forEach((c) => n.append(c)); return n; };
    const chart = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Tokens used per day, split by agent', style: 'width:100%;height:auto' });
    for (let i = 0; i <= 4; i++) { const y = T + (H - B - T) * (1 - i / 4); chart.append(el('line', { x1: L, x2: W, y1: y, y2: y, stroke: 'currentColor', 'stroke-opacity': '.12' }), el('text', { x: L - 6, y: y + 4, 'text-anchor': 'end', 'font-size': '11', fill: 'currentColor', 'fill-opacity': '.65' }, fmtTok(Math.round(nice * i / 4)))); }
    u.series.forEach((d, i) => {
      let y = H - B; const x = L + i * bw + 3, sc = (H - B - T) / nice;
      const parts = [...top.map((a) => [a, d.byAgent[a.id] || 0]), [{ name: 'Others' }, d.total - top.reduce((s, a) => s + (d.byAgent[a.id] || 0), 0)]];
      for (const [a, v] of parts) { if (v <= 0) continue; const hh = Math.max(1, v * sc); y -= hh; chart.append(el('rect', { x, y, width: Math.max(2, bw - 6), height: hh, fill: colorOf.get(a.id) || '#94a3b8', rx: 2 }, el('title', {}, `${d.date}: ${a.name} ${fmtTok(v)}`))); }
      if (i % 2 === 0 || u.series.length < 9) chart.append(el('text', { x: x + (bw - 6) / 2, y: H - 8, 'text-anchor': 'middle', 'font-size': '11', fill: 'currentColor', 'fill-opacity': '.65' }, d.date.slice(5)));
    });
    const total = u.agents.reduce((s, a) => s + a.total, 0);
    const lim = {};
    const rows = u.providers.map((p) => {
      const d = h('input', { type: 'number', min: '0', step: '1000', value: p.daily || '', placeholder: 'No limit', 'aria-label': `${PNAME[p.id] || p.id} daily limit in tokens`, style: 'width:130px' }), w = h('input', { type: 'number', min: '0', step: '1000', value: p.weekly || '', placeholder: 'No limit', 'aria-label': `${PNAME[p.id] || p.id} weekly limit in tokens`, style: 'width:130px' });
      lim[p.id] = [d, w];
      return h('div', { class: 'card', style: 'margin-bottom:10px' }, h('div', { class: 'kv', style: 'justify-content:space-between' }, h('b', {}, PNAME[p.id] || p.id), h('span', { class: 'hint' }, `${fmtTok(p.today)} today · ${fmtTok(p.week)} this 7 days${p.estimated ? ' · partly estimated' : ''}`)), usageLine(p.id) || h('span'),
        p.hitAt ? h('p', { class: 'hint', style: 'color:var(--err)' }, `The AI said its limit was reached ${ago(p.hitAt)}.`) : null,
        h('div', { class: 'kv', style: 'margin-top:8px' }, h('label', { class: 'f', style: 'margin:0' }, 'Stay under per day', d), h('label', { class: 'f', style: 'margin:0' }, 'Stay under per week', w)));
    });
    view.replaceChildren(h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Usage'), h('p', { class: 'sub-title' }, 'How many tokens each agent has used in the last 14 days. A token is a small piece of text, roughly three-quarters of a word.'))),
      h('div', { class: 'card' }, h('h2', {}, 'Tokens per day'), total ? chart : h('p', { class: 'hint' }, 'Nothing has been used yet.'),
        h('div', { class: 'legend' }, [...top.map((a) => [a.name, colorOf.get(a.id)]), ...(u.agents.length > 7 ? [['Others', '#94a3b8']] : [])].map(([n, c]) => h('span', {}, h('i', { style: `background:${c}` }), n)))),
      h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', {}, 'By agent'), u.agents.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Agent', 'AI', 'In', 'Out', 'Total', 'Share'].map((x) => h('th', {}, x)))), h('tbody', {}, u.agents.map((a) => h('tr', {}, h('td', {}, a.name), h('td', {}, PNAME[a.provider] || a.provider), h('td', {}, fmtTok(a.input)), h('td', {}, fmtTok(a.output)), h('td', {}, h('b', {}, fmtTok(a.total))), h('td', {}, `${Math.round((a.total / total) * 100)}%`))))) : h('p', { class: 'hint' }, 'No agent has worked yet.')),
      h('h2', { style: 'margin-top:24px' }, 'Limits'), h('p', { class: 'hint' }, 'Apiary cannot see your plan\'s real limit, so set the number you want to stay under. Each AI\'s bar in the sidebar fills as you get close, and Apiary also notices when the AI itself says its limit is reached.'),
      rows.length ? rows : h('div', { class: 'card empty' }, 'No usage yet.'),
      rows.length ? h('button', { class: 'btn primary', onclick: guard(async () => { const limits = {}; for (const [id, [d, w]] of Object.entries(lim)) limits[id] = { daily: d.value, weekly: w.value }; await api('/api/usage/limits', 'PUT', { limits }); toast('Limits saved'); draw(); }) }, 'Save limits') : null,
      h('p', { class: 'hint', style: 'margin-top:16px' }, 'Numbers come from the AI when it reports them. Otherwise Apiary estimates (about 4 characters per token) and marks them as estimated. Cached input is not counted.'));
  };
  draw().catch((e) => toast(e.message, true)); page = { shows: () => true, update: debounce((ev) => { if (ev.type === 'agent' && ev.agent.status === 'idle') draw().catch(() => {}); }, 1500) };
}

// ---------- task board ----------
const TASK_COLS = [['backburner', 'Back burner', 'Unfinished ideas. Add detail later'], ['todo', 'To do', 'Ready: work can start'], ['inprogress', 'In progress', 'Someone is on it'], ['blocked', 'Blocked', 'Stuck. Needs a decision'], ['done', 'Done', 'Finished']];
function pageTasks() {
  crumbs('Workspace', 'Tasks');
  let tasks = [], showAllDone = false, agents = [];
  const load = async () => { [tasks, agents] = [(await api('/api/tasks')).tasks, await api('/api/tasks/agents').catch(() => [])]; draw(); };
  const agentSel = (value, label) => h('select', { 'aria-label': label }, agents.map((a) => h('option', { value: a.id, selected: a.id === value }, a.label + (a.ceo ? ' (default)' : ''))));
  const edit = (t) => {
    const title = h('input', { type: 'text', value: t.title, 'aria-label': 'Title' }), notes = h('textarea', { rows: '5', 'aria-label': 'Details' }); notes.value = t.notes || '';
    const labels = h('input', { type: 'text', value: t.labels.join(', '), 'aria-label': 'Labels' }), st = h('select', { 'aria-label': 'Status' }, TASK_COLS.map(([k, n]) => h('option', { value: k, selected: t.status === k }, n))), who = agentSel(t.assignee?.id, 'Who does it');
    const d = dlgOpen('Edit task', h('label', { class: 'f' }, 'Title', title), h('label', { class: 'f' }, 'Details', notes), h('label', { class: 'f' }, 'Labels (comma separated)', labels), h('label', { class: 'f' }, 'Status', st), h('label', { class: 'f' }, 'Who does it', who),
      t.log?.length ? h('details', {}, h('summary', {}, 'History'), h('ul', { class: 'hint' }, t.log.slice().reverse().map((l) => h('li', {}, `${new Date(l.at).toLocaleString()}: ${l.text}`)))) : null,
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn danger', value: 'x', onclick: (e) => { e.preventDefault(); guard(async () => { await api('/api/tasks/' + t.id, 'DELETE'); d.close(); load(); })(); } }, 'Delete'), h('span', { style: 'flex:1' }), h('button', { class: 'btn', value: 'c' }, 'Cancel'),
        h('button', { class: 'btn primary', value: 's', onclick: (e) => { e.preventDefault(); guard(async () => { await api('/api/tasks/' + t.id, 'PUT', { title: title.value, notes: notes.value, labels: labels.value, status: st.value, assignee: who.value }); d.close(); load(); })(); } }, 'Save')));
  };
  const card = (t) => h('div', { class: 'tcard' }, h('b', { class: 'ttl' }, h('span', { class: 'chip mono', title: 'Task ID', style: 'margin-right:6px' }, t.code || ''), h('a', { href: `#/task/${t.id}`, title: 'Open this task' }, t.title)),
    t.parentCode ? h('small', { class: 'hint', style: 'display:block' }, `Subtask of ${t.parentCode}`) : null,
    t.subtasks?.length ? h('small', { class: 'hint', style: 'display:block' }, (t.waitingFor.length ? `Waiting for ${t.waitingFor.join(', ')}. ` : 'All subtasks closed. '), t.subtasks.map((k) => `${k.code} ${k.assignee} (${k.status === 'done' ? 'closed' : k.status})`).join(' · ')) : null,
    t.closure ? h('small', { style: 'display:block;color:var(--ok-text);font-weight:600' }, t.closure) : null, t.notes ? h('p', { class: 'hint tnote' }, t.notes) : null,
    h('div', { class: 'chips' }, h('span', { class: `chip s-${t.status}` }, (TASK_COLS.find((c) => c[0] === t.status) || [0, t.status || 'Unknown'])[1]), t.labels.map((l) => h('span', { class: 'chip' }, l))),
    h('small', { class: 'hint' }, [t.source === 'human' ? '' : t.source === 'system' ? 'Added by Apiary' : t.source === 'ticket' ? 'From a ticket' : `Added by ${t.source}`, t.projectName ? `Project ${t.projectName}` : '', ago(t.updatedAt)].filter(Boolean).join(' · ')),
    (() => {
      const w = t.assignee && S.agents.find((a) => a.id === t.assignee.id);
      if (!w || t.status === 'done') return null;
      const live = [w, ...S.agents.filter((a) => a.parentId === w.id)].filter((a) => a.status === 'working' || a.status === 'waiting');
      return live.length ? h('div', { role: 'status', style: 'margin-top:8px' }, live.map((a) => h('div', { class: 'kv', style: 'gap:8px;align-items:center;margin:2px 0' }, h('span', { class: 'dot work pulse' }), h('span', { style: 'flex:1;min-width:0' }, `${a.name}: ${S.activity[a.id] || (a.status === 'waiting' ? 'waiting for the team' : 'working…')}`), h('button', { class: 'btn', onclick: () => openAgent(a.id) }, 'Watch')))) : null;
    })(),
    h('label', { class: 'hint', style: 'display:block;margin-top:8px' }, 'Responsible ', (() => { const x = agentSel(t.assignee?.id, `Who does "${t.title}"`); x.onchange = guard(async () => { await api('/api/tasks/' + t.id, 'PUT', { assignee: x.value }); load(); }); return x; })()),
    h('div', { class: 'kv', style: 'margin-top:8px' }, h('select', { 'aria-label': `Move "${t.title}"`, onchange: guard(async (e) => { await api('/api/tasks/' + t.id, 'PUT', { status: e.target.value }); load(); }) }, TASK_COLS.map(([k, n]) => h('option', { value: k, selected: t.status === k }, n))), t.status !== 'done' ? h('button', { class: 'btn', title: 'Send this task to the agent now', onclick: guard(async () => { const r = await api(`/api/tasks/${t.id}/start`, 'POST', {}); toast(`Sent to ${r.agent}. Follow it in their chat.`); load(); }) }, 'Start') : null, h('button', { class: 'btn', onclick: () => edit(t) }, 'Edit')));
  const draw = () => {
    const title = h('input', { type: 'text', placeholder: 'What needs doing, or what is the idea?', 'aria-label': 'New task title', onkeydown: (e) => { if (e.key === 'Enter') add.click(); } }), notes = h('input', { type: 'text', placeholder: 'More detail (optional)', 'aria-label': 'Details' }), labels = h('input', { type: 'text', placeholder: 'Labels, e.g. website, money', 'aria-label': 'Labels' });
    const st = h('select', { 'aria-label': 'Where does it go' }, h('option', { value: 'backburner' }, 'Back burner (unfinished idea)'), h('option', { value: 'todo' }, 'To do (ready to start)'));
    const who = agentSel(agents.find((a) => a.ceo)?.id, 'Who does it');
    const add = h('button', { class: 'btn primary', onclick: guard(async () => { await api('/api/tasks', 'POST', { title: title.value, notes: notes.value, labels: labels.value, status: st.value, assignee: who.value }); load(); }) }, 'Add');
    view.replaceChildren(h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Tasks'), h('p', { class: 'sub-title' }, 'Everything in one place. Agents add and move tasks as they work. Add your own: "Back burner" is an unfinished idea you will fill in later; "To do" is ready, so work on it can start.'))),
      h('div', { class: 'card', style: 'margin-bottom:16px' }, h('div', { class: 'formrow' }, title, st), h('div', { class: 'formrow', style: 'margin-top:8px' }, notes, labels, who, add)),
      h('div', { class: 'board' }, TASK_COLS.map(([k, name, sub]) => {
        let list = tasks.filter((t) => t.status === k); const more = k === 'done' && !showAllDone && list.length > 12; if (more) list = list.slice(0, 12);
        return h('section', { class: 'col', 'aria-label': name }, h('h3', {}, name, h('span', { class: 'count' }, String(tasks.filter((t) => t.status === k).length))), h('small', { class: 'hint' }, sub), list.length ? list.map(card) : h('p', { class: 'hint empty-col' }, 'Nothing here'), more ? h('button', { class: 'btn', onclick: () => { showAllDone = true; draw(); } }, 'Show all') : null);
      })));
  };
  load().catch((e) => toast(e.message, true)); page = { shows: () => true, update: debounce((ev) => { if (['agent', 'message'].includes(ev.type)) load().catch(() => {}); else if (ev.type === 'activity') draw(); }) };
}

// ---------- one task: read it, see its conversation, and carry on working on it ----------
async function pageTask(id) {
  crumbs('Workspace', 'Tasks', 'Task');
  // Built once: live updates redraw only the task and the conversation, never the message box.
  const info = h('div'), convo = h('div');
  const text = h('textarea', { rows: '3', 'aria-label': 'What to tell the agent next', placeholder: 'Tell the agent what to do next, or answer a question…' });
  let t = null, who = null;
  const send = h('button', { class: 'btn primary', onclick: guard(async () => {
    if (!who) { toast('Assign someone to this task first', true); return; }
    if (!text.value.trim()) { toast('Write a message first', true); return; }
    await api(`/api/agents/${who.id}/messages`, 'POST', { text: `About task ${t.code} "${t.title}": ${text.value.trim()}` });
    text.value = ''; toast(`Sent to ${who.name}`);
  }) }, 'Send');
  const start = h('button', { class: 'btn', onclick: guard(async () => { const r = await api(`/api/tasks/${t.id}/start`, 'POST'); toast(`${r.agent} is working on it`); load().catch(() => {}); }) }, 'Start work on this task');
  view.replaceChildren(h('p', {}, h('a', { href: '#/tasks' }, '← Back to Tasks')), info,
    h('div', { class: 'card', style: 'max-width:760px;margin-bottom:12px' }, h('h2', { style: 'margin-top:0' }, 'Continue working on this'),
      h('div', { class: 'formrow', style: 'flex-direction:column;align-items:stretch' }, text), h('div', { class: 'formrow', style: 'margin-top:8px;flex-wrap:wrap' }, send, start)),
    h('h3', {}, 'Conversation'), convo);
  const load = async () => {
    try { t = await api('/api/tasks/' + id); } catch (e) { info.replaceChildren(h('div', { class: 'card empty' }, e.message)); convo.replaceChildren(); return; }
    who = (t.assignee && S.agents.find((a) => a.id === t.assignee.id)) || null;
    const statusLabel = (TASK_COLS.find((c) => c[0] === t.status) || [0, t.status || 'Unknown'])[1];
    send.textContent = who ? `Send to ${who.name}` : 'Send';
    start.textContent = t.status === 'inprogress' ? 'Ask the agent to carry on' : 'Start work on this task';
    start.disabled = t.status === 'done';
    const statusSel = h('select', { 'aria-label': 'Status', onchange: guard(async (e) => { await api('/api/tasks/' + t.id, 'PUT', { status: e.target.value }); toast('Status updated'); load().catch(() => {}); }) }, TASK_COLS.map(([k, n]) => h('option', { value: k, selected: t.status === k }, n)));
    info.replaceChildren(
      h('h1', {}, h('span', { class: 'chip mono', style: 'margin-right:8px' }, t.code || ''), t.title),
      h('div', { class: 'chips' }, h('span', { class: `chip s-${t.status}` }, statusLabel), (t.labels || []).map((l) => h('span', { class: 'chip' }, l))),
      h('small', { class: 'hint', style: 'display:block;margin:6px 0 14px' }, [who ? `With ${who.name}` : 'Not assigned', t.projectName ? `Project ${t.projectName}` : '', t.source === 'human' ? '' : `Added by ${t.source}`, ago(t.updatedAt)].filter(Boolean).join(' · ')),
      h('div', { class: 'card', style: 'max-width:760px;margin-bottom:12px' }, h('h2', { style: 'margin-top:0' }, 'Details'), t.notes ? h('p', { style: 'white-space:pre-wrap' }, t.notes) : h('p', { class: 'hint' }, 'No details yet.'),
        t.closure ? h('p', { style: 'color:var(--ok-text);font-weight:600' }, t.closure) : null,
        h('label', { class: 'f', style: 'margin-top:8px' }, 'Status', statusSel)),
      t.subtasks?.length ? h('div', { class: 'card', style: 'max-width:760px;margin-bottom:12px' }, h('h2', { style: 'margin-top:0' }, 'Subtasks'), h('ul', {}, t.subtasks.map((k) => h('li', {}, h('a', { href: `#/task/${k.id}` }, `${k.code} ${k.title}`), ` · ${k.assignee || 'unassigned'} · ${k.status === 'done' ? 'closed' : k.status}`)))) : null,
      t.log?.length ? h('details', { style: 'max-width:760px' }, h('summary', {}, 'History'), h('ul', { class: 'hint' }, t.log.slice().reverse().map((l) => h('li', {}, `${new Date(l.at).toLocaleString()}: ${l.text}`)))) : null);
    const msgs = who ? ((await api(`/api/agents/${who.id}/messages`).catch(() => [])) || []) : [];
    const shown = msgs.filter((m) => m.role !== 'system' || !/^Stopped|^Created sub-agent/.test(m.text || '')).slice(-14);
    convo.replaceChildren(shown.length ? h('ol', { class: 'hint', style: 'list-style:none;padding:0;margin:0' }, shown.map((m) => h('li', { style: 'margin:6px 0;white-space:pre-wrap' }, h('b', {}, m.role === 'user' ? 'You: ' : `${who?.name || 'Agent'}: `), (m.text || '').slice(0, 600)))) : h('p', { class: 'hint' }, who ? 'No conversation with this agent yet.' : 'Assign someone to this task to see their conversation here.'));
  };
  await load();
  page = { shows: () => true, update: debounce((ev) => { if (['message', 'agent', 'activity'].includes(ev.type)) load().catch(() => {}); }) };
}

// ---------- repositories ----------
function pageRepos() {
  crumbs('Agents', 'Repositories');
  const draw = async () => {
    const [repos, st] = await Promise.all([api('/api/repos'), api('/api/state').catch(() => null)]);
    const who = S.agents.filter((a) => a.member || !a.parentId).map((a) => ({ id: a.id, label: a.title ? `${a.name} (${a.title})` : a.kind === 'general' ? `${a.name} (CEO)` : `${a.name} (project lead)` }));
    const src = h('input', { type: 'text', placeholder: 'Paste a URL (https://github.com/owner/name), owner/name, or a folder', 'aria-label': 'Repository address or folder' }), nm = h('input', { type: 'text', placeholder: 'Name (optional)', 'aria-label': 'Name' }), br = h('input', { type: 'text', placeholder: 'Branch (optional)', 'aria-label': 'Branch' }), nt = h('input', { type: 'text', placeholder: 'What should agents use it for?', 'aria-label': 'What it is for' });
    const btn = h('button', { class: 'btn primary', onclick: guard(async () => { btn.disabled = true; btn.textContent = 'Adding…'; try { await api('/api/repos', 'POST', { source: src.value, name: nm.value, branch: br.value, notes: nt.value }); } finally { btn.disabled = false; btn.textContent = 'Add repository'; } draw(); }) }, 'Add repository');
    const card = (r) => {
      const save = guard(async (p) => { await api('/api/repos/' + r.id, 'PUT', p); });
      return h('div', { class: 'card', style: 'margin-bottom:12px' }, h('div', { class: 'kv', style: 'justify-content:space-between' }, h('div', {}, h('b', {}, r.name), h('small', { class: 'hint mono', style: 'display:block' }, `${r.kind === 'local' ? 'Folder' : 'Copy'}: ${r.path}${r.branch ? ' · ' + r.branch : ''}`)),
        h('div', { class: 'kv' }, h('button', { class: 'btn', onclick: guard(async () => { await api(`/api/repos/${r.id}/sync`, 'POST', {}); toast('Up to date'); draw(); }) }, r.kind === 'clone' ? 'Update from GitHub' : 'Refresh'), h('button', { class: 'btn danger', onclick: guard(async () => { if (!confirm(`Remove "${r.name}"? ${r.kind === 'local' ? 'Your folder is not touched.' : 'The downloaded copy is deleted.'}`)) return; await api('/api/repos/' + r.id, 'DELETE'); draw(); }) }, 'Remove'))),
        r.notes ? h('p', { style: 'margin:6px 0' }, r.notes) : null, r.overview ? h('details', {}, h('summary', {}, 'What is in it'), h('pre', { class: 'diffstat mono', style: 'white-space:pre-wrap' }, r.overview)) : null,
        h('fieldset', { class: 'who' }, h('legend', {}, 'Who may read from it'),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: r.everyone, onchange: async (e) => { await save({ everyone: e.target.checked }); draw(); } }), ' Everyone'),
          r.everyone ? null : who.map((a) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: r.agents.includes(a.id), onchange: async (e) => { const next = new Set(r.agents); e.target.checked ? next.add(a.id) : next.delete(a.id); r.agents = [...next]; await save({ agents: r.agents }); } }), ` ${a.label}`))),
        h('small', { class: 'hint' }, `Updated ${ago(r.syncedAt)}. Agents only read from it. They never change it.`));
    };
    view.replaceChildren(h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Repositories'), h('p', { class: 'sub-title' }, 'Point agents at a repository so they can read information from it, such as notes, code or documents. They treat it as read-only.'))),
      h('div', { class: 'card', style: 'margin-bottom:16px' }, h('div', { class: 'formrow' }, src, btn), h('div', { class: 'formrow', style: 'margin:8px 0' }, nm, br, nt), h('small', { class: 'hint' }, 'Private GitHub repositories work once GitHub is connected under Connections. Never put a password in the address.')),
      repos.length ? repos.map(card) : h('div', { class: 'card empty' }, 'No repositories yet.'));
  };
  draw().catch((e) => toast(e.message, true)); page = { shows: () => true };
}

// ---------- support tickets ----------
const TICKET_LABEL = { open: ['info', 'Open'], working: ['work', 'An agent is working'], resolved: ['ok', 'Fixed. Please check'], closed: ['', 'Closed'] };
function pageTickets() {
  crumbs('Workspace', 'Support tickets');
  let data = { tickets: [], handler: null }, openId = null;
  const load = async () => { data = await api('/api/tickets'); draw(); };
  const draw = () => {
    const team = S.agents.filter((a) => a.member || a.kind === 'general');
    const title = h('input', { type: 'text', placeholder: 'What is wrong? One short line', 'aria-label': 'Ticket title' }), desc = h('textarea', { rows: '3', placeholder: 'What happened, and what did you expect? The more detail, the faster the fix.', 'aria-label': 'Details' });
    const pri = h('select', { 'aria-label': 'How urgent' }, [['normal', 'Normal'], ['high', 'Urgent'], ['low', 'Can wait']].map(([v, t]) => h('option', { value: v }, t)));
    const who = h('select', { 'aria-label': 'Who should handle it' }, h('option', { value: '' }, data.handler ? `${data.handler} (decides who does it)` : 'Your CEO'), team.filter((a) => a.kind !== 'general').map((a) => h('option', { value: a.id }, `${a.name} (${a.title || a.role})`)));
    const send = h('button', { class: 'btn primary', onclick: guard(async () => { const t = await api('/api/tickets', 'POST', { title: title.value, description: desc.value, priority: pri.value, assignee: who.value }); openId = t.id; load(); }) }, 'Send ticket');
    const item = (t) => {
      const [tone, label] = TICKET_LABEL[t.status], isOpen = openId === t.id;
      const reply = h('textarea', { rows: '2', placeholder: t.status === 'resolved' ? 'Still broken? Tell the agent what you see.' : 'Reply to the agent', 'aria-label': 'Your reply' });
      return h('div', { class: 'card', style: 'margin-bottom:10px' }, h('button', { class: 'tk-head', 'aria-expanded': String(isOpen), onclick: () => { openId = isOpen ? null : t.id; draw(); } }, h('b', {}, `#${t.num} ${t.title}`), h('span', { class: 'pill ' + tone }, label), t.priority === 'high' ? h('span', { class: 'pill err' }, 'Urgent') : null, h('small', { class: 'hint', style: 'margin-left:auto' }, ago(t.updatedAt))),
        isOpen ? h('div', { style: 'margin-top:10px' }, t.description ? h('p', { class: 'tk-msg you' }, h('small', {}, 'You wrote'), t.description) : null,
          t.comments.map((c) => h('p', { class: 'tk-msg ' + (c.kind === 'human' ? 'you' : c.kind === 'error' ? 'bad' : '') }, h('small', {}, `${c.who} · ${ago(c.at)}${c.kind === 'resolution' ? ' · fixed' : c.kind === 'question' ? ' · needs you' : ''}`), c.text)),
          t.status === 'working' ? h('p', { class: 'hint', role: 'status' }, 'An agent is working on this…') : null,
          t.status !== 'closed' ? h('div', {}, reply, h('div', { class: 'kv', style: 'margin-top:8px' }, h('button', { class: 'btn primary', onclick: guard(async () => { await api(`/api/tickets/${t.id}/comment`, 'POST', { text: reply.value }); load(); }) }, 'Send reply'), t.status !== 'working' ? h('button', { class: 'btn', onclick: guard(async () => { await api(`/api/tickets/${t.id}/status`, 'POST', { status: 'closed' }); load(); }) }, 'Close ticket') : null, h('button', { class: 'btn danger', onclick: guard(async () => { if (confirm('Delete this ticket?')) { await api('/api/tickets/' + t.id, 'DELETE'); load(); } }) }, 'Delete')))
            : h('div', { class: 'kv' }, h('button', { class: 'btn', onclick: guard(async () => { await api(`/api/tickets/${t.id}/status`, 'POST', { status: 'open' }); load(); }) }, 'Reopen'), h('button', { class: 'btn danger', onclick: guard(async () => { if (confirm('Delete this ticket?')) { await api('/api/tickets/' + t.id, 'DELETE'); load(); } }) }, 'Delete'))) : null);
    };
    view.replaceChildren(h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Support tickets'), h('p', { class: 'sub-title' }, 'Something wrong? Describe it here. An agent looks into it, fixes what it can, and tells you what to check. If it needs you, it asks.'))),
      h('div', { class: 'card', style: 'margin-bottom:16px' }, h('div', { class: 'formrow' }, title, pri, who), h('div', { style: 'margin-top:8px' }, desc), h('div', { style: 'margin-top:8px' }, send)),
      data.tickets.length ? data.tickets.map(item) : h('div', { class: 'card empty' }, 'No tickets yet.'));
  };
  load().catch((e) => toast(e.message, true)); page = { shows: () => true, update: debounce((ev) => { if (['agent', 'message'].includes(ev.type)) load().catch(() => {}); }, 1000) };
}

// ---------- settings ----------
function pageAppearance() {
  crumbs('Settings', 'Appearance');
  const draw = () => view.replaceChildren(h('h1', {}, 'Appearance'), h('p', { class: 'sub-title' }, 'Apiary remembers your choice on this browser.'),
    h('div', { class: 'card', style: 'max-width:560px' }, h('div', { class: 'seg' }, ['dark', 'light'].map((t) => h('button', { 'aria-pressed': String(document.documentElement.className === t), onclick: () => { applyTheme(t); draw(); } }, t === 'dark' ? 'Dark' : 'Light')))),
    h('div', { class: 'card', style: 'max-width:560px;margin-top:16px' }, h('h2', {}, 'Writing style'), h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.plainEnglish, onchange: guard(async (e) => { await api('/api/settings', 'PUT', { plainEnglish: e.target.checked }); S.plainEnglish = e.target.checked; }) }), ' Agents write in plain, simple English'), h('p', { class: 'hint' }, 'On by default: short sentences and everyday words. Turn it off if you prefer technical language.')));
  draw();
}

// ---------- who is working right now ----------
const busy = () => S.agents.filter((a) => a.status === 'working' || a.status === 'waiting');
function openAgent(id) {
  const a = S.agents.find((x) => x.id === id); if (!a) return;
  const root = rootOf(a); S.sel = id; S.nextTab = 'chat';
  const target = root.kind === 'general' ? '#/chat' : `#/project/${root.id}`;
  if (location.hash === target) route(); else location.hash = target;
}
function workingBox() {
  const list = busy().slice(0, 6);
  return h('div', { class: 'conn-box', id: 'working', 'aria-live': 'polite' }, h('h4', {}, 'Working now'),
    list.length ? list.map((a) => h('button', { class: 'conn-row', style: 'background:none;border:0;padding:2px 0;text-align:left;width:100%;cursor:pointer', onclick: () => openAgent(a.id), title: 'Open this agent' }, h('span', { class: 'dot work pulse' }), h('span', { style: 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, a.name), h('small', { style: 'max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, S.activity[a.id] || (a.status === 'waiting' ? 'Waiting' : 'Working')))) : h('small', { class: 'hint' }, 'Nobody right now'),
    busy().length > 6 ? h('a', { class: 'hint', href: '#/activity' }, `and ${busy().length - 6} more`) : h('a', { class: 'hint', href: '#/activity' }, 'See live activity'));
}
function updateWorking() { const old = document.getElementById('working'); if (old) old.replaceWith(workingBox()); }

function pageActivity() {
  crumbs('Workspace', 'Live activity');
  let tails = {};
  const draw = () => {
    const list = busy();
    const card = (a) => {
      const root = rootOf(a), lines = (S.logs[a.id] || tails[a.id] || []).slice(-8);
      const where = a.member ? `${a.title || a.role || 'Specialist'}` : a.kind === 'general' ? 'CEO' : !a.parentId ? 'Project' : (a.role || 'Helper');
      return h('div', { class: 'card', style: 'margin-bottom:12px' },
        h('div', { class: 'kv', style: 'justify-content:space-between;gap:8px;flex-wrap:wrap' }, h('div', {}, h('b', {}, a.name), ' ', h('span', { class: 'pill' }, where), root.id !== a.id ? h('small', { class: 'hint' }, ` in ${root.name}`) : null), pill(a.status)),
        h('p', { style: 'margin:6px 0;font-weight:600' }, h('span', { class: 'dot work pulse' }), ' ', S.activity[a.id] || (a.status === 'waiting' ? 'Waiting for the team…' : 'Working…')),
        lines.length ? h('pre', { class: 'mono', style: 'max-height:150px;overflow:auto;margin:6px 0;padding:8px;background:var(--bg);border:1px solid var(--line);border-radius:8px;white-space:pre-wrap' }, lines.join('\n')) : h('p', { class: 'hint' }, 'No terminal output yet.'),
        h('div', { class: 'formrow' }, h('button', { class: 'btn', onclick: () => openAgent(a.id) }, 'Open chat'), h('button', { class: 'btn', onclick: guard(() => api(`/api/agents/${a.id}/stop`, 'POST', {})) }, 'Stop')));
    };
    view.replaceChildren(h('h1', {}, 'Live activity'), h('p', { class: 'sub-title' }, 'Every agent that is working right now: your CEO, specialists and project helpers. This updates by itself.'),
      list.length ? list.map(card) : h('div', { class: 'card empty' }, 'Nobody is working right now. When you give a task or message to an agent, you will see them here, with what they are doing and their latest output.'));
  };
  const load = async () => { for (const a of busy()) { if (!tails[a.id]) { try { tails[a.id] = await api(`/api/agents/${a.id}/logs`); } catch { tails[a.id] = []; } } } draw(); };
  load();
  let queued = 0;   // redraw at most twice a second, so a busy agent's output cannot starve the page
  page = { shows: () => true, update: (ev) => {
    if (!['agent', 'removed', 'activity', 'log'].includes(ev.type)) return;
    if (ev.type === 'log') (tails[ev.agentId] ||= []).push(ev.line);
    if (!queued) queued = setTimeout(() => { queued = 0; if (cur() === '#/activity') load(); }, 400);
  } };
}

// ---------- machine usage in the top bar ----------
const GB = (b) => (b >= 1073741824 ? (b >= 10737418240 ? Math.round(b / 1073741824) : Math.round(b / 107374182.4) / 10) + ' GB' : b >= 1048576 ? Math.round(b / 104857.6) / 10 + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
async function pollSystem() {
  const el = document.getElementById('sys');
  if (!el || document.hidden) return;
  try {
    const s = await api('/api/system');
    const part = (label, pct, tip) => h('span', { class: pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '', title: tip }, label + ' ', h('b', {}, pct == null ? '–' : pct + '%'));
    const mp = s.mem ? Math.round(100 * s.mem.used / s.mem.total) : null, dp = s.disk ? Math.round(100 * s.disk.used / s.disk.total) : null;
    el.replaceChildren(part('CPU', s.cpu, `${s.cores} cores. Load ${s.load.join(' / ')} (1, 5, 15 minutes)`), part('RAM', mp, s.mem ? `${GB(s.mem.used)} used of ${GB(s.mem.total)}` : ''), part('Disk', dp, s.disk ? `${GB(s.disk.total - s.disk.used)} free of ${GB(s.disk.total)}` : ''));
    el.hidden = false;
  } catch { /* the page is about to redirect or the server is restarting */ }
}
setInterval(pollSystem, 5000); document.addEventListener('visibilitychange', pollSystem); pollSystem();

// ---------- backups ----------
async function pageTelegram() {
  crumbs('Settings', 'Telegram alerts');
  const draw = async () => {
    let d; try { d = await api('/api/telegram'); } catch (e) { view.replaceChildren(h('div', { class: 'card empty' }, e.message)); return; }
    const c = d.config, st = d.status;
    const token = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: st.hasToken ? 'Saved in the vault. Paste a new one to replace it.' : '123456789:ABC…', 'aria-label': 'Bot token' });
    const on = h('input', { type: 'checkbox', checked: c.enabled, disabled: !st.linked }), ev = {};
    for (const k of ['approvals', 'health', 'tasks']) ev[k] = h('input', { type: 'checkbox', checked: c.events[k] });
    const mins = h('input', { type: 'number', min: '1', max: '600', value: c.longTaskMinutes, 'aria-label': 'Minutes' });
    const saveToken = guard(async () => { if (!token.value.trim()) return toast('Paste the bot token first'); await api('/api/telegram', 'PUT', { token: token.value }); toast('Token saved in the vault'); draw(); });
    const save = guard(async () => { await api('/api/telegram', 'PUT', { enabled: on.checked, events: Object.fromEntries(Object.entries(ev).map(([k, el]) => [k, el.checked])), longTaskMinutes: Number(mins.value) }); toast('Saved'); draw(); });
    const link = guard(async () => { await api('/api/telegram/link', 'POST', {}); draw(); });
    const test = guard(async () => { await api('/api/telegram/test', 'POST', {}); toast('Test alert sent'); draw(); });
    const unlink = guard(async () => { await api('/api/telegram/unlink', 'POST', {}); draw(); });
    view.replaceChildren(h('h1', {}, 'Telegram alerts'), h('p', { class: 'sub-title' }, 'Urgent alerts on your phone: approvals waiting, health warnings, and long tasks finishing. Alerts only. Command output, file contents and secrets are never sent.'),
      st.vaultLocked ? h('div', { class: 'card', role: 'alert', style: 'max-width:680px;margin-bottom:12px' }, 'The secrets vault is locked, so the bot token cannot be read and no alerts go out. Unlock it on the Secrets page.') : null,
      st.lastError ? h('p', { class: 'hint', role: 'alert', style: 'color:var(--err);max-width:680px' }, st.lastError) : null,
      h('div', { class: 'card', style: 'max-width:680px;margin-bottom:12px' }, h('h2', {}, '1. Your bot'),
        h('p', { class: 'hint' }, 'In Telegram, message @BotFather, send /newbot, follow the steps, and copy the token it gives you. The token is stored encrypted in your Secrets vault.'),
        h('div', { class: 'formrow' }, token, h('button', { class: 'btn primary', onclick: saveToken }, 'Save token'))),
      h('div', { class: 'card', style: 'max-width:680px;margin-bottom:12px' }, h('h2', {}, '2. Link your chat'),
        st.linked ? h('p', {}, h('span', { class: 'pill ok' }, 'Linked'), ' Only your chat is answered. Anyone else who finds the bot is ignored. ', h('button', { class: 'btn', onclick: unlink }, 'Unlink')) : st.linking ? h('div', {}, h('p', {}, 'Open your bot in Telegram and send it this code:'), h('p', { style: 'font-size:28px;letter-spacing:6px;font-weight:700' }, st.linking.code), h('p', { class: 'hint' }, 'It works for 10 minutes. This page updates when the chat is linked.'))
          : h('div', {}, h('p', { class: 'hint' }, 'Press the button, then send the code it shows to your bot. Nobody else can link a chat without that code.'), h('button', { class: 'btn', onclick: link, disabled: !st.hasToken }, 'Link my chat'))),
      h('div', { class: 'card', style: 'max-width:680px' }, h('h2', {}, '3. What to send'),
        h('label', { class: 'check' }, on, ' Send alerts', st.linked ? '' : ' (link your chat first)'),
        h('label', { class: 'check' }, ev.approvals, ' An approval is waiting for you'), h('label', { class: 'check' }, ev.health, ' A health warning appears'),
        h('label', { class: 'check' }, ev.tasks, ' A long task finishes, one that took more than ', mins, ' minutes'),
        h('div', { class: 'formrow', style: 'margin-top:10px' }, h('button', { class: 'btn primary', onclick: save }, 'Save'), h('button', { class: 'btn', onclick: test, disabled: !st.linked }, 'Send a test alert')),
        h('p', { class: 'hint' }, 'In Telegram, send /status to the bot for a one-line summary.')));
  };
  await draw();
  page = { shows: () => true, update: (e) => e.type === 'telegram' && draw() };
}
function openSaveTemplate(p) {
  const name = h('input', { type: 'text', value: p.name, maxlength: '60', 'aria-label': 'Template name' }), desc = h('input', { type: 'text', maxlength: '300', placeholder: 'Optional: what is it for?', 'aria-label': 'Description' });
  const d = dlgOpen('Save as template', h('p', { class: 'hint' }, 'Keeps the goal, the plan phases and the team roles. Passwords, secrets, folders and specific servers (addresses, links, device names) are never saved.'),
    h('label', { class: 'f' }, 'Name', name), h('label', { class: 'f' }, 'Description', desc),
    h('div', { class: 'formrow' }, h('span', { style: 'flex:1' }), h('button', { class: 'btn', value: 'c' }, 'Cancel'), h('button', { class: 'btn primary', value: 's', onclick: (e) => { e.preventDefault(); guard(async () => { const t = await api('/api/templates', 'POST', { projectId: p.id, name: name.value, description: desc.value }); d.close(); toast(t.removed ? `Template saved. ${t.removed} specific detail${t.removed === 1 ? ' was' : 's were'} removed.` : 'Template saved'); })(); } }, 'Save')));
}
async function pageProjectTemplates() {
  crumbs('Workspace', 'Project templates');
  const draw = async () => {
    let list; try { list = await api('/api/templates'); } catch (e) { view.replaceChildren(h('div', { class: 'card empty' }, e.message)); return; }
    const start = (t) => {
      const name = h('input', { type: 'text', value: t.name, maxlength: '48', 'aria-label': 'Project name' }), folder = h('input', { type: 'text', placeholder: 'Optional: a folder on this computer, for example /home/you/projects/app', 'aria-label': 'Folder' });
      const ps = S.providers.filter((p) => p.id !== 'mock' || S.providers.length === 1), prov = h('select', { 'aria-label': 'AI' }, ps.map((p) => h('option', { value: p.id, selected: p.id === S.defaultProvider }, p.label)));
      const d = dlgOpen(`Start from "${t.name}"`, h('label', { class: 'f' }, 'Project name', name), h('label', { class: 'f' }, 'AI to use', prov), h('label', { class: 'f' }, 'Folder', folder),
        h('p', { class: 'hint' }, `${t.members.length} team member${t.members.length === 1 ? '' : 's'} and ${t.phases.length} phase${t.phases.length === 1 ? '' : 's'} will be set up. Nothing is shared with the new project except what is in the template.`),
        h('div', { class: 'formrow' }, h('span', { style: 'flex:1' }), h('button', { class: 'btn', value: 'c' }, 'Cancel'), h('button', { class: 'btn primary', value: 's', onclick: (e) => { e.preventDefault(); guard(async () => { e.target.disabled = true; const a = await api(`/api/templates/${t.id}/start`, 'POST', { name: name.value, provider: prov.value, cwd: folder.value.trim() || undefined }); d.close(); location.hash = `#/project/${a.id}`; })().finally(() => { e.target.disabled = false; }); } }, 'Start project')));
    };
    const edit = (t) => {
      const name = h('input', { type: 'text', value: t.name }), desc = h('input', { type: 'text', value: t.description || '' }), goal = h('textarea', { rows: '4' }); goal.value = t.goal || '';
      const d = dlgOpen('Edit template', h('label', { class: 'f' }, 'Name', name), h('label', { class: 'f' }, 'Description', desc), h('label', { class: 'f' }, 'Goal', goal),
        h('div', { class: 'formrow' }, h('span', { style: 'flex:1' }), h('button', { class: 'btn', value: 'c' }, 'Cancel'), h('button', { class: 'btn primary', value: 's', onclick: (e) => { e.preventDefault(); guard(async () => { await api(`/api/templates/${t.id}`, 'PUT', { name: name.value, description: desc.value, goal: goal.value }); d.close(); draw(); })(); } }, 'Save')));
    };
    view.replaceChildren(h('h1', {}, 'Project templates'), h('p', { class: 'sub-title' }, 'Save a setup you repeat and start new projects from it. A template keeps the goal, plan phases and team roles, never passwords or specific servers. To make one, open a project and press Save as template.'),
      list.length ? h('div', { class: 'grid' }, list.map((t) => h('div', { class: 'card' }, h('h2', { style: 'margin:0 0 4px' }, t.name), t.description ? h('p', { class: 'hint' }, t.description) : null,
        h('p', { class: 'hint' }, `${t.phases.length} phase${t.phases.length === 1 ? '' : 's'} · ${t.members.length} team member${t.members.length === 1 ? '' : 's'}${t.fromProject ? ' · from ' + t.fromProject : ''}`),
        t.phases.length ? h('p', { class: 'hint' }, t.phases.map((p) => p.title).join(' → ')) : null,
        h('div', { class: 'formrow' }, h('button', { class: 'btn primary', onclick: () => start(t) }, 'Start project'), h('button', { class: 'btn', onclick: () => edit(t) }, 'Edit'),
          h('button', { class: 'btn danger', onclick: guard(async () => { if (!confirm(`Delete the template "${t.name}"? Projects already made from it are not affected.`)) return; await api(`/api/templates/${t.id}`, 'DELETE'); draw(); }) }, 'Delete'))))) : h('div', { class: 'card empty' }, 'No templates yet. Open a project that has a plan and a team, and press Save as template.'));
  };
  await draw(); page = { shows: () => false, update: () => {} };
}
// ---------- global search ----------
(function globalSearchBox() {
  const form = $('#gsearch'), input = $('#gq'), box = $('#gres'); if (!form) return;
  let seq = 0, first = null;
  const close = () => { box.hidden = true; };
  const run = debounce(async () => {
    const q = input.value.trim(), my = ++seq; if (!q) { close(); return; }
    let r; try { r = await api('/api/search?q=' + encodeURIComponent(q)); } catch { return; }
    if (my !== seq) return;
    first = r.groups[0]?.items[0] || null;
    box.replaceChildren(...(r.groups.length ? r.groups.map((g) => h('div', { class: 'gg' }, h('div', { class: 'gh' }, `${g.label}${g.total > g.items.length ? ` (${g.total})` : ''}`), ...g.items.map((it) => h('a', { class: 'gi', href: it.href, onclick: () => { close(); input.value = ''; } }, h('b', {}, it.title), it.sub ? h('small', {}, it.sub) : null)))) : [h('div', { class: 'gh' }, 'Nothing found')]), ...(r.note ? [h('div', { class: 'gh' }, r.note)] : []));
    box.hidden = false;
  }, 220);
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); input.blur(); } });
  form.addEventListener('submit', (e) => { e.preventDefault(); if (first) { location.hash = first.href; close(); input.value = ''; } });
  document.addEventListener('click', (e) => { if (!form.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.focus(); input.select(); } });
})();
const escHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TOK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n));
// Stacked bars, one per week, split by AI. A triangle marks weeks a usage limit was hit.
function usageChart(weeks) {
  const provs = [...new Set(weeks.flatMap((w) => Object.keys(w.byProvider)))].sort(), W = 640, H = 220, L = 46, B = 34, T = 18, bw = (W - L - 10) / weeks.length;
  const max = Math.max(1, ...weeks.map((w) => w.total)), y = (v) => T + (H - T - B) * (1 - v / max);
  let svgs = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tokens used per week" class="uchart">`;
  for (let i = 0; i <= 3; i++) { const v = (max * i) / 3; svgs += `<line x1="${L}" x2="${W - 6}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end" class="ax">${TOK(Math.round(v))}</text>`; }
  weeks.forEach((w, i) => {
    let acc = 0; const x = L + i * bw + bw * 0.18, ww = bw * 0.64;
    provs.forEach((p, k) => { const v = w.byProvider[p] || 0; if (!v) return; svgs += `<rect x="${x}" y="${y(acc + v)}" width="${ww}" height="${Math.max(0.5, y(acc) - y(acc + v))}" class="c${k % 4}"><title>${escHtml(p)}: ${TOK(v)} tokens</title></rect>`; acc += v; });
    svgs += `<text x="${x + ww / 2}" y="${H - 16}" text-anchor="middle" class="ax">${escHtml(new Date(w.start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))}</text>`;
    if (w.limitHit.length) svgs += `<path d="M${x + ww / 2 - 5} ${H - 3} l5 -9 l5 9 z" class="hit"><title>Usage limit hit: ${escHtml(w.limitHit.join(', '))}</title></path>`;
  });
  svgs += '</svg>';
  const legend = provs.map((p, k) => `<span class="lg"><i class="sw c${k % 4}"></i>${escHtml(p)}</span>`).join('') + (weeks.some((w) => w.limitHit.length) ? '<span class="lg"><i class="tri"></i>a usage limit was hit that week</span>' : '');
  const box = h('div', { class: 'card', style: 'max-width:700px' }); box.innerHTML = `<h2 style="margin-top:0">Tokens per week</h2>${svgs}<div class="legend">${legend}</div>`;
  return box;
}
async function pageReports() {
  crumbs('Workspace', 'Weekly report');
  let sel = null;
  const draw = async () => {
    let d; try { d = await api('/api/reports'); } catch (e) { view.replaceChildren(h('div', { class: 'card empty' }, e.message)); return; }
    const c = d.config, id = sel || d.list[0]?.id, rep = id ? await api('/api/reports/' + id) : null;
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const on = h('input', { type: 'checkbox', checked: c.enabled }), day = h('select', { 'aria-label': 'Day' }, days.map((n, i) => h('option', { value: i, selected: c.weekday === i }, n))), time = h('input', { type: 'time', value: c.time, 'aria-label': 'Time' }), tg = h('input', { type: 'checkbox', checked: c.telegram });
    const save = guard(async () => { await api('/api/reports', 'PUT', { enabled: on.checked, weekday: Number(day.value), time: time.value, telegram: tg.checked }); toast('Saved'); draw(); });
    const run = guard(async (e) => { e.target.disabled = true; e.target.textContent = 'Making…'; try { const r = await api('/api/reports/run', 'POST', {}); sel = r.id; } finally { draw(); } });
    const pick = h('select', { 'aria-label': 'Past reports', onchange: (e) => { sel = e.target.value; draw(); } }, d.list.map((r) => h('option', { value: r.id, selected: r.id === id }, `Week ending ${new Date(r.weekEnd).toLocaleDateString()}`)));
    const u = rep?.usage;
    const provRow = (p) => { const a = u.byProvider[p] || 0, b = u.lastByProvider[p] || 0, ch = b ? Math.round(((a - b) / b) * 100) : null; return h('tr', {}, h('td', {}, p), h('td', {}, TOK(a)), h('td', {}, TOK(b)), h('td', {}, ch === null ? 'n/a' : `${ch >= 0 ? '+' : ''}${ch}%`)); };
    view.replaceChildren(h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Weekly report'), h('p', { class: 'sub-title' }, 'A plain-English summary of the week and how many tokens were used compared with last week.')), h('div', { class: 'formrow' }, d.list.length ? pick : null, h('button', { class: 'btn primary', onclick: run }, 'Make one now'))),
      h('div', { class: 'card', style: 'max-width:700px;margin-bottom:12px' }, h('label', { class: 'check' }, on, ' Make a report every week and keep it here'),
        h('div', { class: 'formrow', style: 'margin:8px 0' }, day, time), h('label', { class: 'check' }, tg, ' Also send a short version to Telegram (counts and totals only)'), h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn', onclick: save }, 'Save'))),
      rep ? h('div', { class: 'card', style: 'max-width:700px;margin-bottom:12px' }, h('h2', { style: 'margin-top:0' }, 'Summary'), ...rep.summary.map((l, i) => h('p', { style: i ? '' : 'font-weight:600' }, l))) : h('div', { class: 'card empty', style: 'max-width:700px' }, 'No report yet. Press Make one now, or switch on the weekly report.'),
      rep ? usageChart(u.weeks) : null,
      rep ? h('div', { class: 'card', style: 'max-width:700px;margin-top:12px;padding:0;overflow:auto' }, h('table', { class: 'tbl', style: 'min-width:0' }, h('thead', {}, h('tr', {}, ['AI', 'This week', 'Last week', 'Change'].map((t) => h('th', {}, t)))), h('tbody', {}, [...new Set([...Object.keys(u.byProvider), ...Object.keys(u.lastByProvider)])].map(provRow)),
        u.topAgents.length ? h('tfoot', {}, h('tr', {}, h('td', { colspan: 4, class: 'hint' }, 'Biggest users this week: ' + u.topAgents.map((a) => `${a.name} (${TOK(a.tokens)})`).join(', ')))) : null)) : null);
  };
  await draw(); page = { shows: () => false, update: (ev) => ev.type === 'report' && !document.querySelector('dialog[open]') && draw() };
}
async function pageRunbooks() {
  crumbs('Workspace', 'Runbooks');
  const q = h('input', { type: 'search', placeholder: 'Search runbooks', 'aria-label': 'Search runbooks', style: 'min-width:220px' });
  const box = h('div');
  let items = [];
  const edit = (r) => {
    const t = h('input', { type: 'text', value: r?.title || '', maxlength: '100' }), prob = h('input', { type: 'text', value: r?.problem || '', maxlength: '500', placeholder: 'When does this apply?' });
    const steps = h('textarea', { rows: '9', placeholder: 'One step per line' }); steps.value = (r?.steps || []).join('\n'); const tags = h('input', { type: 'text', value: (r?.tags || []).join(', '), placeholder: 'For example: server, backup' });
    const d = dlgOpen(r ? 'Edit runbook' : 'New runbook', h('label', { class: 'f' }, 'Title', t), h('label', { class: 'f' }, 'Problem it solves', prob), h('label', { class: 'f' }, 'Steps', steps), h('label', { class: 'f' }, 'Tags (comma separated)', tags),
      h('p', { class: 'hint' }, 'Never put passwords or keys in a runbook. Name the secret to use instead.'),
      h('div', { class: 'formrow' }, h('span', { style: 'flex:1' }), h('button', { class: 'btn', value: 'c' }, 'Cancel'), h('button', { class: 'btn primary', value: 's', onclick: (e) => { e.preventDefault(); guard(async () => { const body = { title: t.value, problem: prob.value, steps: steps.value, tags: tags.value }; await (r ? api('/api/runbooks/' + r.id, 'PUT', body) : api('/api/runbooks', 'POST', body)); d.close(); load(); })(); } }, 'Save')));
  };
  const card = (r) => h('div', { class: 'card', style: 'max-width:760px;margin-bottom:10px' },
    h('div', { class: 'kv', style: 'justify-content:space-between;gap:8px' }, h('b', {}, r.title), r.status === 'trusted' ? h('span', { class: 'pill ok' }, 'Approved') : h('span', { class: 'pill work' }, 'Draft: needs your review')),
    r.problem ? h('p', { class: 'hint' }, 'For: ' + r.problem) : null, h('ol', { style: 'margin:6px 0 6px 18px' }, r.steps.map((x) => h('li', {}, x))),
    h('p', { class: 'hint' }, `By ${r.author}${r.project ? ' in ' + r.project : ''} · ${ago(r.updatedAt)}${r.tags?.length ? ' · ' + r.tags.join(', ') : ''}`),
    h('div', { class: 'formrow' }, r.status === 'trusted' ? h('button', { class: 'btn', onclick: guard(async () => { await api('/api/runbooks/' + r.id, 'PUT', { status: 'draft' }); load(); }) }, 'Stop trusting') : h('button', { class: 'btn primary', onclick: guard(async () => { await api('/api/runbooks/' + r.id, 'PUT', { status: 'trusted' }); load(); }) }, 'Approve'),
      h('button', { class: 'btn', onclick: () => edit(r) }, 'Edit'), h('button', { class: 'btn danger', onclick: guard(async () => { if (!confirm(`Delete the runbook "${r.title}"?`)) return; await api('/api/runbooks/' + r.id, 'DELETE'); load(); }) }, 'Delete')));
  const show = () => {
    const w = q.value.toLowerCase().split(/\s+/).filter(Boolean), list = items.filter((r) => w.every((x) => `${r.title} ${r.problem} ${r.steps.join(' ')} ${(r.tags || []).join(' ')}`.toLowerCase().includes(x)));
    box.replaceChildren(...(list.length ? [...list.filter((r) => r.status === 'draft'), ...list.filter((r) => r.status !== 'draft')].map(card) : [h('div', { class: 'card empty', style: 'max-width:760px' }, items.length ? 'Nothing matches.' : 'No runbooks yet. When an agent solves a problem it can save the steps here for you to review, or press New runbook to write one.')]));
  };
  const load = async () => { try { items = (await api('/api/runbooks')).items; } catch (e) { box.replaceChildren(h('div', { class: 'card empty' }, e.message)); return; } show(); };
  q.oninput = show;
  view.replaceChildren(h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Runbooks'), h('p', { class: 'sub-title' }, 'Steps for problems that were solved once, so they can be followed again. Agents save drafts. Only runbooks you approve are given to agents to follow.')), h('button', { class: 'btn primary', onclick: () => edit(null) }, 'New runbook')), h('div', { style: 'margin-bottom:10px' }, q), box);
  await load(); page = { shows: () => false, update: (ev) => ev.type === 'runbook' && !document.querySelector('dialog[open]') && load() };
}
async function pagePolicy() {
  crumbs('Settings', 'Approval rules');
  const draw = async () => {
    let d; try { d = await api('/api/policy'); } catch (e) { view.replaceChildren(h('div', { class: 'card empty' }, e.message)); return; }
    const act = h('select', { 'aria-label': 'What to do' }, Object.entries(d.actions).map(([k, t]) => h('option', { value: k }, t))), kind = h('select', { 'aria-label': 'When an agent wants to' }, Object.entries(d.kinds).map(([k, t]) => h('option', { value: k }, k === 'any' ? 'do anything that needs approval' : t)));
    const roots = S.agents.filter((a) => !a.parentId && a.kind !== 'general'), proj = h('select', { 'aria-label': 'Project' }, h('option', { value: '' }, 'In any project'), roots.map((a) => h('option', { value: a.id }, a.name)));
    const secret = h('input', { type: 'text', placeholder: 'Secret name (empty = any secret)', 'aria-label': 'Secret name' }), words = h('input', { type: 'text', placeholder: 'Optional: the request must mention…', 'aria-label': 'Words in the request' });
    const agentSel = h('select', { 'aria-label': 'For which agent' }, h('option', { value: '' }, 'Any agent'), S.agents.map((a) => h('option', { value: a.id }, a.name)));
    const scope = h('select', { 'aria-label': 'Which commands' }, h('option', { value: 'exact' }, 'this exact command'), h('option', { value: 'program' }, 'any command that runs this program'), h('option', { value: 'readonly' }, 'read-only commands (status, lists, logs, GET-only web requests)'));
    const cmd = h('input', { type: 'text', placeholder: 'Command or program, e.g. curl or ls -la', 'aria-label': 'Command or program' });
    const sync = () => { secret.style.display = kind.value === 'secret' ? '' : 'none'; scope.style.display = cmd.style.display = kind.value === 'command' ? '' : 'none'; cmd.style.display = kind.value === 'command' && scope.value !== 'readonly' ? '' : 'none'; };
    kind.onchange = sync; scope.onchange = sync; sync();
    const add = guard(async () => { await api('/api/policy', 'POST', { action: act.value, kind: kind.value, project: proj.value, secret: secret.value, contains: words.value, scope: scope.value, command: cmd.value, agent: agentSel.value }); toast('Rule added'); draw(); });
    const word = { allow: 'ok', ask: 'info', deny: 'err' };
    view.replaceChildren(h('h1', {}, 'Approval rules'), h('p', { class: 'sub-title' }, 'Decide once instead of approving each request. When more than one rule fits, the most careful wins: block, then ask, then allow. Requests with no rule are asked as usual.'),
      h('div', { class: 'card', style: 'max-width:760px;margin-bottom:12px' }, h('h2', { style: 'margin-top:0' }, 'Add a rule'), h('div', { class: 'formrow', style: 'flex-wrap:wrap' }, act, h('span', {}, 'when an agent wants to'), kind), h('div', { class: 'formrow', style: 'flex-wrap:wrap;margin-top:8px' }, proj, agentSel, secret, words, scope, cmd), h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn primary', onclick: add }, 'Add rule')),
        h('p', { class: 'hint' }, 'Examples: "Always ask me" when an agent wants to use the secret "Router password"; "Allow without asking" when an agent wants to accept a project plan in one project. Rules cover Apiary approvals (secrets, new agents, hires, plans, merges) and shell commands. A command rule can be limited to one agent. Commands that match no rule are asked about one by one, unless the agent has Full access. Destructive commands (deleting, rebooting, changing packages, services or containers) are always asked about, unless you allow everything for that agent. A secret still needs to be assigned to the agent and the vault unlocked.')),
      d.rules.length ? h('div', { style: 'max-width:760px' }, d.rules.map((r) => h('div', { class: 'card', style: 'margin-bottom:8px;display:flex;gap:10px;align-items:center;justify-content:space-between' }, h('span', {}, h('span', { class: 'pill ' + word[r.action] }, d.actions[r.action]), ' ', r.text.replace(/^[^:]*: /, '')), h('button', { class: 'btn danger', onclick: guard(async () => { await api('/api/policy/' + r.id, 'DELETE'); draw(); }) }, 'Remove')))) : h('div', { class: 'card empty', style: 'max-width:760px' }, 'No rules yet. Every request asks you.'));
  };
  await draw(); page = { shows: () => false, update: () => {} };
}
async function pageHealth() {
  crumbs('Infrastructure', 'Health');
  const draw = async (st) => {
    if (!st) { try { st = await api('/api/health'); } catch (e) { view.replaceChildren(h('div', { class: 'card empty' }, e.message)); return; } }
    const bad = st.items.filter((i) => i.level === 'warn' || i.level === 'err'), info = st.items.filter((i) => i.level === 'info');
    const run = guard(async (e) => { e.target.disabled = true; e.target.textContent = 'Checking…'; try { draw(await api('/api/health/check', 'POST', {})); } finally { e.target.disabled = false; } });
    const card = (i) => h('div', { class: 'card', style: 'max-width:760px;margin-bottom:10px;border-left:4px solid ' + (i.level === 'err' ? 'var(--err)' : i.level === 'warn' ? 'var(--accent)' : 'var(--line)') },
      h('div', { class: 'kv', style: 'justify-content:space-between;gap:8px' }, h('b', {}, i.title), h('span', { class: 'pill ' + (i.level === 'err' ? 'err' : i.level === 'warn' ? 'work' : '') }, i.level === 'err' ? 'Needs attention' : i.level === 'warn' ? 'Warning' : 'Suggestion')),
      h('p', {}, i.problem), h('p', {}, h('b', {}, 'What to do: '), i.fix), i.link ? h('a', { class: 'btn', href: i.link }, 'Go there') : null);
    view.replaceChildren(h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Health'), h('p', { class: 'sub-title' }, 'Warnings before things break: a full disk, a device that stopped answering, an expired login, a locked vault, failed backups. Checked every 5 minutes.')), h('button', { class: 'btn', onclick: run }, 'Check now')),
      h('div', { class: 'card', style: 'max-width:760px;margin-bottom:12px' }, h('span', { class: 'pill ' + (st.level === 'err' ? 'err' : st.level === 'warn' ? 'work' : 'ok') }, st.level === 'err' ? 'Something needs attention' : st.level === 'warn' ? 'Some warnings' : 'All good'), ' ', st.at ? `Last checked ${ago(st.at)}.` : 'Not checked yet. Press Check now.'),
      ...bad.map(card), bad.length || !st.at ? null : h('p', { class: 'hint' }, 'Nothing is wrong right now.'), info.length ? h('h2', {}, 'Suggestions') : null, ...info.map(card));
  };
  await draw();
  page = { shows: () => true, update: (ev) => ev.type === 'health' && draw() };
}
const AUDIT_KINDS = { task: 'Task', command: 'Command', ssh: 'SSH', file: 'File change', tool: 'Tool', commit: 'Commit', secret: 'Secret used', approval: 'Approval', signin: 'Sign-in', vault: 'Vault', infra: 'Device', backup: 'Backup', system: 'System' };
async function pageAudit() {
  crumbs('Settings', 'Audit log');
  const q = h('input', { type: 'search', placeholder: 'Search (for example: ssh, deploy, vault)', 'aria-label': 'Search the audit log', style: 'min-width:240px' });
  const kind = h('select', { 'aria-label': 'What happened' }), actor = h('select', { 'aria-label': 'Who' }), range = h('select', { 'aria-label': 'When' }, [['0', 'Last 30 days'], ['1', 'Last 24 hours'], ['7', 'Last 7 days']].map(([v, t]) => h('option', { value: v }, t)));
  const list = h('div', { class: 'card', style: 'padding:0;overflow:auto' }), count = h('p', { class: 'hint' });
  let facetsDone = false, limit = 100;
  const load = async () => {
    const days = Number(range.value), p = new URLSearchParams({ q: q.value, kind: kind.value, actor: actor.value, limit });
    if (days) p.set('from', Date.now() - days * 86400000);
    let d; try { d = await api('/api/audit?' + p); } catch (e) { list.replaceChildren(h('div', { class: 'empty' }, e.message)); return; }
    if (!facetsDone) {
      facetsDone = true;
      kind.replaceChildren(h('option', { value: '' }, 'Everything'), ...Object.entries(d.facets.kinds).map(([k, n]) => h('option', { value: k }, `${AUDIT_KINDS[k] || k} (${n})`)));
      actor.replaceChildren(h('option', { value: '' }, 'Everyone'), ...Object.keys(d.facets.actors).sort().map((a) => h('option', { value: a }, a)));
    }
    count.textContent = `${d.total} entr${d.total === 1 ? 'y' : 'ies'}${d.total > d.items.length ? `, showing the newest ${d.items.length}` : ''}. Entries are kept for ${d.retentionDays} days. Secret values and command output are never recorded.`;
    list.replaceChildren(d.items.length ? h('table', { class: 'tbl', style: 'width:100%' }, h('thead', {}, h('tr', {}, ['When', 'Who', 'What', 'Details'].map((t) => h('th', {}, t)))),
      h('tbody', {}, d.items.map((e) => h('tr', {}, h('td', { style: 'white-space:nowrap', title: new Date(e.t).toLocaleString() }, new Date(e.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })),
        h('td', {}, e.actor, e.project ? h('div', { class: 'hint' }, e.project) : null), h('td', {}, h('span', { class: 'pill' }, AUDIT_KINDS[e.kind] || e.kind)),
        h('td', { style: 'word-break:break-word' }, h('code', {}, e.action), e.detail ? h('div', { class: 'hint' }, e.detail) : null))))) : h('div', { class: 'empty' }, 'Nothing matches.'),
      d.total > d.items.length ? h('div', { style: 'padding:10px' }, h('button', { class: 'btn', onclick: () => { limit += 200; load(); } }, 'Show more')) : null);
  };
  const go = debounce(load, 250);
  q.oninput = go; kind.onchange = actor.onchange = range.onchange = load;
  view.replaceChildren(h('h1', {}, 'Audit log'), h('p', { class: 'sub-title' }, 'Who did what: commands the agents ran, files they changed, secrets they used (by name only), approvals, sign-ins and more.'),
    h('div', { class: 'formrow', style: 'margin-bottom:10px;flex-wrap:wrap' }, q, kind, actor, range, h('button', { class: 'btn', onclick: load }, 'Refresh')), count, list);
  await load();
  page = { shows: () => false, update: () => {} };
}
async function pageBackups() {
  crumbs('Settings', 'Backups');
  const draw = async () => {
    let d; try { d = await api('/api/backups'); } catch (e) { view.replaceChildren(h('div', { class: 'card empty' }, e.message)); return; }
    const c = d.config, st = d.status;
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const on = h('input', { type: 'checkbox', checked: c.enabled });
    const every = h('select', {}, [['daily', 'Every day'], ['weekly', 'Every week']].map(([k, t]) => h('option', { value: k, selected: c.every === k }, t)));
    const day = h('select', { 'aria-label': 'Day of the week' }, days.map((n, i) => h('option', { value: i, selected: c.weekday === i }, n)));
    const time = h('input', { type: 'time', value: c.time, 'aria-label': 'Time' });
    const keep = h('input', { type: 'number', min: '1', max: '60', value: c.keep, 'aria-label': 'How many to keep' });
    const vault = h('input', { type: 'checkbox', checked: c.vault }), files = h('input', { type: 'checkbox', checked: c.files });
    const dir = h('input', { type: 'text', value: c.dir, spellcheck: 'false', autocapitalize: 'none', 'aria-label': 'Backup folder' });
    const dir2 = h('input', { type: 'text', value: c.dir2, placeholder: 'Optional, for example /mnt/nas/apiary-backups', spellcheck: 'false', autocapitalize: 'none', 'aria-label': 'Second folder' });
    const sync = () => { day.style.display = every.value === 'weekly' ? '' : 'none'; }; every.onchange = sync; sync();
    const save = guard(async () => { await api('/api/backups', 'PUT', { enabled: on.checked, every: every.value, weekday: Number(day.value), time: time.value, keep: Number(keep.value), vault: vault.checked, files: files.checked, dir: dir.value, dir2: dir2.value }); toast('Saved'); draw(); });
    const run = guard(async (e) => { e.target.disabled = true; e.target.textContent = 'Backing up…'; try { const r = await api('/api/backups/run', 'POST', {}); toast(`Backup saved (${GB(r.size)})`); } finally { draw(); } });
    const when = (t) => (t ? new Date(t).toLocaleString() : 'never');
    view.replaceChildren(h('h1', {}, 'Backups'), h('p', { class: 'sub-title' }, 'A copy of everything, made for you on a schedule. Restore one with Export and import.'),
      h('div', { class: 'card', style: 'max-width:680px' },
        h('p', {}, st.lastError ? h('span', { class: 'pill err' }, 'Last backup failed') : st.lastOk ? h('span', { class: 'pill ok' }, 'Last backup worked') : h('span', { class: 'pill' }, 'No backup yet'), ' ', st.lastOk ? `${when(st.lastOk)} (${GB(st.lastSize)}, checked after saving)` : ''),
        st.lastError ? h('p', { class: 'hint', style: 'color:var(--err)', role: 'alert' }, st.lastError) : null, st.lastCopyError ? h('p', { class: 'hint', style: 'color:var(--err)', role: 'alert' }, st.lastCopyError) : null,
        h('label', { class: 'check' }, on, ' Back up automatically'),
        h('div', { class: 'formrow', style: 'margin:10px 0' }, every, day, time, h('label', { class: 'hint' }, 'Keep the newest ', keep)),
        h('label', { class: 'check' }, vault, ' Include the Secrets vault', d.vaultExists ? '' : ' (none yet)'), h('p', { class: 'hint', style: 'margin:2px 0 8px 24px' }, 'It stays encrypted. Restoring it needs your passphrase, and without the passphrase the backup copy of the vault is useless.'),
        h('label', { class: 'check' }, files, ' Include project folders and repositories'), h('p', { class: 'hint', style: 'margin:2px 0 8px 24px' }, 'Bigger backups, but everything comes back. Turn off to save only settings, chats, agents and the map.'),
        h('label', { class: 'f' }, 'Save to this folder', dir), h('label', { class: 'f' }, 'Also copy to (a second place, such as a network share)', dir2),
        h('p', { class: 'hint' }, 'A backup on the same disk does not help if the disk fails, so a second place is recommended.'),
        h('div', { class: 'formrow' }, h('button', { class: 'btn primary', onclick: save }, 'Save settings'), h('button', { class: 'btn', onclick: run }, 'Back up now'))),
      h('div', { class: 'card', style: 'max-width:680px;margin-top:12px' }, h('h2', {}, 'Saved backups'),
        d.files.length ? d.files.map((f) => h('div', { class: 'kv', style: 'justify-content:space-between;gap:8px;margin:4px 0' }, h('span', {}, `${new Date(f.at).toLocaleString()} · ${GB(f.size)}`), h('a', { class: 'btn', href: `/api/backups/${f.name}`, download: f.name }, 'Download'))) : h('p', { class: 'hint' }, 'None yet.'),
        h('p', { class: 'hint', style: 'margin-top:8px' }, 'To restore: Settings > Export and import > Import, and choose a downloaded file. A factory reset does not delete these backups.')));
  };
  await draw(); page = { shows: () => true, update: (ev) => ev.type === 'backup' && !document.querySelector('dialog[open]') && draw() };
}

// ---------- infrastructure: devices and the map ----------
const INFRA_COLORS = { ok: 'var(--ok)', bad: 'var(--err)', none: 'var(--line)' };
async function openInfraForm(types, items, secrets, item, done) {
  const cur = item || {};
  const f = (label, el) => h('label', { class: 'f' }, label, el);
  const name = h('input', { type: 'text', value: cur.name || '', maxlength: '60' });
  const type = h('select', {}, Object.entries(types).map(([k, t]) => h('option', { value: k, selected: (cur.type || 'server') === k }, t)));
  const address = h('input', { type: 'text', value: cur.address || '', placeholder: '10.0.0.5 or nas.local', autocapitalize: 'none', spellcheck: 'false' });
  const port = h('input', { type: 'number', value: cur.port || '', placeholder: 'Default for its type', min: '1', max: '65535' });
  const url = h('input', { type: 'text', value: cur.url || '', placeholder: 'https://example.com', autocapitalize: 'none', spellcheck: 'false' });
  const others = items.filter((i) => i.id !== cur.id);
  const parent = h('select', {}, h('option', { value: '' }, 'Nothing (it is its own thing)'), others.map((i) => h('option', { value: i.id, selected: cur.parentId === i.id }, i.name)));
  const linked = new Map((cur.links || []).map((l) => [l.to, l.label || '']));
  const links = others.map((i) => { const cb = h('input', { type: 'checkbox', checked: linked.has(i.id) }); const lab = h('input', { type: 'text', value: linked.get(i.id) || '', placeholder: 'how (optional)', 'aria-label': `How it connects to ${i.name}`, style: 'flex:1;min-width:0' }); return { id: i.id, cb, lab, row: h('div', { class: 'kv', style: 'gap:8px;margin:3px 0' }, h('label', { class: 'check', style: 'flex:1' }, cb, ' ', i.name), lab) }; });
  const secret = h('select', {}, h('option', { value: '' }, 'None'), secrets.map((x) => h('option', { value: x.name, selected: cur.secret === x.name }, x.name)), cur.secret && !secrets.some((x) => x.name === cur.secret) ? h('option', { value: cur.secret, selected: true }, cur.secret) : null);
  const os = h('input', { type: 'text', value: cur.os || '', placeholder: 'For example Debian 12' });
  const where = h('input', { type: 'text', value: cur.location || '', placeholder: 'For example rack in the garage' });
  const notes = h('textarea', { rows: '3', maxlength: '1000' }); notes.value = cur.notes || '';
  const err = h('p', { class: 'hint', style: 'color:var(--err)', role: 'alert' });
  const dlg = h('dialog', {}, h('form', { method: 'dialog' }, h('h2', {}, item ? `Update ${cur.name}` : 'Add something new'),
    f('Name', name), f('What is it?', type), f('Address (name or IP)', address), f('Port (optional)', port), f('Web address (for websites and web tools)', url),
    f('Runs on', parent), others.length ? h('div', { class: 'f' }, h('b', { style: 'font-weight:600' }, 'Connects to'), links.map((l) => l.row)) : null,
    f('Login to use (from the Secrets vault)', secret), h('p', { class: 'hint' }, 'Only the name is kept here. The password stays encrypted in the vault.'),
    f('Operating system (optional)', os), f('Where it is (optional)', where), f('Notes (optional)', notes), err,
    h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', value: 'cancel' }, 'Cancel'), h('button', { class: 'btn primary', value: 'save', onclick: (e) => { e.preventDefault(); (async () => {
      try {
        const body = { name: name.value, type: type.value, address: address.value, port: port.value, url: url.value, parentId: parent.value, links: links.filter((l) => l.cb.checked).map((l) => ({ to: l.id, label: l.lab.value })), secret: secret.value, os: os.value, location: where.value, notes: notes.value };
        await (item ? api(`/api/infra/${cur.id}`, 'PUT', body) : api('/api/infra', 'POST', body));
        dlg.close(); toast(item ? 'Updated' : 'Added'); done();
      } catch (x) { err.textContent = x.message; }
    })(); } }, item ? 'Save' : 'Add'))));
  document.body.append(dlg); dlg.addEventListener('close', () => dlg.remove()); dlg.showModal(); name.focus();
}

function infraMap(items, types, onOpen) {
  const NS2 = 'http://www.w3.org/2000/svg', mk = (t, a = {}, ...k) => { const e = document.createElementNS(NS2, t); for (const [x, v] of Object.entries(a)) e.setAttribute(x, v); for (const c of k) if (c != null) e.append(c); return e; };
  const byId = new Map(items.map((i) => [i.id, i])), kids = new Map(items.map((i) => [i.id, []]));
  const roots = [];
  for (const i of items) (i.parentId && byId.has(i.parentId) ? kids.get(i.parentId) : roots).push(i);
  const LW = 196, LH = 62, PAD = 14, HEAD = 46, GAP = 14;
  const box = new Map();
  const size = (i, depth) => {
    const ch = kids.get(i.id);
    if (!ch.length) { box.set(i.id, { w: LW, h: LH, depth, leaf: true }); return box.get(i.id); }
    const sizes = ch.map((c) => size(c, depth + 1)), cols = Math.min(ch.length, depth === 0 ? 3 : 2);
    const rows = []; for (let k = 0; k < ch.length; k += cols) rows.push(ch.slice(k, k + cols));
    const cw = Math.max(...Array.from({ length: cols }, (_, c) => Math.max(0, ...rows.map((r) => (r[c] ? box.get(r[c].id).w : 0)))));
    const rh = rows.map((r) => Math.max(...r.map((c) => box.get(c.id).h)));
    const w = Math.max(LW + PAD * 2, cols * cw + (cols - 1) * GAP + PAD * 2), hh = HEAD + rh.reduce((a, b) => a + b, 0) + (rows.length - 1) * GAP + PAD;
    box.set(i.id, { w, h: hh, depth, rows, cw, rh, cols });
    void sizes; return box.get(i.id);
  };
  roots.forEach((r) => size(r, 0));
  const place = (i, x, y) => {
    const b = box.get(i.id); b.x = x; b.y = y;
    if (b.rows) { let yy = y + HEAD; b.rows.forEach((r, ri) => { r.forEach((c, ci) => place(c, x + PAD + ci * (b.cw + GAP), yy)); yy += b.rh[ri] + GAP; }); }
  };
  const MAXW = 1100; let x = 20, y = 20, rowH = 0, maxX = 0;
  for (const r of roots) { const b = box.get(r.id); if (x + b.w > MAXW && x > 20) { x = 20; y += rowH + 50; rowH = 0; } place(r, x, y); x += b.w + 50; rowH = Math.max(rowH, b.h); maxX = Math.max(maxX, x); }
  const W = Math.max(maxX, 400), H = y + rowH + 30;
  const svgEl = mk('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'Map of your infrastructure', style: `max-width:${W}px;height:auto` });
  svgEl.append(mk('defs', {}, mk('marker', { id: 'arr', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' }, mk('path', { d: 'M0 0L10 5L0 10z', style: 'fill:var(--muted)' }))));
  const stroke = (i) => (i.status ? (i.status.ok ? INFRA_COLORS.ok : INFRA_COLORS.bad) : INFRA_COLORS.none);
  const order = [...items].sort((a, b) => (box.get(a.id).depth) - (box.get(b.id).depth));
  const txt = (t, x2, y2, st, size2 = 13, weight = 400) => { const e = mk('text', { x: x2, y: y2, style: `fill:${st};font:${weight} ${size2}px Inter,system-ui,sans-serif` }); e.textContent = t.length > 30 ? t.slice(0, 29) + '…' : t; return e; };
  for (const i of order) {
    const b = box.get(i.id), g = mk('g', { tabindex: '0', role: 'button', 'aria-label': `${i.name}, ${types[i.type] || i.type}${i.state === 'proposed' ? ', waiting for your confirmation' : ''}`, style: 'cursor:pointer' });
    g.append(mk('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 10, style: `fill:${b.leaf ? 'var(--surface)' : 'var(--surface2)'};stroke:${stroke(i)};stroke-width:${i.status ? 2 : 1.2};${i.state === 'proposed' ? 'stroke-dasharray:5 4' : ''}` }));
    g.append(txt(i.name, b.x + 12, b.y + 22, 'var(--text)', 14, 600));
    g.append(txt([types[i.type] || i.type, i.address].filter(Boolean).join(' · '), b.x + 12, b.y + (b.leaf ? 42 : 38), 'var(--muted)', 11.5));
    if (i.state === 'proposed') g.append(txt('to confirm', b.x + b.w - 12 - 62, b.y + 22, 'var(--accent-text)', 11, 600));
    g.addEventListener('click', () => onOpen(i)); g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(i); } });
    svgEl.append(g);
  }
  // links are drawn last, from the edge of one box to the edge of the other
  const edge = (a, c) => { const ax = a.x + a.w / 2, ay = a.y + a.h / 2, cx = c.x + c.w / 2, cy = c.y + c.h / 2, dx = cx - ax, dy = cy - ay; const t = Math.min(Math.abs(dx) > 1e-6 ? (a.w / 2) / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-6 ? (a.h / 2) / Math.abs(dy) : Infinity); return [ax + dx * t, ay + dy * t]; };
  let n = 0;
  for (const i of items) for (const l of i.links || []) {
    const a = box.get(i.id), c = box.get(l.to); if (!a || !c) continue; n++;
    const [x1, y1] = edge(a, c), [x2, y2] = edge(c, a);
    svgEl.append(mk('line', { x1, y1, x2, y2, style: 'stroke:var(--muted);stroke-width:1.6', 'marker-end': 'url(#arr)' }));
    if (l.label) svgEl.append(txt(l.label, (x1 + x2) / 2 + 4, (y1 + y2) / 2 - 4, 'var(--muted)', 11));
  }
  return { el: svgEl, links: n };
}

async function pageInfra(tab) {
  crumbs('Infrastructure', tab === 'map' ? 'Map' : 'Devices');
  const draw = async () => {
    let data, secrets = [];
    try { data = await api('/api/infra'); const v = await api('/api/vault').catch(() => null); secrets = v?.secrets || []; } catch (e) { view.replaceChildren(h('div', { class: 'card empty' }, e.message)); return; }
    const { items, types } = data, byId = new Map(items.map((i) => [i.id, i]));
    const edit = (it) => openInfraForm(types, items, secrets, it, draw);
    const askCeo = guard(async () => {
      const g = await api('/api/chat');
      await api(`/api/agents/${g.id}/messages`, 'POST', { text: `Let's build the map of my infrastructure. Ask me one or two short questions at a time about my devices, servers, VMs, websites and how they connect. Guess what you can from what you know and from the map so far, and propose each thing with an apiary-infra block so I can confirm it.${items.length ? '' : ' The map is empty, so start by asking what I run.'}` });
      location.hash = '#/chat';
    });
    const head = h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, tab === 'map' ? 'Infrastructure map' : 'Devices and connections'), h('p', { class: 'sub-title' }, 'Everything Apiary can reach or manage: servers, VMs, websites and how they connect. Passwords stay in the Secrets vault; only the name of the login is kept here.')),
      h('div', { class: 'formrow' }, h('button', { class: 'btn', onclick: askCeo }, 'Help me map it'), h('button', { class: 'btn primary', onclick: () => edit(null) }, 'Add new')));
    const tabs = h('div', { class: 'tabs', role: 'tablist' }, [['devices', 'Devices', '#/infrastructure'], ['map', 'Map', '#/infrastructure/map']].map(([k, t, href]) => h('a', { role: 'tab', 'aria-selected': String(tab === k), class: 'btn', style: 'text-decoration:none', href }, t)));
    const proposed = items.filter((i) => i.state === 'proposed'), real = items.filter((i) => i.state !== 'proposed');
    const cards = proposed.map((i) => {
      const ans = h('input', { type: 'text', placeholder: 'Your answer', 'aria-label': `Answer about ${i.name}`, onkeydown: (e) => { if (e.key === 'Enter') send(); } });
      const send = guard(async () => { await api(`/api/infra/${i.id}/answer`, 'POST', { text: ans.value }); draw(); });
      return h('div', { class: 'card', style: 'border-style:dashed' }, h('div', { class: 'kv', style: 'justify-content:space-between;gap:8px;flex-wrap:wrap' }, h('b', {}, `Is this right? ${i.name}`), h('span', { class: 'pill info' }, `Suggested by ${i.by || 'an agent'}`)),
        h('p', { style: 'margin:6px 0' }, `${types[i.type] || i.type}${i.address ? ' at ' + i.address : ''}${i.parentId && byId.get(i.parentId) ? ', running on ' + byId.get(i.parentId).name : ''}${(i.links || []).length ? ', connected to ' + i.links.map((l) => byId.get(l.to)?.name).filter(Boolean).join(', ') : ''}`),
        i.why ? h('p', { class: 'hint' }, i.why) : null,
        i.question ? h('div', { class: 'formrow' }, h('span', { style: 'flex:1 1 100%;font-weight:600' }, i.question), ans, h('button', { class: 'btn', onclick: send }, 'Answer')) : null,
        h('div', { class: 'formrow', style: 'margin-top:8px' }, h('button', { class: 'btn primary', onclick: guard(async () => { await api(`/api/infra/${i.id}/confirm`, 'POST', { ok: true }); draw(); }) }, 'Yes, add it'), h('button', { class: 'btn', onclick: () => edit(i) }, 'Edit first'), h('button', { class: 'btn danger', onclick: guard(async () => { await api(`/api/infra/${i.id}/confirm`, 'POST', { ok: false }); draw(); }) }, 'No')));
    });
    if (tab === 'map') {
      const m = items.length ? infraMap(items, types, edit) : null;
      view.replaceChildren(head, tabs, ...cards, items.length ? h('div', { class: 'card', style: 'overflow:auto' }, m.el, h('p', { class: 'hint', style: 'margin-top:8px' }, 'Boxes inside another box run on it. Arrows are connections. Green or red outlines show the last connection test; dashed boxes are waiting for you to confirm. Click a box to update it.')) : h('div', { class: 'card empty' }, 'Nothing here yet. Press Add new, or Help me map it and answer a few questions.'));
      return;
    }
    const rows = real.map((i) => {
      const st = i.status ? h('span', { class: 'pill ' + (i.status.ok ? 'ok' : 'err'), title: `${ago(i.status.at)}` }, i.status.ok ? 'Reachable' : 'Not reachable') : h('span', { class: 'pill' }, 'Not tested');
      const test = h('button', { class: 'btn', onclick: guard(async (e) => { e.target.disabled = true; e.target.textContent = 'Testing…'; try { await api(`/api/infra/${i.id}/test`, 'POST', {}); } finally { draw(); } }) }, 'Test connection');
      return h('div', { class: 'card' }, h('div', { class: 'kv', style: 'justify-content:space-between;gap:8px;flex-wrap:wrap' }, h('div', {}, h('b', {}, i.name), ' ', h('span', { class: 'pill' }, types[i.type] || i.type)), st),
        h('p', { class: 'hint', style: 'margin:6px 0' }, [i.address ? `${i.address}${i.port ? ':' + i.port : ''}` : '', i.url, i.parentId && byId.get(i.parentId) ? `runs on ${byId.get(i.parentId).name}` : '', (i.links || []).length ? `connects to ${i.links.map((l) => byId.get(l.to)?.name).filter(Boolean).join(', ')}` : '', i.secret ? `login: ${i.secret}` : '', i.os, i.location].filter(Boolean).join(' · ')),
        i.status ? h('p', { class: 'hint' }, `${i.status.detail} (${ago(i.status.at)})`) : null, i.notes ? h('p', { style: 'white-space:pre-wrap;margin:4px 0' }, i.notes) : null,
        h('div', { class: 'formrow', style: 'margin-top:6px' }, test, h('button', { class: 'btn', onclick: () => edit(i) }, 'Update'), h('button', { class: 'btn danger', onclick: guard(async () => { if (!confirm(`Remove "${i.name}" from the map? Nothing on the real machine changes.`)) return; await api(`/api/infra/${i.id}`, 'DELETE'); draw(); }) }, 'Remove')));
    });
    view.replaceChildren(head, tabs, ...cards, rows.length ? rows : (cards.length ? [] : h('div', { class: 'card empty' }, 'Nothing here yet. Add your Proxmox host, Raspberry Pi, VMs or websites, or press Help me map it and the CEO will ask you a few questions.')));
  };
  await draw(); page = { shows: () => true, update: (ev) => ev.type === 'infra' && !document.querySelector('dialog[open]') && draw() };
}

// ---------- factory reset ----------
function pageReset() {
  crumbs('Settings', 'Factory reset');
  const removeAcc = h('input', { type: 'checkbox' });
  const begin = guard(async () => {
    let q = await api('/api/reset', 'POST', { action: 'start' });
    const ans = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'Your answer' });
    const title = h('h2', {}), prompt = h('p', { style: 'font-weight:600' }), err = h('p', { class: 'hint', style: 'color:var(--err)', role: 'alert' });
    const go = h('button', { class: 'btn danger', type: 'submit', value: 'go' }, 'Continue');
    const paint = () => { title.textContent = `Factory reset: check ${q.step} of ${q.of}`; prompt.textContent = q.prompt; ans.value = ''; ans.inputMode = q.step === 3 ? 'numeric' : 'text'; go.textContent = q.step === 3 ? 'Delete everything' : 'Continue'; ans.focus(); };
    const dlg = h('dialog', {}, h('form', { method: 'dialog' }, title, prompt, ans, err, h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'), go)));
    let finished = false;
    dlg.addEventListener('close', () => { if (!finished) api('/api/reset', 'POST', { action: 'cancel' }).catch(() => {}); dlg.remove(); });
    go.addEventListener('click', async (e) => {
      e.preventDefault(); err.textContent = ''; go.disabled = true;
      try {
        const r = await api('/api/reset', 'POST', { id: q.id, answer: ans.value, removeAccount: removeAcc.checked });
        if (r.done) { finished = true; dlg.close(); resetOverlay(); return; }
        q = r; paint();
      } catch (x) { finished = true; dlg.close(); toast(x.message, true); }
      go.disabled = false;
    });
    document.body.append(dlg); dlg.showModal(); paint();
  });
  view.replaceChildren(h('h1', {}, 'Factory reset'), h('p', { class: 'sub-title' }, 'Delete everything Apiary holds and start again from the setup wizard.'),
    h('div', { class: 'card', style: 'max-width:640px;border-color:var(--err)' },
      h('h2', {}, 'This cannot be undone'),
      h('p', {}, h('b', {}, 'Deleted: '), 'every project, chat, task and agent, the CEO and your team, memory, meetings, the infrastructure map, the Secrets vault and its auto-unlock key, saved connections (including the GitHub token), settings, and the project folders and repository copies Apiary created.'),
      h('p', {}, h('b', {}, 'Kept: '), 'Apiary itself, the access link, your sign-in account (unless you tick the box below), Claude Code and Codex sign-ins, and any folder on your computer that a project merely pointed at. Those are your own files.'),
      h('p', { class: 'hint' }, 'Want a copy first? Use Export and import before you start. To keep your secrets, include the vault in the export.'),
      h('label', { class: 'check' }, removeAcc, ' Also remove my sign-in account'),
      h('p', { class: 'hint' }, 'It takes three checks: type YES, type YES again, then answer a simple sum. A wrong answer cancels everything.'),
      h('div', { class: 'formrow', style: 'margin-top:12px' }, h('button', { class: 'btn danger', onclick: begin }, 'Start factory reset'))));
}
function resetOverlay() {
  const o = h('div', { class: 'wizard', role: 'alert', 'aria-live': 'assertive' }, h('div', { class: 'card', style: 'max-width:420px;margin:20vh auto;text-align:center' }, h('h2', {}, 'Everything was deleted'), h('p', {}, 'Apiary is restarting. This page reloads by itself and opens the setup wizard.')));
  document.body.append(o);
  const tryLoad = async () => { try { const r = await fetch('/api/state', { cache: 'no-store' }); if (r.ok) { location.hash = '#/chat'; location.reload(); return; } } catch { /* still restarting */ } setTimeout(tryLoad, 1500); };
  setTimeout(tryLoad, 2500);
}

// ---------- sign-in account ----------
async function pageSignin() {
  crumbs('Settings', 'Sign-in');
  const info = await api('/api/account');
  S.account = info; renderSignOut();
  const field = (label, type, ac, name) => { const i = h('input', { type, autocomplete: ac, name, spellcheck: 'false', autocapitalize: 'none' }); return [h('label', { class: 'f' }, label, i), i]; };
  const [uL, u] = field('Username', 'text', 'username', 'username'); u.value = info.username || '';
  const [cL, cur] = field('Current password', 'password', 'current-password', 'current');
  const [pL, pw] = field(info.exists ? 'New password' : 'Password', 'password', 'new-password', 'password');
  const [qL, pw2] = field('Type the password again', 'password', 'new-password', 'again');
  const save = guard(async () => {
    if (pw.value !== pw2.value) throw new Error('The two passwords are not the same.');
    await api('/api/account', 'POST', { username: u.value, password: pw.value, current: cur.value });
    toast(info.exists ? 'Password changed. Other devices are signed out.' : 'Sign-in is on. Other devices will now ask for it.'); pageSignin(); loadState();
  });
  const del = guard(async () => {
    if (!cur.value) throw new Error('Type your current password first.');
    await api('/api/account', 'DELETE', { current: cur.value }); toast('Sign-in removed.'); pageSignin(); loadState();
  });
  const out = guard(async () => { await api('/api/logout', 'POST', {}); location.replace('/login'); });
  view.replaceChildren(h('h1', {}, 'Sign-in'), h('p', { class: 'sub-title' }, 'A username and password, so you can open Apiary from any laptop on your network.'),
    h('div', { class: 'card', style: 'max-width:520px' },
      info.exists ? h('p', {}, h('span', { class: 'pill ok' }, 'On'), ' Signed-in username: ', h('b', {}, info.username)) : h('p', {}, h('span', { class: 'pill' }, 'Off'), ' Only this computer (or someone with the access link) can open Apiary.'),
      !info.secure ? h('p', { class: 'hint', role: 'alert' }, '⚠ You are on plain http. On a trusted home network that is usually fine, but the password travels unencrypted. For use outside your home, go through an SSH tunnel, Tailscale, or an https reverse proxy.') : null,
      h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); save(); } },
        uL, info.exists ? cL : null, pL, qL,
        h('p', { class: 'hint' }, 'At least 10 characters. Three or four random words works well.'),
        h('div', { class: 'formrow' }, h('button', { class: 'btn primary', type: 'submit' }, info.exists ? 'Change password' : 'Turn on sign-in'),
          info.exists ? h('button', { class: 'btn', type: 'button', onclick: out }, 'Sign out here') : null,
          info.exists ? h('button', { class: 'btn danger', type: 'button', onclick: del }, 'Remove sign-in') : null)),
      h('p', { class: 'hint', style: 'margin-top:12px' }, 'Forgot it? On the machine running Apiary, run: apiary user set <name>')));
}
function renderSignOut() {
  let b = $('#signout');
  if (!S.account?.exists) { b?.remove(); return; }
  if (!b) { b = h('button', { id: 'signout', class: 'btn', style: 'padding:4px 12px;font-size:12px', onclick: guard(async () => { await api('/api/logout', 'POST', {}); location.replace('/login'); }) }, 'Sign out'); $('#theme').before(b); }
}
async function pageAccess() {
  crumbs('Settings', 'Access and safety');
  view.replaceChildren(h('h1', {}, 'Access and safety'), h('p', { class: 'sub-title' }, 'Agents can run commands on this computer, so Apiary is careful about who can reach it.'),
    h('div', { class: 'card', style: 'max-width:720px' }, h('h2', {}, 'Who can open Apiary'), h('p', {}, 'By default it only listens on this computer (127.0.0.1). To use it from another device, run ', h('code', {}, 'apiary start --lan'), ' and then turn on a username and password under ', h('a', { href: '#/signin' }, 'Sign-in'), '.'),
      h('h2', { style: 'margin-top:20px' }, 'Safe and Full access'), h('p', {}, 'Safe lets an agent edit files in its own folder. Full access lets it run any command without asking. Choose per project when you create it.'),
      h('h2', { style: 'margin-top:20px' }, 'Git projects'), h('p', {}, 'In a git repository every agent works on its own branch and checkout, so your own working copy is never touched. Nothing is pushed until you open a pull request.')));
  view.append(await trustCard());
}
// The six slider positions. Keep in step with TRUST_LEVELS in src/command-rules.js.
const TRUST_LABELS = ['Ask me for every command', 'Read-only commands run; everything else asks', 'Simple commands run; chains, scripts and changes ask', 'Chains run too; scripts, changes and destructive commands ask', 'Everything runs except deleting, rebooting and destroying', 'Everything runs without asking'];
async function trustCard() {
  const pol = await api('/api/policy').catch(() => ({ rules: [] }));
  const rulesFor = (id) => (pol.rules || []).filter((r) => r.agent === id);
  const levels = S.agents.map((a) => Math.trunc(Number(a.trust)) || 0);
  const common = levels.length && levels.every((l) => l === levels[0]) ? levels[0] : null;
  const rows = [];   // one per agent, so the master slider can move them all
  const paint = (label, level) => { label.textContent = `${level}: ${TRUST_LABELS[level]}`; };
  const masterLabel = h('small', { class: 'hint', 'aria-live': 'polite' }, common !== null ? `All agents: ${common}: ${TRUST_LABELS[common]}` : 'Agents are at different positions. Move this to set them all.');
  const refreshMaster = () => {
    const vals = rows.map((x) => Number(x.slider.value));
    if (vals.length && vals.every((v) => v === vals[0])) { master.value = String(vals[0]); masterLabel.textContent = `All agents: ${vals[0]}: ${TRUST_LABELS[vals[0]]}`; }
    else masterLabel.textContent = 'Agents are at different positions. Move this to set them all.';
  };
  const master = h('input', { type: 'range', min: '0', max: '5', step: '1', value: String(common ?? 0), style: 'width:100%', 'aria-label': 'How much all agents may do without asking',
    oninput: (e) => { masterLabel.textContent = `All agents: ${e.target.value}: ${TRUST_LABELS[Number(e.target.value)]}`; },
    onchange: guard(async (e) => {
      const level = Number(e.target.value);
      const r = await api('/api/agents/trust-all', 'POST', { level });
      for (const x of rows) { x.slider.value = String(level); paint(x.label, level); }
      for (const a of S.agents) a.trust = level;
      masterLabel.textContent = `All agents: ${level}: ${TRUST_LABELS[level]}`;
      toast(`All ${r.count} agents: ${r.text}`);
    }) });
  const card = h('div', { class: 'card', style: 'max-width:720px;margin-top:16px' }, h('h2', { style: 'margin-top:0' }, 'How much may each agent do without asking?'),
    h('p', { class: 'hint' }, 'Move the slider all the way left and every command asks you. Move it all the way right and everything runs. Deny rules on Approval rules always win. An agent on Full access runs everything, whatever its slider says.'),
    h('div', { style: 'margin:14px 0;padding-bottom:12px;border-bottom:1px solid var(--line, #ddd)' }, h('b', {}, 'All agents at once'), master, masterLabel));
  for (const a of S.agents) {
    const level = Math.trunc(Number(a.trust)) || 0;
    const label = h('small', { class: 'hint', 'aria-live': 'polite' }, `${level}: ${TRUST_LABELS[level]}`);
    const slider = h('input', { type: 'range', min: '0', max: '5', step: '1', value: String(level), 'aria-label': `How much ${a.name} may do without asking`, style: 'width:100%',
      oninput: (e) => { label.textContent = `${e.target.value}: ${TRUST_LABELS[Number(e.target.value)]}`; },
      onchange: guard(async (e) => { const r = await api(`/api/agents/${a.id}/trust`, 'POST', { level: Number(e.target.value) }); a.trust = r.trust; toast(`${a.name}: ${r.text}`); refreshMaster(); }) });
    rows.push({ slider, label });
    const mine = rulesFor(a.id);
    card.append(h('div', { style: 'margin:14px 0' }, h('div', { class: 'kv', style: 'justify-content:space-between;gap:8px' }, h('b', {}, a.name), a.title ? h('small', { class: 'hint' }, a.title) : null,
      a.access === 'full' ? h('span', { class: 'pill work' }, 'Full access') : null), slider, h('div', { class: 'kv', style: 'justify-content:space-between' }, h('small', { class: 'hint' }, 'Ask me'), h('small', { class: 'hint' }, 'Run everything')), label,
      mine.length ? h('div', { style: 'margin-top:8px' }, h('small', { class: 'hint' }, 'Approval rules that decide for this agent:'), mine.map((r) => h('div', { class: 'kv', style: 'justify-content:space-between;gap:8px;margin:4px 0' }, h('small', {}, r.text),
        h('button', { class: 'btn danger', onclick: guard(async () => { await api('/api/policy/' + r.id, 'DELETE'); toast('Rule removed'); pageAccess(); }) }, 'Remove')))) : null));
  }
  return card;
}
function pageFolders() {
  crumbs('Settings', 'Folders');
  view.replaceChildren(h('h1', {}, 'Folders'), h('p', { class: 'sub-title' }, 'Where Apiary keeps things on this machine.'),
    h('div', { class: 'card', style: 'max-width:720px' }, h('table', { class: 'tbl', style: 'min-width:0' }, h('tbody', {}, [['~/.apiary/state.json', 'Projects, chats and settings (private to your user)'], ['~/.apiary/workspaces/', 'Folders for projects that are not tied to a repository'], ['~/.apiary/repos/', 'Repositories cloned from GitHub'], ['~/.apiary/worktrees/', 'One checkout per agent working on a repository']].map(([p, d]) => h('tr', {}, h('td', { class: 'mono' }, p), h('td', { class: 'hint' }, d))))),
      h('p', { class: 'hint', style: 'margin-top:12px' }, 'Set APIARY_HOME to move all of this.')));
}

// ---------- first-run setup wizard ----------
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
async function openSetup(startAt = 0) {
  document.querySelector('.wizard')?.remove();
  await refreshConns();
  const W = { step: startAt, iv: { answers: [], cur: null, busy: false, result: null, err: '' }, ceoName: S.agents.find((a) => a.kind === 'general' && S.orgDone)?.name || 'Captain Atlas', meet: { frequency: S.meeting?.frequency && S.meeting.frequency !== 'off' ? S.meeting.frequency : 'daily', time: S.meeting?.time || '00:00', weekday: S.meeting?.weekday ?? 0 }, tests: {}, models: {}, pick: {}, other: {}, defAI: S.defaultProvider, svc: null, svcWant: true, startNow: false, github: null };
  const root = h('div', { class: 'wizard', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Set up Apiary' });
  document.body.append(root);
  const NAMES = ['Welcome', 'Connect your AI', 'Default models', 'Your CEO', 'Your team', 'Meetings', 'GitHub', 'Secrets', 'Sign-in', 'Startup', 'All set'];
  const conn = (id) => S.conns.find((c) => c.id === id);
  const okAI = () => ['claude', 'codex'].filter((id) => W.tests[id]?.ok);
  const finish = guard(async () => {
    if (!S.account?.exists) { go(8); throw new Error('Create your sign-in first.'); }
    await api('/api/settings', 'PUT', { onboardingDone: true, ...(W.defAI ? { defaultProvider: W.defAI } : {}) });
    S.onboardingDone = true; if (W.defAI) S.defaultProvider = W.defAI;
    root.remove(); await loadState(); await refreshConns(); location.hash = '#/chat'; route();
  });
  // One panel per service: shows if it works; if not, how to sign in (terminal) or paste a key (web).
  function connPanel(id, onChange) {
    const box = h('div', { class: 'card wiz-card' });
    const isGh = id === 'github', webM = isGh ? 'token' : 'api', info = CINFO[id];
    const test = async () => {
      W.tests[id] = { state: 'checking' }; draw();
      try { const r = await api(`/api/connections/${id}/test`, 'POST', {}); W.tests[id] = r.ok ? { ok: true, detail: r.detail } : { ok: false, error: r.error }; }
      catch (e) { W.tests[id] = { ok: false, error: e.message }; }
      await refreshConns(); draw(); onChange?.();
    };
    const setMethod = async (m) => { await api('/api/connections/' + id, 'PUT', { method: m }); await refreshConns(); W.tests[id] = { ok: false, error: '' }; draw(); };
    function draw() {
      const c = conn(id), t = W.tests[id] || { ok: false, error: '' };
      const head = h('div', { class: 'kv', style: 'justify-content:space-between;margin-bottom:10px' }, h('h2', { style: 'margin:0' }, info.title),
        t.state === 'checking' ? h('span', { class: 'pill info' }, 'Checking…') : h('span', { class: 'pill ' + (t.ok ? 'ok' : 'err') }, t.ok ? 'Connected' : 'Not connected'));
      if (t.state === 'checking') { box.replaceChildren(head, h('p', { class: 'hint' }, 'Making a tiny test request to confirm you are signed in…')); return; }
      if (t.ok) { box.replaceChildren(head, h('p', {}, `✔ ${t.detail || 'Works'}`, h('span', { class: 'hint' }, ` · via ${c.method === 'cli' ? 'terminal' : 'web'}`)), h('button', { class: 'btn', onclick: () => { W.tests[id] = { ok: false, error: '' }; draw(); } }, 'Change how it connects')); return; }
      const key = h('input', { type: 'password', autocomplete: 'off', placeholder: isGh ? 'ghp_… or github_pat_…' : 'Paste your key', 'aria-label': info.key });
      const ghTerminal = () => h('div', {},
        !c.cli.found
          ? h('div', {}, h('p', {}, 'Apiary needs the free GitHub tool to sign in. It installs for this user only.'), h('div', { class: 'kv' }, installBtn('gh', () => { refreshConns().then(draw); }, 'Install GitHub tool for me')))
          : ghSignIn(c, test),
        h('details', { style: 'margin-top:10px' }, h('summary', { class: 'hint' }, 'Prefer the terminal?'), h('p', { class: 'hint' }, 'Run this once, then press Check again:'), cmdBox(info.login),
          h('div', { class: 'kv', style: 'margin-top:8px' }, h('button', { class: 'btn', onclick: guard(test) }, 'I have signed in. Check again'))));
      const terminal = isGh ? ghTerminal() : h('div', {}, c.cli.found ? null : h('div', {}, isGh ? null : h('div', { class: 'kv', style: 'margin-bottom:6px' }, installBtn(id, () => { refreshConns().then(() => go(1)); })), h('p', { class: 'hint' }, `${info.title.replace(' Code', '')} is not installed. ${isGh ? 'Install it:' : 'Or run it yourself:'}`), cmdBox(info.install)),
        h('p', { class: 'hint' }, isGh ? 'Sign in once in a terminal:' : 'Sign in once in a terminal (Apiary then reuses that login):'), cmdBox(info.login),
        h('div', { class: 'kv', style: 'margin-top:10px' }, h('button', { class: 'btn primary', onclick: guard(test) }, 'I have signed in. Check again')));
      const web = h('div', {}, h('label', { class: 'f' }, info.key, key, h('small', {}, isGh ? 'Needs “repo” access. Stored only on this machine in a private file.' : 'Stored only on this machine in a private file. Web agents can chat but cannot edit files.')),
        h('button', { class: 'btn primary', onclick: guard(async () => { if (!key.value.trim()) { toast('Paste the key first', true); return; } await api('/api/connections/' + id, 'PUT', { method: webM, [isGh ? 'token' : 'apiKey']: key.value }); await refreshConns(); await test(); }) }, 'Save and check'));
      box.replaceChildren(head,
        t.error ? h('p', { class: 'hint', style: 'color:var(--err)' }, t.error) : null,
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Connection method', style: 'margin-bottom:14px' },
          h('button', { 'aria-pressed': String(c.method === 'cli'), onclick: guard(() => setMethod('cli')) }, isGh ? 'Sign in' : 'Terminal'),
          h('button', { 'aria-pressed': String(c.method === webM), onclick: guard(() => setMethod(webM)) }, isGh ? 'Web · token' : 'Web · API key')),
        c.method === 'cli' ? terminal : web);
    }
    draw();
    box.recheck = test;
    return box;
  }

  const steps = [
    // 0 Welcome
    () => h('div', {}, h('h1', {}, 'Welcome to Apiary'), h('p', { class: 'sub-title' }, 'A short setup: connect your AI, create your CEO and team through a few questions, choose when your team meets, and decide whether Apiary starts automatically.'),
      h('div', { class: 'wiz-actions' }, h('button', { class: 'btn', onclick: guard(async () => { if (!S.account?.exists) { go(8); toast('One thing first: create your sign-in. The rest of setup can wait.', true); return; } await api('/api/settings', 'PUT', { onboardingDone: true }); S.onboardingDone = true; root.remove(); toast('You can run setup again from Settings → Setup guide'); if (cur() === '#/setup') location.hash = '#/projects'; }) }, 'Skip for now'), h('span', { style: 'flex:1' }), h('button', { class: 'btn primary big', onclick: () => go(1) }, 'Start setup'))),
    // 1 Connect AI
    () => {
      const panels = ['claude', 'codex'].map((id) => connPanel(id, () => { cont.disabled = !okAI().length; }));
      const cont = h('button', { class: 'btn primary big', disabled: !okAI().length, onclick: () => go(2) }, 'Continue');
      // Detect what is already set up: anything that looks configured gets a real test right away.
      for (const [i, id] of ['claude', 'codex'].entries()) { const c = conn(id); if (!W.tests[id] && c.ready) panels[i].recheck(); else if (!W.tests[id]) W.tests[id] = { ok: false, error: '' }; }
      return h('div', {}, h('h1', {}, 'Connect your AI'), h('p', { class: 'sub-title' }, 'Connect at least one. Apiary checks what you already have set up; anything not signed in is explained below.'), getStartedCard(() => { refreshConns().then(() => go(1)); }) || h('span'), ...panels,
        h('div', { class: 'wiz-actions' }, h('button', { class: 'btn', onclick: () => go(0) }, 'Back'), h('span', { style: 'flex:1' }), h('button', { class: 'btn', onclick: () => go(3) }, 'Skip'), cont));
    },
    // 2 Default models
    () => {
      const ids = okAI();
      const box = h('div', {});
      const load = async () => {
        box.replaceChildren(h('p', { class: 'hint' }, 'Looking up available models…'));
        const parts = [];
        for (const id of ids) {
          if (!W.models[id]) W.models[id] = await api(`/api/connections/${id}/models`).catch(() => ({ source: 'suggestions', models: [] }));
          const m = W.models[id], cur = W.pick[id] ?? conn(id).api.model ?? '';
          const known = m.models.some((x) => x.id === cur);
          const other = h('input', { type: 'text', placeholder: 'Model name', value: known ? '' : cur, 'aria-label': `${CINFO[id].title} model name`, style: known || !cur ? 'display:none;margin-top:8px' : 'margin-top:8px' });
          const sel = h('select', { 'aria-label': `Default model for ${CINFO[id].title}`, onchange: (e) => { W.pick[id] = e.target.value === '__other' ? other.value : e.target.value; other.style.display = e.target.value === '__other' ? '' : 'none'; if (e.target.value === '__other') other.focus(); } },
            h('option', { value: '', selected: !cur }, 'Default (let it choose)'), m.models.map((x) => h('option', { value: x.id, selected: x.id === cur }, x.label)), h('option', { value: '__other', selected: !!cur && !known }, 'Other…'));
          other.oninput = () => { W.pick[id] = other.value.trim(); };
          W.pick[id] = cur;
          parts.push(h('div', { class: 'card wiz-card' }, h('h2', {}, CINFO[id].title), h('label', { class: 'f' }, 'Default model', sel, other, h('small', {}, m.source === 'provider' ? 'Listed by your account.' : id === 'codex' ? 'Leave on Default to use whatever Codex is set to, or type a model name.' : 'Suggestions. Choose Other to type any model name your plan allows.'))));
        }
        if (ids.length > 1) {
          W.defAI ||= ids[0];
          const dd = () => ddBox.replaceChildren(h('h2', {}, 'Which AI should lead new projects?'), h('div', { class: 'choice' }, ids.map((id) => h('button', { type: 'button', 'aria-pressed': String(W.defAI === id), onclick: () => { W.defAI = id; dd(); } }, h('b', {}, CINFO[id].title), h('small', {}, 'You can change it per project')))));
          const ddBox = h('div', { class: 'card wiz-card' }); dd(); parts.push(ddBox);
        } else if (ids.length === 1) W.defAI = ids[0];
        box.replaceChildren(...(parts.length ? parts : [h('p', { class: 'hint' }, 'No AI connected yet. Go back and connect one, or continue and do it later in Connections.')]));
      };
      load();
      return h('div', {}, h('h1', {}, 'Choose default models'), h('p', { class: 'sub-title' }, 'The model each AI uses unless a project says otherwise.'), box,
        h('div', { class: 'wiz-actions' }, h('button', { class: 'btn', onclick: () => go(1) }, 'Back'), h('span', { style: 'flex:1' }), h('button', { class: 'btn primary big', onclick: guard(async () => {
          for (const id of ids) await api('/api/connections/' + id, 'PUT', { model: W.pick[id] || '' });
          await api('/api/settings', 'PUT', { defaultProvider: W.defAI || '' }); S.defaultProvider = W.defAI || ''; await refreshConns(); go(3);
        }) }, 'Continue')));
    },
    // 3 Your CEO: the AI interviews you
    () => {
      const iv = W.iv, box = h('div');
      const name = h('input', { type: 'text', value: W.ceoName, 'aria-label': 'Name of your CEO', oninput: (e) => (W.ceoName = e.target.value) });
      const next = async () => {
        iv.busy = true; iv.err = ''; draw2();
        try {
          const r = await api('/api/interview', 'POST', { answers: iv.answers, ceoName: '' });
          if (r.done) { iv.result = r; if (r.suggestedCeoName && (W.ceoName === 'Captain Atlas')) W.ceoName = r.suggestedCeoName; go(4); return; }
          iv.cur = r;
        } catch (e) { iv.err = e.message; }
        iv.busy = false; draw2();
      };
      const answer = (text) => { text = String(text || '').trim(); if (!text) return; iv.answers.push({ q: iv.cur.question, a: text }); iv.cur = null; next(); };
      function draw2() {
        const picked = new Set(), free = h('textarea', { rows: '2', placeholder: 'Add your own answer or tell more (optional)', 'aria-label': 'Your own answer or more detail' });
        const send = h('button', { class: 'btn primary', disabled: true, onclick: () => submit() }, 'Send answer');
        const sync = () => { send.disabled = !picked.size && !free.value.trim(); };
        free.oninput = sync;
        const submit = () => { const t = [...picked, free.value.trim()].filter(Boolean).join('; '); if (t) answer(t); };
        box.replaceChildren(
          ...iv.answers.map((a) => h('div', { class: 'card wiz-card', style: 'padding:12px 16px' }, h('b', {}, a.q), h('p', { style: 'margin:4px 0 0' }, a.a))),
          iv.busy ? h('p', { class: 'hint', role: 'status' }, iv.answers.length ? 'Thinking about your answer…' : 'Preparing the first question…')
            : iv.cur ? h('div', { class: 'card wiz-card' }, h('small', { class: 'hint' }, `Question ${iv.cur.asked} of up to ${iv.cur.max}`), h('h2', { style: 'margin:4px 0 4px' }, iv.cur.question),
              h('p', { class: 'hint', style: 'margin:0 0 10px' }, 'Pick as many as fit, and add your own words below.'),
              h('div', { class: 'choice', role: 'group', 'aria-label': 'Suggested answers' }, iv.cur.choices.map((c) => { const btn = h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => { if (picked.has(c)) picked.delete(c); else picked.add(c); btn.setAttribute('aria-pressed', String(picked.has(c))); btn.classList.toggle('on', picked.has(c)); sync(); } }, h('b', {}, c)); return btn; })),
              h('div', { style: 'margin-top:12px' }, free), h('div', { class: 'kv', style: 'margin-top:8px;justify-content:flex-end' }, send))
            : null,
          iv.err ? h('p', { class: 'hint', style: 'color:var(--err)', role: 'alert' }, iv.err) : null);
      }
      draw2();
      if (!iv.cur && !iv.busy && !iv.result) next();
      return h('div', {}, h('h1', {}, 'Create your CEO'), h('p', { class: 'sub-title' }, 'Your CEO runs your organisation: it takes what you ask for and hands it to the right specialist. Answer a few questions about your setup and goals. The AI asks them one at a time, then proposes the team you need. Never type passwords here; secrets go in the vault later.'),
        h('label', { class: 'f' }, 'Name your CEO', name, h('small', {}, 'A comic-book style name is suggested. Type any name you like.')), box,
        h('div', { class: 'wiz-actions' }, h('button', { class: 'btn', onclick: () => go(2) }, 'Back'), h('span', { style: 'flex:1' }),
          h('button', { class: 'btn', onclick: () => { iv.result = { done: true, overview: iv.answers.map((a) => `**${a.q}** ${a.a}`).join('\n\n'), team: [] }; go(4); } }, 'Skip the questions')));
    },
    // 4 Your team: review the proposal
    () => {
      const r = W.iv.result || { team: [], overview: '' };
      W.team ||= r.team.map((t) => ({ ...t, on: true }));
      const overview = h('textarea', { rows: '5', 'aria-label': 'What was understood about your setup' }); overview.value = W.ovText ?? r.overview; overview.oninput = () => (W.ovText = overview.value);
      const cards = W.team.map((t) => {
        const nm = h('input', { type: 'text', value: t.name, 'aria-label': `Name for the ${t.title}`, oninput: (e) => (t.name = e.target.value) });
        return h('div', { class: 'card wiz-card' }, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: t.on, 'aria-label': `Hire ${t.title}`, onchange: (e) => (t.on = e.target.checked) }), h('span', { style: 'flex:1' }, h('b', {}, `${t.title}`), ` · ${t.departmentLabel}`, h('small', { class: 'hint', style: 'display:block' }, t.role))),
          h('label', { class: 'f', style: 'margin-top:8px' }, 'Name', nm), h('p', { class: 'hint', style: 'margin:4px 0' }, `Why: ${t.reason || 'not given'}`),
          h('details', {}, h('summary', {}, 'Profile and guardrails (written for you)'), h('pre', { class: 'diffstat mono', style: 'white-space:pre-wrap' }, t.instructions)));
      });
      const err = h('p', { class: 'hint', style: 'color:var(--err)', role: 'alert' });
      return h('div', {}, h('h1', {}, 'Your team'), h('p', { class: 'sub-title' }, `${W.ceoName} will lead these people. Untick anyone you do not need and rename anyone you like. Their instructions and guardrails are already written, and saved as Markdown files you can edit later.`),
        h('label', { class: 'f' }, 'What I understood about your setup (you can edit it)', overview),
        cards.length ? cards : h('div', { class: 'card empty' }, 'No team members were proposed. Your CEO can suggest hires later, when there is work that needs a specialist.'), err,
        h('div', { class: 'wiz-actions' }, h('button', { class: 'btn', onclick: () => { W.team = null; W.iv = { answers: [], cur: null, busy: false, result: null, err: '' }; go(3); } }, 'Redo the questions'), h('span', { style: 'flex:1' }),
          h('button', { class: 'btn primary big', onclick: guard(async () => {
            err.textContent = '';
            try { W.created = await api('/api/org', 'POST', { ceoName: W.ceoName, overview: overview.value, team: W.team.filter((t) => t.on).map((t) => ({ title: t.title, name: t.name, role: t.role, department: t.department, reason: t.reason, custom: t.custom })) }); await loadState(); go(5); }
            catch (e) { err.textContent = e.message; }
          }) }, 'Create my CEO and team')));
    },
    // 5 Meetings
    () => {
      const m = W.meet, box = h('div');
      const draw3 = () => box.replaceChildren(h('div', { class: 'choice' }, [['off', 'Never', 'No automatic meetings'], ['daily', 'Every day', 'A daily catch-up'], ['weekly', 'Every week', 'A weekly review']].map(([v, t, sub]) => h('button', { type: 'button', 'aria-pressed': String(m.frequency === v), onclick: () => { m.frequency = v; draw3(); } }, h('b', {}, t), h('small', {}, sub)))),
        m.frequency !== 'off' ? h('div', { class: 'kv', style: 'margin-top:12px' }, m.frequency === 'weekly' ? h('select', { 'aria-label': 'Day of the week', onchange: (e) => (m.weekday = Number(e.target.value)) }, ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => h('option', { value: i, selected: m.weekday === i }, d))) : null, h('label', { class: 'f', style: 'margin:0' }, 'At what time?', h('input', { type: 'time', value: m.time, 'aria-label': 'Meeting time', onchange: (e) => (m.time = e.target.value || '00:00') }))) : null);
      draw3();
      return h('div', {}, h('h1', {}, 'Team meetings'), h('p', { class: 'sub-title' }, 'Your agents can meet to stay in sync: each one says what they did and what changed, then everyone hears everyone else, so nobody works with out-of-date information. The minutes are saved as Markdown. When should they meet? (Midnight is a good time.)'), box,
        h('div', { class: 'wiz-actions' }, h('button', { class: 'btn', onclick: () => go(4) }, 'Back'), h('span', { style: 'flex:1' }), h('button', { class: 'btn primary big', onclick: guard(async () => { await api('/api/settings', 'PUT', { meeting: { frequency: m.frequency, time: m.time, weekday: m.weekday } }); m.saved = true; go(6); }) }, 'Continue')));
    },
    // 6 GitHub
    () => {
      const p = connPanel('github'); if (!W.tests.github) { const c = conn('github'); if (c.status?.ok || c.cli.found) p.recheck(); }
      return h('div', {}, h('h1', {}, 'Connect GitHub (optional)'), h('p', { class: 'sub-title' }, 'Lets agents work on your repositories and open pull requests. You can do this later.'), p,
        h('div', { class: 'wiz-actions' }, h('button', { class: 'btn', onclick: () => go(5) }, 'Back'), h('span', { style: 'flex:1' }), h('button', { class: 'btn primary big', onclick: () => go(7) }, W.tests.github?.ok ? 'Continue' : 'Skip for now')));
    },
    // 7 Secrets vault
    () => {
      const box = h('div'), pass = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Passphrase (8+ characters)', 'aria-label': 'Vault passphrase' }), again = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Repeat it', 'aria-label': 'Repeat the passphrase' }), err = h('p', { class: 'hint', style: 'color:var(--err)', role: 'alert' });
      const made = S.vault?.exists || W.vaultMade;
      return h('div', {}, h('h1', {}, 'Secrets vault (optional)'), h('p', { class: 'sub-title' }, 'Passwords and keys never go in plain text. The vault encrypts them with a passphrase only you know. You then choose which agent may use which secret, and approve each use: once, or always.'),
        made ? h('div', { class: 'card wiz-card' }, h('p', {}, '✔ A vault already exists. Add secrets under Settings → Secrets.'))
          : h('div', { class: 'card wiz-card' }, h('label', { class: 'f' }, 'Passphrase', pass), h('label', { class: 'f' }, 'Repeat passphrase', again), h('small', { class: 'hint' }, 'If you forget it, the secrets cannot be recovered. After Apiary restarts you unlock the vault again with it.'), err,
            h('button', { class: 'btn primary', onclick: guard(async () => { err.textContent = ''; if (pass.value !== again.value) { err.textContent = 'The two passphrases differ.'; return; } try { await api('/api/vault/init', 'POST', { passphrase: pass.value }); W.vaultMade = true; await loadState(); draw(); } catch (e) { err.textContent = e.message; } }) }, 'Create the vault')),
        h('div', { class: 'wiz-actions' }, h('button', { class: 'btn', onclick: () => go(6) }, 'Back'), h('span', { style: 'flex:1' }), h('button', { class: 'btn primary big', onclick: () => go(8) }, made ? 'Continue' : 'Skip for now')));
    },
    // 8 Sign-in (required: set before anything else can end the setup)
    () => {
      const have = !!S.account?.exists, f = (label, type, ac) => { const i = h('input', { type, autocomplete: ac, spellcheck: 'false', autocapitalize: 'none' }); return [h('label', { class: 'f' }, label, i), i]; };
      const [uL, u] = f('Username', 'text', 'username'), [pL, pw] = f('Password', 'password', 'new-password'), [qL, pw2] = f('Type the password again', 'password', 'new-password');
      const next = h('button', { class: 'btn primary big', disabled: !have, onclick: () => go(9) }, 'Continue');
      const make = guard(async () => {
        if (pw.value !== pw2.value) throw new Error('The two passwords are not the same.');
        const r = await api('/api/account', 'POST', { username: u.value, password: pw.value });
        S.account = r; renderSignOut(); W.step = 8; draw(); toast('Sign-in created.');
      });
      return h('div', {}, h('h1', {}, 'Create your sign-in'), h('p', { class: 'sub-title' }, 'A username and password so only you can open Apiary, from this computer or any other on your network. This step is required.'),
        h('div', { class: 'card wiz-card' }, have ? h('p', {}, h('span', { class: 'pill ok' }, 'Created'), ' You will sign in as ', h('b', {}, S.account.username), '. You can change the password later under Security > Sign-in.')
          : h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); make(); } }, uL, pL, qL, h('p', { class: 'hint' }, 'At least 10 characters. Three or four random words works well. Forgot it later? On this machine run: apiary user set <name>'), h('button', { class: 'btn primary', type: 'submit' }, 'Create sign-in'))),
        h('div', { class: 'wiz-actions' }, h('button', { class: 'btn', onclick: () => go(7) }, 'Back'), h('span', { style: 'flex:1' }), next));
    },
    // 9 Startup
    () => {
      const box = h('div', {});
      const draw = () => {
        const sv = W.svc;
        if (!sv) { box.replaceChildren(h('p', { class: 'hint' }, 'Checking this machine…')); return; }
        if (!sv.supported) { box.replaceChildren(h('div', { class: 'card wiz-card' }, h('p', {}, sv.reason), h('p', { class: 'hint' }, 'You can start Apiary yourself with the command: apiary')));
          return; }
        box.replaceChildren(h('div', { class: 'choice' },
          h('button', { type: 'button', 'aria-pressed': String(W.svcWant), onclick: () => { W.svcWant = true; draw(); } }, h('b', {}, 'Yes, start it automatically'), h('small', {}, 'Runs in the background when you log in')),
          h('button', { type: 'button', 'aria-pressed': String(!W.svcWant), onclick: () => { W.svcWant = false; draw(); } }, h('b', {}, 'No, I will start it myself'), h('small', {}, 'Run “apiary” whenever you need it'))),
          sv.enabled ? h('p', { class: 'hint' }, '✔ It is already set to start automatically.') : null,
          W.svcWant && !sv.enabled ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: W.startNow, onchange: (e) => (W.startNow = e.target.checked), 'aria-label': 'Switch to the background service now' }), h('span', {}, h('b', {}, 'Switch to the background service now'), h('small', { class: 'hint', style: 'display:block' }, 'Apiary restarts in a few seconds; this page reloads on its own.'))) : null);
      };
      api('/api/service').then((s) => { W.svc = s; W.svcWant = s.supported ? (s.enabled || W.svcWant) : false; draw(); }).catch((e) => { W.svc = { supported: false, reason: e.message }; draw(); });
      draw();
      return h('div', {}, h('h1', {}, 'Run Apiary automatically?'), h('p', { class: 'sub-title' }, 'Apiary can start by itself whenever you log in, so it is always ready at its address.'), box,
        h('div', { class: 'wiz-actions' }, h('button', { class: 'btn', onclick: () => go(8) }, 'Back'), h('span', { style: 'flex:1' }), h('button', { class: 'btn primary big', onclick: guard(async () => {
          const sv = W.svc;
          if (sv?.supported) {
            if (W.svcWant && !sv.enabled) {
              if (W.startNow && S.account?.exists) { await api('/api/settings', 'PUT', { onboardingDone: true, ...(W.defAI ? { defaultProvider: W.defAI } : {}) }); }
              await api('/api/service', 'POST', { enabled: true, startNow: W.startNow });
              if (W.startNow) { root.replaceChildren(h('div', { class: 'wiz-body' }, h('h1', {}, 'Restarting as a service…'), h('p', { class: 'sub-title' }, 'This page will reload in a few seconds.'))); await settle(3500); for (let i = 0; i < 20; i++) { try { await api('/api/state'); break; } catch { await settle(1000); } } location.hash = '#/projects'; location.reload(); return; }
              W.svc = await api('/api/service');
            } else if (!W.svcWant && sv.enabled) W.svc = await api('/api/service', 'POST', { enabled: false });
          }
          go(10);
        }) }, 'Continue')));
    },
    // 10 Done
    () => {
      const rows = [];
      for (const id of ['claude', 'codex']) { const c = conn(id); rows.push(h('li', {}, h('b', {}, CINFO[id].title), W.tests[id]?.ok ? ` connected (${c.method === 'cli' ? 'terminal' : 'web'}), model: ${c.api.model || 'default'}${W.defAI === id ? ', leads new projects' : ''}` : ' not connected yet')); }
      rows.push(h('li', {}, h('b', {}, 'Your CEO'), S.orgDone || W.created ? ` ${W.ceoName} leads ${W.created ? W.created.hired : 'your'} team${W.created ? ` (${W.created.hired} hired)` : ''}` : ' not created yet (you can do this from the Chat page)'));
      rows.push(h('li', {}, h('b', {}, 'Team meetings'), W.meet.saved ? (W.meet.frequency === 'off' ? ' off' : ` ${W.meet.frequency === 'daily' ? 'every day' : 'every week'} at ${W.meet.time}`) : ' not set'));
      rows.push(h('li', {}, h('b', {}, 'GitHub'), W.tests.github?.ok ? ` connected${W.tests.github.detail ? ': ' + W.tests.github.detail : ''}` : ' not connected (optional)'));
      rows.push(h('li', {}, h('b', {}, 'Startup'), W.svc?.enabled ? ' starts automatically at login' : ' you start it yourself'));
      return h('div', {}, h('h1', {}, 'You are all set'), h('p', { class: 'sub-title' }, 'You can change any of this later under Connections and Settings.'), h('div', { class: 'card wiz-card' }, h('ul', { class: 'summary' }, rows)),
        h('div', { class: 'wiz-actions' }, h('button', { class: 'btn', onclick: () => go(9) }, 'Back'), h('span', { style: 'flex:1' }), h('button', { class: 'btn primary big', onclick: finish }, 'Open Apiary')));
    },
  ];
  function go(n) { W.step = n; draw(); }
  function draw() {
    root.replaceChildren(h('div', { class: 'wiz-body' },
      W.step > 0 && W.step < 10 ? h('ol', { class: 'stepper', 'aria-label': 'Progress' }, NAMES.slice(1, 10).map((n, i) => h('li', { 'aria-current': W.step === i + 1 ? 'step' : null, class: W.step > i + 1 ? 'done' : '' }, n))) : null,
      steps[W.step]()));
    root.scrollTop = 0;
  }
  draw();
}

function pageStartup() {
  crumbs('Settings', 'Startup');
  const box = h('div', { class: 'card', style: 'max-width:640px' }, h('p', { class: 'hint' }, 'Checking…'));
  view.replaceChildren(h('h1', {}, 'Startup'), h('p', { class: 'sub-title' }, 'Start Apiary automatically when you log in.'), box);
  const draw = (s) => {
    if (!s.supported) { box.replaceChildren(h('p', {}, s.reason), h('p', { class: 'hint' }, 'Start it yourself with: apiary')); return; }
    box.replaceChildren(h('div', { class: 'kv', style: 'justify-content:space-between' }, h('div', {}, h('b', {}, 'Run automatically at login'), h('p', { class: 'hint', style: 'margin:2px 0 0' }, s.enabled ? `On${s.active ? ' (running as a service now)' : ''}` : 'Off')),
      h('button', { class: s.enabled ? 'btn' : 'btn primary', onclick: guard(async () => { draw(await api('/api/service', 'POST', { enabled: !s.enabled })); toast(s.enabled ? 'Turned off' : 'Turned on. It starts at your next login'); }) }, s.enabled ? 'Turn off' : 'Turn on')),
      h('p', { class: 'hint', style: 'margin-top:14px' }, 'Uses a systemd user service. Turning it on does not interrupt this running copy.'));
  };
  api('/api/service').then(draw).catch((e) => box.replaceChildren(h('p', {}, e.message)));
}

// ---------- boot ----------
(async () => {
  try { await loadState(); } catch (e) { toast(e.message, true); }
  connectEvents(); route(); refreshConns(); loadUsage(); if (S.update?.state === 'installing') updateOverlay(S.version);
  api('/api/tools').then((t) => { if (t.install.state === 'running') installOverlay(t.install.tools); }).catch(() => {});
  if (!S.onboardingDone && cur() !== '#/setup') openSetup();
})();
