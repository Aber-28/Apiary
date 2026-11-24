// Apiary web UI: vanilla JS, no build step. All text is inserted with textContent (never innerHTML),
// so agent output can never inject markup.
const S = { agents: [], providers: [], limits: {}, defs: [], conns: null, msgs: {}, logs: {}, stream: {}, activity: {}, sel: null, tab: 'chat', open: {}, version: '' };
const $ = (s) => document.querySelector(s);
const view = $('#view');
let page = null; // { update?() } for the current route

const ICON = {
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  agents: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  sliders: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M12 1v2 M12 21v2 M4.22 4.22l1.42 1.42 M18.36 18.36l1.42 1.42 M1 12h2 M21 12h2 M4.22 19.78l1.42-1.42 M18.36 5.64l1.42-1.42',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  plus: 'M12 5v14 M5 12h14', chev: 'M6 9l6 6 6-6',
};
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
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
const copy = (text) => navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Copy failed', true));
const cmdBox = (text) => h('div', { class: 'cmd mono' }, h('code', {}, text), h('button', { type: 'button', onclick: () => copy(text) }, 'Copy'));
const ago = (ts) => { const s = (Date.now() - ts) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`; };
const STATUS = { idle: ['ok', 'Idle'], working: ['work', 'Working'], waiting: ['info', 'Waiting for team'], error: ['err', 'Error'] };
const pill = (status) => { const [c, t] = STATUS[status] || ['', status]; return h('span', { class: 'pill ' + c }, t); };
const PNAME = { claude: 'Claude', codex: 'Codex', mock: 'Mock' };
const leads = () => S.agents.filter((a) => !a.parentId).sort((a, b) => b.createdAt - a.createdAt);
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
$('#theme').onclick = () => applyTheme(document.documentElement.className === 'dark' ? 'light' : 'dark');
$('#menu').onclick = () => $('#side').classList.toggle('open');
applyTheme(document.documentElement.className || 'dark');

// ---------- sidebar ----------
const NAV = [
  { id: 'workspace', label: 'Workspace', icon: ICON.chat, items: [['#/projects', 'Projects'], ['#/terminal', 'Terminal sessions']] },
  { id: 'agents', label: 'Agents', icon: ICON.agents, items: [['#/agents', 'All agents'], ['#/templates', 'Saved agents'], ['#/rules', 'Delegation rules']] },
  { id: 'connections', label: 'Connections', icon: ICON.link, items: [['#/connections', 'Overview'], ['#/connections/claude', 'Claude Code'], ['#/connections/codex', 'Codex'], ['#/connections/github', 'GitHub']] },
  { id: 'settings', label: 'Settings', icon: ICON.sliders, items: [['#/appearance', 'Appearance'], ['#/access', 'Access and safety'], ['#/folders', 'Folders']] },
];
const cur = () => location.hash.replace(/\?.*$/, '') || '#/projects';
const isActive = (href) => cur() === href || (href === '#/projects' && cur().startsWith('#/project/'));
function renderSide() {
  const side = $('#side');
  const newBtn = h('button', { class: 'btn primary big', onclick: () => openNewProject() }, svg(ICON.plus, 16, 2.2), 'New project');
  const groups = NAV.map((g) => {
    const has = g.items.some(([href]) => isActive(href));
    const open = S.open[g.id] ?? has;
    return h('div', { class: `nav-group${has ? ' has-active' : ''}${open ? '' : ' closed'}` },
      h('button', { 'aria-expanded': String(open), onclick: () => { S.open[g.id] = !open; renderSide(); } }, svg(g.icon), h('span', { style: 'flex:1' }, g.label), h('span', { class: 'chev' }, svg(ICON.chev, 16, 2))),
      h('div', { class: 'sub' }, g.items.map(([href, label]) => h('a', { class: 'nav-item', href, 'aria-current': isActive(href) ? 'page' : null, onclick: () => $('#side').classList.remove('open') }, label))));
  });
  const conn = (S.conns || []).map((c) => {
    const ok = c.id === 'github' ? c.status?.ok : c.ready;
    const way = c.method === 'cli' ? 'Terminal' : c.method === 'api' ? 'Web · API' : 'Web · token';
    return h('div', { class: 'conn-row' }, h('span', { class: 'dot ' + (ok ? 'ok' : 'err') }), h('span', {}, c.id === 'claude' ? 'Claude Code' : c.id === 'codex' ? 'Codex' : 'GitHub'), h('small', {}, ok ? way : 'Not connected'));
  });
  side.replaceChildren(
    h('div', { class: 'brand' }, (() => { const s = svg('M12 2.5l8 4.6v9.8l-8 4.6-8-4.6V7.1z', 28); s.style.color = 'var(--accent)'; return s; })(), 'Apiary'),
    newBtn, h('nav', { 'aria-label': 'Main', style: 'display:flex;flex-direction:column;gap:6px' }, groups),
    h('div', { class: 'conn-box' }, h('h4', {}, 'Connections'), conn.length ? conn : h('small', { class: 'hint' }, 'Checking…')));
}
function crumbs(...parts) {
  $('#crumbs').replaceChildren(...parts.flatMap((p, i) => [i ? h('span', {}, '/') : null, i === parts.length - 1 ? h('b', {}, p) : h('span', {}, p)]).filter(Boolean));
}

// ---------- routing ----------
const ROUTES = [
  [/^#\/projects$/, () => pageProjects()],
  [/^#\/project\/([\w-]+)$/, (m) => pageProject(m[1])],
  [/^#\/terminal$/, () => pageTerminals()],
  [/^#\/agents$/, () => pageAgents()],
  [/^#\/templates$/, () => pageTemplates()],
  [/^#\/rules$/, () => pageRules()],
  [/^#\/connections$/, () => pageConnections()],
  [/^#\/connections\/(claude|codex|github)$/, (m) => pageConnection(m[1])],
  [/^#\/appearance$/, () => pageAppearance()],
  [/^#\/access$/, () => pageAccess()],
  [/^#\/folders$/, () => pageFolders()],
];
function route() {
  const hash = cur();
  view.className = 'view'; page = null;
  const r = ROUTES.find(([re]) => re.test(hash));
  if (!r) { location.hash = '#/projects'; return; }
  renderSide();
  r[1](r[0].exec(hash));
}
addEventListener('hashchange', route);

// ---------- live updates ----------
function refreshConns() { return api('/api/connections').then((c) => { S.conns = c; renderSide(); }).catch(() => {}); }
async function loadState() {
  const st = await api('/api/state');
  Object.assign(S, { agents: st.agents, providers: st.providers, limits: st.limits, defs: st.defs, version: st.version });
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
    } else if (ev.type === 'delta') S.stream[ev.agentId] = (S.stream[ev.agentId] || '') + ev.text;
    else if (ev.type === 'activity') S.activity[ev.agentId] = ev.text;
    else if (ev.type === 'log') { (S.logs[ev.agentId] ||= []).push(ev.line); }
    if (['agent', 'removed'].includes(ev.type)) renderSide();
    page?.update?.(ev);
  };
}

// ---------- projects ----------
function pageProjects() {
  crumbs('Workspace', 'Projects');
  const draw = () => {
    const ls = leads();
    view.replaceChildren(
      h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Projects'), h('p', { class: 'sub-title' }, 'Each project has a lead agent that can create sub-agents.')),
        h('button', { class: 'btn primary big', onclick: () => openNewProject() }, svg(ICON.plus, 16, 2.2), 'New project')),
      ls.length ? h('div', { class: 'grid' }, ls.map((a) => h('a', { class: 'card', href: `#/project/${a.id}`, style: 'display:block' },
        h('div', { class: 'kv', style: 'justify-content:space-between' }, h('b', {}, a.name), pill(a.status)),
        h('p', { class: 'hint', style: 'margin:8px 0' }, `${PNAME[a.provider] || a.provider} · ${a.method === 'api' ? 'Web' : 'Terminal'} · ${kidsOf(a.id).length} sub-agents`),
        a.git ? h('div', { class: 'mono hint' }, a.git.branch) : h('div', { class: 'hint' }, 'Plain folder'),
        h('div', { class: 'hint', style: 'margin-top:6px' }, `Started ${ago(a.createdAt)}`))))
        : h('div', { class: 'card empty' }, h('p', {}, 'No projects yet. Describe a goal and let a lead agent get started.'), h('button', { class: 'btn primary big', onclick: () => openNewProject() }, 'Start your first project')));
  };
  draw(); page = { update: (ev) => ['agent', 'removed'].includes(ev.type) && draw() };
}

async function ensureMsgs(id) {
  if (!S.msgs[id]) S.msgs[id] = await api(`/api/agents/${id}/messages`);
  if (!S.logs[id]) S.logs[id] = await api(`/api/agents/${id}/logs`);
}

function pageProject(leadId) {
  const lead = S.agents.find((a) => a.id === leadId);
  if (!lead && !pageProject.retried) { pageProject.retried = true; loadState().then(() => { pageProject.retried = false; route(); }).catch(() => { pageProject.retried = false; }); return; }
  if (!lead) { view.replaceChildren(h('div', { class: 'card empty' }, 'This project no longer exists. ', h('a', { href: '#/projects', style: 'text-decoration:underline' }, 'Back to projects'))); crumbs('Workspace', 'Projects'); return; }
  crumbs('Workspace', 'Projects', lead.name);
  view.className = 'view flush';
  if (!S.sel || rootOf(S.agents.find((a) => a.id === S.sel) || { id: null }).id !== leadId) S.sel = leadId;
  S.tab = 'chat';
  const el = { head: h('div', { class: 'chat-head' }), tabs: h('div', { class: 'tabs', role: 'tablist' }), body: h('div', { style: 'flex:1;display:flex;flex-direction:column;min-height:0' }), team: h('aside', { class: 'team', 'aria-label': 'Team' }) };
  view.replaceChildren(h('div', { class: 'ws' }, h('section', { class: 'chat' }, el.head, el.tabs, el.body), el.team));
  let msgsEl, termEl, liveEl, input;

  const sel = () => S.agents.find((a) => a.id === S.sel) || lead;
  const drawHead = () => {
    const a = sel(), l = S.agents.find((x) => x.id === leadId) || lead;
    el.head.replaceChildren(...[
      h('div', { class: 't' }, h('h1', {}, a.name), h('div', { class: 'hint' }, `${a.role || ''} · ${PNAME[a.provider] || a.provider} · ${a.method === 'api' ? 'Web' : 'Terminal'}`, a.git ? h('span', { class: 'mono' }, ` · ${a.git.branch}`) : '')),
      pill(a.status),
      a.status !== 'idle' ? h('button', { class: 'btn', onclick: guard(() => api(`/api/agents/${a.id}/stop`, 'POST', {})) }, 'Stop') : null,
      a.method !== 'api' ? h('button', { class: 'btn', onclick: guard(() => takeOver(a)) }, 'Take over') : null,
      l.git && a.id === l.id ? (l.git.prUrl ? h('a', { class: 'btn', href: l.git.prUrl, target: '_blank', rel: 'noopener' }, 'View pull request') : h('button', { class: 'btn', onclick: () => openPrDialog(l) }, 'Open pull request')) : null,
      a.id === l.id ? h('button', { class: 'btn danger', onclick: guard(async () => { if (!confirm(`Delete "${a.name}" and its sub-agents? Git branches are kept.`)) return; await api(`/api/agents/${a.id}`, 'DELETE'); location.hash = '#/projects'; }) }, 'Delete') : null].filter(Boolean));
  };
  const drawTabs = () => el.tabs.replaceChildren(...['chat', 'terminal'].map((t) => h('button', { role: 'tab', 'aria-selected': String(S.tab === t), onclick: () => { S.tab = t; drawTabs(); drawBody(); } }, t === 'chat' ? 'Chat' : 'Terminal')));
  const drawTeam = () => {
    const node = (a, d) => h('button', { class: 'node', style: `padding-left:${10 + d * 18}px`, 'aria-current': String(a.id === S.sel), onclick: () => { S.sel = a.id; drawAll(); } },
      h('span', { class: 'dot ' + ({ working: 'work pulse', waiting: 'info pulse', error: 'err' }[a.status] || 'ok') }),
      h('span', { class: 'n' }, h('b', {}, a.name), h('small', {}, S.activity[a.id] || `${PNAME[a.provider] || a.provider}${a.role ? ' · ' + a.role : ''}`)));
    const walk = (a, d) => [node(a, d), ...kidsOf(a.id).flatMap((k) => walk(k, d + 1))];
    el.team.replaceChildren(h('h3', {}, 'Team'), ...walk(S.agents.find((x) => x.id === leadId) || lead, 0));
  };
  const drawMsgs = () => {
    if (!msgsEl) return;
    const a = sel(), near = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
    const list = (S.msgs[a.id] || []).map((m) => {
      if (m.role === 'system') return h('div', { class: 'msg system' + (m.error ? ' error' : '') }, m.text);
      const who = m.role === 'user' ? (m.from ? `From ${m.from.name}` : 'You') : m.role === 'report' ? 'Reports from sub-agents' : a.name;
      return h('div', { class: 'msg ' + m.role }, h('div', { class: 'who' }, who), m.text);
    });
    if (S.stream[a.id]) list.push(h('div', { class: 'msg agent' }, h('div', { class: 'who' }, a.name), S.stream[a.id]));
    if (!list.length) list.push(h('div', { class: 'empty' }, 'Nothing here yet.'));
    msgsEl.replaceChildren(...list);
    if (near) msgsEl.scrollTop = msgsEl.scrollHeight;
    if (liveEl) liveEl.replaceChildren(...(a.status === 'working' || a.status === 'waiting' ? [h('span', { class: 'dot work pulse' }), S.activity[a.id] || (a.status === 'waiting' ? 'Waiting for sub-agents…' : 'Working…')] : []));
  };
  const drawTerm = () => {
    if (!termEl) return;
    const near = termEl.scrollHeight - termEl.scrollTop - termEl.clientHeight < 80;
    termEl.replaceChildren(...(S.logs[S.sel] || []).flatMap((l) => [h('span', { class: l.startsWith('$') || l.startsWith('──') ? 'c' : l.startsWith('!') ? 'e' : l.startsWith('✔') ? 'o' : '' }, l), '\n']));
    if (!(S.logs[S.sel] || []).length) termEl.textContent = 'No terminal activity yet.';
    if (near) termEl.scrollTop = termEl.scrollHeight;
  };
  const drawBody = () => {
    const a = sel();
    if (S.tab === 'terminal') {
      termEl = h('pre', { class: 'term', tabindex: '0', 'aria-label': 'Terminal output' });
      msgsEl = null; el.body.replaceChildren(termEl); drawTerm(); return;
    }
    termEl = null;
    msgsEl = h('div', { class: 'msgs', 'aria-live': 'polite' });
    liveEl = h('div', { class: 'live-line' });
    input = h('textarea', { rows: '2', placeholder: a.parentId ? `Message ${a.name} directly…` : 'Tell the lead agent what you need…', 'aria-label': 'Message', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
    const send = guard(async () => {
      const text = input.value.trim(); if (!text) return;
      input.value = ''; await api(`/api/agents/${sel().id}/messages`, 'POST', { text });
    });
    el.body.replaceChildren(msgsEl, liveEl, h('div', { class: 'composer' }, input, h('button', { class: 'btn primary big', onclick: send }, 'Send')));
    drawMsgs();
  };
  const drawAll = () => { drawHead(); drawTabs(); drawTeam(); drawBody(); };
  const load = guard(async () => { await Promise.all(S.agents.filter((a) => rootOf(a).id === leadId).map((a) => ensureMsgs(a.id))); drawAll(); });
  drawAll(); load();
  page = {
    update(ev) {
      if (ev.type === 'agent' || ev.type === 'removed') { if (!S.agents.find((a) => a.id === leadId)) { location.hash = '#/projects'; return; } drawHead(); drawTeam(); if (ev.agent && !S.msgs[ev.agent.id]) ensureMsgs(ev.agent.id).then(drawAll).catch(() => {}); }
      if (['message', 'delta', 'activity', 'agent'].includes(ev.type)) { drawMsgs(); if (ev.type === 'activity') drawTeam(); }
      if (ev.type === 'log') drawTerm();
    },
  };
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
  const st = { src: 'empty', ai: S.providers.find((p) => p.id !== 'mock')?.id || S.providers[0]?.id || '', access: 'safe', repo: '', branches: [], base: '' };
  const goal = h('textarea', { rows: '4', placeholder: 'e.g. Add dark mode to the settings page and write tests', 'aria-label': 'Goal' });
  const name = h('input', { type: 'text', placeholder: 'Optional — defaults to your goal' });
  const sourceBox = h('div'), aiBox = h('div'), accBox = h('div'), err = h('p', { class: 'hint', style: 'color:var(--err);min-height:20px', role: 'alert' });
  const folder = h('input', { type: 'text', placeholder: '/home/you/projects/my-app' });
  const choice = (opts, key, redraw) => h('div', { class: 'choice' }, opts.map(([v, t, s]) => h('button', { type: 'button', 'aria-pressed': String(st[key] === v), onclick: () => { st[key] = v; redraw(); } }, h('b', {}, t), h('small', {}, s))));
  const drawAI = () => aiBox.replaceChildren(S.providers.filter((p) => p.id !== 'mock' || S.providers.length === 1 || true).length
    ? choice(S.providers.map((p) => [p.id, p.label, p.method === 'api' ? 'Web · API key' : 'Terminal']), 'ai', drawAI)
    : h('p', { class: 'hint' }, 'No AI connected yet. Open Connections first.'));
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
  const go = h('button', { class: 'btn primary big', type: 'button' }, 'Start project');
  const dlg = h('dialog', { 'aria-label': 'New project' }, h('form', { method: 'dialog' }, h('h2', { style: 'font-size:20px' }, 'New project'),
    h('label', { class: 'f' }, 'What should the team do?', goal), h('label', { class: 'f' }, 'Project name', name),
    h('div', { class: 'f' }, 'Lead agent uses'), aiBox, h('div', { class: 'f' }, 'Where does the work happen?'), sourceBox, h('div', { class: 'f' }, 'Access'), accBox, err,
    h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', value: 'cancel' }, 'Cancel'), go)));
  go.onclick = async () => {
    err.textContent = '';
    if (!st.ai) { err.textContent = 'Connect an AI first (Connections).'; return; }
    if (!goal.value.trim() && !name.value.trim()) { err.textContent = 'Describe what you want done.'; return; }
    const body = { provider: st.ai, goal: goal.value.trim(), name: name.value.trim(), access: st.access };
    if (st.src === 'folder') { if (!folder.value.trim()) { err.textContent = 'Enter a folder path.'; return; } body.source = folder.value.trim(); }
    if (st.src === 'github') { if (!st.repo) { err.textContent = 'Choose a repository.'; return; } body.source = st.repo; if (st.base) body.base = st.base; }
    go.disabled = true; go.textContent = st.src === 'github' ? 'Cloning…' : 'Starting…';
    try { const a = await api('/api/agents', 'POST', body); if (!S.agents.some((x) => x.id === a.id)) S.agents.push(a); dlg.close(); location.hash = `#/project/${a.id}`; }
    catch (e) { err.textContent = e.message; go.disabled = false; go.textContent = 'Start project'; }
  };
  document.body.append(dlg); dlg.addEventListener('close', () => dlg.remove());
  drawAI(); drawAcc(); drawSource(); dlg.showModal(); goal.focus();
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
    const rows = []; const walk = (a, d) => { rows.push([a, d]); kidsOf(a.id).forEach((k) => walk(k, d + 1)); }; leads().forEach((l) => walk(l, 0));
    view.replaceChildren(h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'All agents'), h('p', { class: 'sub-title' }, `${S.agents.length} agents across ${leads().length} projects.`))),
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
  const fs = [field('maxDepth', 'How deep the team can go', '1 = the lead can create sub-agents, 2 = they can create their own. Lower is simpler and cheaper.'), field('maxAgents', 'Maximum agents per project', 'A hard cap on the whole team, including the lead.'), field('maxRounds', 'Delegation rounds per message', 'How many times the lead may hand out work and read reports before it must answer.')];
  view.replaceChildren(h('h1', {}, 'Delegation rules'), h('p', { class: 'sub-title' }, 'Guard rails that keep teams small and costs predictable.'),
    h('div', { class: 'card', style: 'max-width:640px' }, fs.map((f) => f.node(f.el)), h('button', { class: 'btn primary', onclick: guard(async () => { const r = await api('/api/settings', 'PUT', { limits: Object.fromEntries(fs.map((f) => [f.k, Number(f.el.value)])) }); S.limits = r.limits; toast('Saved'); }) }, 'Save')));
}

// ---------- connections ----------
const CINFO = {
  claude: { title: 'Claude Code', login: 'claude', install: 'npm install -g @anthropic-ai/claude-code', key: 'Anthropic API key', keyUrl: 'console.anthropic.com' },
  codex: { title: 'Codex', login: 'codex login', install: 'npm install -g @openai/codex', key: 'OpenAI API key', keyUrl: 'platform.openai.com' },
  github: { title: 'GitHub', login: 'gh auth login', install: 'See cli.github.com', key: 'Personal access token' },
};
function connCard(c, full = false) {
  const info = CINFO[c.id], isGh = c.id === 'github', webM = isGh ? 'token' : 'api';
  const ok = isGh ? c.status?.ok : c.ready;
  const key = h('input', { type: 'password', autocomplete: 'off', placeholder: (isGh ? c.token : c.api).saved ? `Saved ${(isGh ? c.token : c.api).hint} — type to replace` : isGh ? 'ghp_… or github_pat_…' : 'Paste key', 'aria-label': info.key });
  const model = isGh ? null : h('input', { type: 'text', value: c.api.model || '', placeholder: c.id === 'codex' ? 'Model name (required for web)' : 'claude-sonnet-5-5' });
  const result = h('p', { class: 'hint', role: 'status' });
  const setMethod = guard(async (m) => { await api('/api/connections/' + c.id, 'PUT', { method: m }); await refreshConns(); route(); });
  const body = c.method === 'cli'
    ? h('div', {}, h('p', {}, c.cli.found ? h('span', {}, h('span', { class: 'pill ok' }, 'Found'), ' ', h('span', { class: 'mono hint' }, `${c.cli.path}${c.cli.version ? ' · ' + c.cli.version : ''}`)) : h('span', {}, h('span', { class: 'pill err' }, 'Not installed'))),
      c.cli.found ? null : h('div', {}, h('p', { class: 'hint' }, 'Install it:'), cmdBox(info.install)),
      h('p', { class: 'hint' }, isGh ? 'Sign in once in a terminal. Apiary reuses that login:' : 'Log in once in a terminal. Apiary reuses that login — no key needed:'), cmdBox(info.login),
      isGh && c.status ? h('p', { class: 'hint' }, c.status.ok ? `Signed in as ${c.status.account || 'unknown'}` : c.status.reason) : null)
    : h('div', {}, h('label', { class: 'f' }, info.key, key, h('small', {}, isGh ? 'Needs “repo” access. Stored only on this machine in a private file.' : `From ${info.keyUrl}. Stored only on this machine in a private file. Web agents can chat but cannot edit files.`)), model ? h('label', { class: 'f' }, 'Model', model) : null,
      h('button', { class: 'btn', onclick: guard(async () => { const p = { method: webM }; if (key.value) p[isGh ? 'token' : 'apiKey'] = key.value; if (model) p.model = model.value; await api('/api/connections/' + c.id, 'PUT', p); toast('Saved'); await refreshConns(); route(); }) }, 'Save'));
  return h('div', { class: 'card' },
    h('div', { class: 'kv', style: 'justify-content:space-between;margin-bottom:14px' }, h('h2', { style: 'margin:0' }, info.title), h('span', { class: 'pill ' + (ok ? 'ok' : 'err') }, ok ? 'Connected' : 'Not connected')),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Connection method', style: 'margin-bottom:16px' },
      h('button', { 'aria-pressed': String(c.method === 'cli'), onclick: () => c.method !== 'cli' && setMethod('cli') }, 'Terminal'),
      h('button', { 'aria-pressed': String(c.method === webM), onclick: () => c.method !== webM && setMethod(webM) }, isGh ? 'Web · token' : 'Web · API key')),
    body,
    h('div', { class: 'kv', style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: guard(async (e) => { const b = e.currentTarget; b.disabled = true; result.textContent = 'Testing…'; try { const r = await api(`/api/connections/${c.id}/test`, 'POST', {}); result.textContent = r.ok ? '✔ ' + r.detail : '✘ ' + r.error; result.style.color = r.ok ? 'var(--ok-text)' : 'var(--err)'; } finally { b.disabled = false; } }) }, 'Test connection'), result));
}
function pageConnections() {
  crumbs('Connections', 'Overview');
  view.replaceChildren(h('h1', {}, 'Connections'), h('p', { class: 'sub-title' }, 'Connect each service through your terminal or through the web. You can mix them.'), h('div', { class: 'hint' }, 'Loading…'));
  refreshConns().then(() => view.replaceChildren(h('h1', {}, 'Connections'), h('p', { class: 'sub-title' }, 'Connect each service through your terminal or through the web. You can mix them.'), h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(340px,1fr))' }, S.conns.map((c) => connCard(c)))));
}
function pageConnection(id) {
  crumbs('Connections', CINFO[id].title);
  refreshConns().then(() => view.replaceChildren(h('h1', {}, CINFO[id].title), h('p', { class: 'sub-title' }, 'Choose how Apiary reaches it.'), h('div', { style: 'max-width:640px' }, connCard(S.conns.find((c) => c.id === id)))));
}

// ---------- settings ----------
function pageAppearance() {
  crumbs('Settings', 'Appearance');
  const draw = () => view.replaceChildren(h('h1', {}, 'Appearance'), h('p', { class: 'sub-title' }, 'Apiary remembers your choice on this browser.'),
    h('div', { class: 'card', style: 'max-width:560px' }, h('div', { class: 'seg' }, ['dark', 'light'].map((t) => h('button', { 'aria-pressed': String(document.documentElement.className === t), onclick: () => { applyTheme(t); draw(); } }, t === 'dark' ? 'Dark' : 'Light')))));
  draw();
}
function pageAccess() {
  crumbs('Settings', 'Access and safety');
  view.replaceChildren(h('h1', {}, 'Access and safety'), h('p', { class: 'sub-title' }, 'Agents can run commands on this computer, so Apiary is careful about who can reach it.'),
    h('div', { class: 'card', style: 'max-width:720px' }, h('h2', {}, 'Who can open Apiary'), h('p', {}, 'By default it only listens on this computer (127.0.0.1). To use it from another device, start it with a token:'), cmdBox('APIARY_HOST=0.0.0.0 APIARY_TOKEN=choose-a-long-secret apiary'),
      h('h2', { style: 'margin-top:20px' }, 'Safe and Full access'), h('p', {}, 'Safe lets an agent edit files in its own folder. Full access lets it run any command without asking. Choose per project when you create it.'),
      h('h2', { style: 'margin-top:20px' }, 'Git projects'), h('p', {}, 'In a git repository every agent works on its own branch and checkout, so your own working copy is never touched. Nothing is pushed until you open a pull request.')));
}
function pageFolders() {
  crumbs('Settings', 'Folders');
  view.replaceChildren(h('h1', {}, 'Folders'), h('p', { class: 'sub-title' }, 'Where Apiary keeps things on this machine.'),
    h('div', { class: 'card', style: 'max-width:720px' }, h('table', { class: 'tbl', style: 'min-width:0' }, h('tbody', {}, [['~/.apiary/state.json', 'Projects, chats and settings (private to your user)'], ['~/.apiary/workspaces/', 'Folders for projects that are not tied to a repository'], ['~/.apiary/repos/', 'Repositories cloned from GitHub'], ['~/.apiary/worktrees/', 'One checkout per agent working on a repository']].map(([p, d]) => h('tr', {}, h('td', { class: 'mono' }, p), h('td', { class: 'hint' }, d))))),
      h('p', { class: 'hint', style: 'margin-top:12px' }, 'Set APIARY_HOME to move all of this.')));
}

// ---------- boot ----------
(async () => {
  try { await loadState(); } catch (e) { toast(e.message, true); }
  connectEvents(); route(); refreshConns();
})();
