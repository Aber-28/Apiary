const f = document.getElementById('f'), e = document.getElementById('e');
f.addEventListener('submit', async (ev) => {
  ev.preventDefault(); e.textContent = '';
  const btn = f.querySelector('button'); btn.disabled = true;
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: f.u.value, password: f.p.value }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Could not sign in.');
    location.replace('/');
  } catch (x) { e.textContent = x.message; f.p.value = ''; f.p.focus(); }
  btn.disabled = false;
});
