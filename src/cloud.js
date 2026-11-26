// Real checks for the cloud connectors in the Library. Each returns { ok, detail } and never includes a secret in its text.
import { createSign } from 'node:crypto';
import https from 'node:https';

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

// UniFi: the official Network Integration API on the person's own console. Consoles use a self-signed certificate by default,
// so this one check (and only this one, to the address the person typed) does not insist on a trusted certificate.
function lanGet(host, port, path, headers) {
  return new Promise((resolve, reject) => {
    const r = https.request({ host, port, path, method: 'GET', headers, rejectUnauthorized: false, timeout: 10000 }, (res) => {
      let body = ''; res.on('data', (d) => { if (body.length < 1e5) body += d; }); res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch { /* not JSON */ } resolve({ status: res.statusCode, json }); });
    });
    r.on('timeout', () => r.destroy(new Error('timed out'))); r.on('error', reject); r.end();
  });
}
export async function verifyUnifi(host, port, key, get = lanGet) {
  if (!host) return { ok: false, detail: 'No console address to check' };
  try {
    const r = await get(String(host), Number(port) || 443, '/proxy/network/integration/v1/info', { 'x-api-key': key, accept: 'application/json' });
    if (r.status === 200 && r.json) return { ok: true, detail: `The console accepted the API key${r.json.applicationVersion ? ` (Network ${String(r.json.applicationVersion).slice(0, 20)})` : ''}` };
    if (r.status === 401 || r.status === 403) return { ok: false, detail: 'The console refused the API key. Create a new one under Settings, Control Plane, Integrations.' };
    if (r.status === 404) return { ok: false, detail: 'This console has no official API. It needs UniFi Network 9.0 or newer.' };
    return { ok: false, detail: `The console answered with HTTP ${r.status}` };
  } catch (e) { return { ok: false, detail: `Could not reach the console: ${String(e.message).slice(0, 100)}` }; }
}
