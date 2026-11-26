// Real checks for the cloud connectors in the Library. Each returns { ok, detail } and never includes a secret in its text.
import { createSign } from 'node:crypto';
import https from 'node:https';
import http from 'node:http';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const b64u = (b) => Buffer.from(b).toString('base64url');

// Cloudflare: a user token and an account token are verified in different places, so try both before giving up.
export async function verifyCloudflare(token, fetchFn = fetch) {
  const get = async (p) => {
    const r = await fetchFn(`https://api.cloudflare.com/client/v4/${p}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    let j = null; try { j = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, ok: !!j?.success, j };
  };
  try {
    const a = await get('user/tokens/verify');
    if (a.ok && a.j?.result?.status === 'active') return { ok: true, detail: 'Cloudflare accepted the token (active)' };
    const b = await get('accounts?per_page=1');
    if (b.ok) { const n = b.j?.result?.[0]?.name; return { ok: true, detail: `Cloudflare accepted the token${n ? ` (account ${n})` : ''}` }; }
    return { ok: false, detail: a.j?.result?.status && a.j.result.status !== 'active' ? `The token is ${a.j.result.status}` : 'Cloudflare did not accept this token. Check that you copied all of it and that it has not expired.' };
  } catch (e) { return { ok: false, detail: `Could not reach Cloudflare: ${e.message}` }; }
}

// Google: the secret is a service-account key (the JSON file Google gives you). Signing in with it proves the key is valid.
export function parseGoogleKey(text) {
  let k; try { k = JSON.parse(String(text)); } catch { return null; }
  if (!k || k.type !== 'service_account' || typeof k.client_email !== 'string' || typeof k.private_key !== 'string' || !/BEGIN [A-Z ]*PRIVATE KEY/.test(k.private_key)) return null;
  return k;
}
export async function verifyGoogle(text, fetchFn = fetch) {
  const k = parseGoogleKey(text);
  if (!k) return { ok: false, detail: 'This is not a Google service-account key (the JSON file from the Google Cloud console).' };
  try {
    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64u(JSON.stringify({ iss: k.client_email, scope: 'https://www.googleapis.com/auth/drive.readonly', aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 300 }));
    const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(k.private_key).toString('base64url');
    const r = await fetchFn(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }), signal: AbortSignal.timeout(10000) });
    let j = null; try { j = await r.json(); } catch { /* not JSON */ }
    if (r.ok && j?.access_token) return { ok: true, detail: `Google accepted the key for ${k.client_email}` };
    const why = j?.error_description || j?.error || `HTTP ${r.status}`;
    return { ok: false, detail: /invalid_grant|account not found|deleted/i.test(why) ? `Google refused the key (${String(why).slice(0, 80)}). It may be deleted or disabled.` : `Google refused the key: ${String(why).slice(0, 100)}` };
  } catch (e) { return { ok: false, detail: `Could not check the key: ${String(e.message).replace(/-----[\s\S]*/, '').slice(0, 100)}` }; }
}

// Official APIs of the things in the Library. Each says where to check a key, how the key is sent, and what an agent should be told.
// Home consoles use self-signed certificates by default, so these checks (only to the address the person typed) do not insist on a trusted one.
const bearer = (v) => ({ authorization: `Bearer ${v}` });
const basic = (v) => ({ authorization: `Basic ${Buffer.from(v).toString('base64')}` });
export const API = {
  proxmox: { name: 'Proxmox', base: '/api2/json', path: '/api2/json/version', auth: (v) => ({ authorization: `PVEAPIToken=${v}` }), how: 'the header Authorization: PVEAPIToken=<the token>', ok: (j) => (j?.data?.version ? `Proxmox ${j.data.version}` : null), json: true },
  homeassistant: { name: 'Home Assistant', base: '/api', path: '/api/', auth: bearer, how: 'the header Authorization: Bearer <the token>', ok: () => '' },
  n8n: { name: 'n8n', base: '/api/v1', path: '/api/v1/workflows?limit=1', auth: (v) => ({ 'x-n8n-api-key': v }), how: 'the header X-N8N-API-KEY', ok: () => '' },
  coolify: { name: 'Coolify', base: '/api/v1', path: '/api/v1/version', auth: bearer, how: 'the header Authorization: Bearer <the token>', ok: () => '' },
  portainer: { name: 'Portainer', base: '/api', path: '/api/status', auth: (v) => ({ 'x-api-key': v }), how: 'the header X-API-Key', ok: (j) => (j?.Version ? `Portainer ${j.Version}` : '') },
  grafana: { name: 'Grafana', base: '/api', path: '/api/org', auth: bearer, how: 'the header Authorization: Bearer <the token>', ok: () => '' },
  gitea: { name: 'Gitea', base: '/api/v1', path: '/api/v1/user', auth: (v) => ({ authorization: `token ${v}` }), how: 'the header Authorization: token <the token>', ok: () => '' },
  truenas: { name: 'TrueNAS', base: '/api/v2.0', path: '/api/v2.0/system/info', auth: bearer, how: 'the header Authorization: Bearer <the key>', ok: (j) => (j?.version ? `TrueNAS ${j.version}` : '') },
  kubernetes: { name: 'Kubernetes', base: '', path: '/version', auth: bearer, how: 'the header Authorization: Bearer <the token>', ok: (j) => (j?.gitVersion ? `Kubernetes ${j.gitVersion}` : '') },
  unifi: { name: 'UniFi Network', base: '/proxy/network/integration/v1', path: '/proxy/network/integration/v1/info', auth: (v) => ({ 'x-api-key': v }), how: 'the header X-API-KEY; start with GET /v1/sites', ok: (j) => (j?.applicationVersion ? `Network ${String(j.applicationVersion).slice(0, 20)}` : null), json: true, noApi: 'This console has no official API. It needs UniFi Network 9.0 or newer.' },
  opnsense: { name: 'OPNsense', base: '/api', path: '/api/core/firmware/status', auth: basic, how: 'HTTP basic authentication with the API key as the user and the secret as the password (the key is stored as key:secret)', ok: () => '' },
  uptimekuma: { name: 'Uptime Kuma', base: '', path: '/metrics', auth: (v) => basic(`:${v}`), how: 'HTTP basic authentication with an empty user and the API key as the password (GET /metrics)', ok: () => '' },
  pihole: { name: 'Pi-hole', base: '/api', path: '/api/auth', method: 'POST', body: (v) => JSON.stringify({ password: v }), auth: () => ({ 'content-type': 'application/json' }), how: 'POST /api/auth with the app password to get a session id, then send it as the X-FTL-SID header', ok: (j) => (j?.session?.valid ? '' : null), json: true },
};
export const apiInfo = (libId) => API[libId] || null;

function lanReq(scheme, host, port, path, headers, method = 'GET', body = '') {
  const mod = scheme === 'http' ? http : https;
  return new Promise((resolve, reject) => {
    const r = mod.request({ host, port, path, method, headers: body ? { ...headers, 'content-length': Buffer.byteLength(body) } : headers, rejectUnauthorized: false, timeout: 10000 }, (res) => {
      let text = ''; res.on('data', (d) => { if (text.length < 1e5) text += d; }); res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, json }); });
    });
    r.on('timeout', () => r.destroy(new Error('timed out'))); r.on('error', reject); r.end(body || undefined);
  });
}
// get(scheme, host, port, path, headers, method, body) -> { status, json }. Tests pass their own.
export async function verifyApi(libId, { host, port, scheme = 'https' }, value, get = lanReq) {
  const a = API[libId]; if (!a) return null;
  if (!host) return { ok: false, detail: 'No address to check' };
  try {
    const r = await get(scheme, String(host), Number(port) || (scheme === 'http' ? 80 : 443), a.path, { accept: 'application/json', ...a.auth(value) }, a.method || 'GET', a.body ? a.body(value) : '');
    if (r.status >= 200 && r.status < 300) {
      const v = a.ok(r.json);
      if (v === null || (a.json && !r.json)) return { ok: false, detail: `${a.name} answered, but not as expected. Check the address and port.` };
      return { ok: true, detail: `${a.name} accepted the key${v ? ` (${v})` : ''}` };
    }
    if (r.status === 401 || r.status === 403) return { ok: false, detail: `${a.name} refused the key. Create a new one and try again.` };
    if (r.status === 404 && a.noApi) return { ok: false, detail: a.noApi };
    return { ok: false, detail: `${a.name} answered with HTTP ${r.status}` };
  } catch (e) { return { ok: false, detail: `Could not reach ${a.name}: ${String(e.message).slice(0, 100)}` }; }
}
// Kept for the UniFi tests and callers: the console accepts the API key.
export async function verifyUnifi(host, port, key, get) {
  const g = get ? (sch, h, p, path, hd) => get(h, p, path, hd) : undefined;
  const r = await verifyApi('unifi', { host, port, scheme: 'https' }, key, g);
  return r.ok ? { ok: true, detail: r.detail.replace('UniFi Network accepted the key', 'The console accepted the API key') } : { ...r, detail: r.detail.replace('UniFi Network refused the key. Create a new one and try again.', 'The console refused the API key. Create a new one under Settings, Control Plane, Integrations.') };
}
