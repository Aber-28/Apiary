// Global search: one box that finds projects, team members, tasks, devices, templates, past chats and
// secret names. Secret values are never searched or returned, and names only when the vault is unlocked.
const norm = (s) => String(s ?? '').toLowerCase();
const snip = (text, words) => {
  const t = String(text).replace(/\s+/g, ' '), i = Math.max(0, norm(t).indexOf(words[0]));
  return (i > 40 ? '…' : '') + t.slice(Math.max(0, i - 40), i + 100) + (t.length > i + 100 ? '…' : '');
};

export function search(engine, q, { limit = 8 } = {}) {
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return { q, groups: [], note: '' };
  const hit = (...fields) => { const s = norm(fields.join(' ')); return words.every((w) => s.includes(w)); };
  const groups = [], add = (type, label, items) => { if (items.length) groups.push({ type, label, total: items.length, items: items.slice(0, limit) }); };
  const agents = Object.values(engine.agents), roots = agents.filter((a) => !a.parentId && a.kind !== 'general');
  add('project', 'Projects', roots.filter((a) => hit(a.name, a.plan?.goal, a.role)).map((a) => ({ title: a.name, sub: a.plan?.goal ? snip(a.plan.goal, words) : engine.stageOf(a), href: `#/project/${a.id}` })));
  add('member', 'Team', agents.filter((a) => (a.member || a.kind === 'general') && hit(a.name, a.title, a.role)).map((a) => { const r = engine.rootOf(a); return { title: a.name, sub: [a.title || a.role, r.kind === 'general' ? '' : r.name].filter(Boolean).join(' · '), href: r.kind === 'general' ? '#/organisation' : `#/project/${r.id}` }; }));
  add('task', 'Tasks', engine.tasks.list.filter((t) => hit(t.code, t.title, t.notes, (t.labels || []).join(' '))).map((t) => ({ title: `${t.code} ${t.title}`, sub: t.status, href: '#/tasks' })));
  add('device', 'Devices', engine.infra.items.filter((i) => hit(i.name, i.type, i.address, i.url, i.notes)).map((i) => ({ title: i.name, sub: [i.type, i.address || i.url].filter(Boolean).join(' · '), href: '#/infrastructure' })));
  add('template', 'Project templates', Object.values(engine.store.data.templates || {}).filter((t) => hit(t.name, t.description, t.goal)).map((t) => ({ title: t.name, sub: t.description || snip(t.goal, words), href: '#/project-templates' })));
  if (engine.runbooks) add('runbook', 'Runbooks', engine.runbooks.list().filter((r) => hit(r.title, r.problem, r.steps.join(' '))).map((r) => ({ title: r.title, sub: snip(r.problem || r.steps[0] || '', words), href: '#/runbooks' })));
  const chats = [];
  for (const a of agents) for (const m of engine.messages(a.id)) {
    if (m.role !== 'user' && m.role !== 'agent') continue;
    if (!hit(m.text)) continue;
    const r = engine.rootOf(a);
    chats.push({ title: snip(m.text, words), sub: `${m.role === 'user' ? 'You' : a.name}${r.kind === 'general' ? '' : ' · ' + r.name} · ${new Date(m.ts || 0).toLocaleDateString()}`, href: r.kind === 'general' ? '#/chat' : `#/project/${r.id}`, ts: m.ts || 0 });
  }
  chats.sort((x, y) => y.ts - x.ts); add('chat', 'Past chats', chats);
  let note = '';
  if (engine.vault.exists) {
    if (engine.vault.unlocked) add('secret', 'Secret names', engine.vault.list().filter((x) => hit(x.name, x.note)).map((x) => ({ title: x.name, sub: 'Secret (value not shown)', href: '#/secrets' })));
    else note = 'The vault is locked, so secret names were not searched.';
  }
  return { q, groups, note };
}
