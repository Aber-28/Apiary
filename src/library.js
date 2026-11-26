// The Library: ready-made connectors. Each entry knows what it needs to connect (address, login, token) and the best way in.
// Logins go straight into the Secrets vault; the device that is created only names its login.
// An icon is fetched live from a public icon set the first time it is needed. Once downloaded it is kept for good and never deleted
// or refreshed. Only the web addresses listed here are ever fetched.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
const DI = 'https://raw.githubusercontent.com/homarr-labs/dashboard-icons/main/svg/';
const SI = 'https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/';
const di = (s) => `${DI}${s}.svg`, si = (s) => `${SI}${s}.svg`;

const SSH = (note) => ({ id: 'ssh', label: 'SSH login', secret: 'ssh', port: 22, user: 'root', note: note || 'The safest way in. Use a private key if you can, or a password.' });
const TOKEN = (label, note, port) => ({ id: 'token', label, secret: 'token', port: port || 0, user: '', note });

const LOGIN = (port, note, user) => ({ id: 'login', label: 'Username and password', secret: 'login', port, user: user || '', note });

export const LIBRARY = [
  { id: 'proxmox', name: 'Proxmox VE', type: 'proxmox', blurb: 'Hypervisor for virtual machines and containers', icons: [di('proxmox'), si('proxmox')],
    methods: [SSH('Lets Discovery list your virtual machines and containers.'), TOKEN('API token', 'Create it in Datacenter, Permissions, API Tokens. Paste it as user@realm!tokenid=secret.', 8006)], web: { scheme: 'https', port: 8006 } },
  { id: 'esxi', name: 'VMware ESXi', type: 'proxmox', blurb: 'VMware hypervisor host', icons: [di('vmware-esxi'), di('vmware'), si('vmware')], methods: [SSH('Turn on SSH in the ESXi host settings first.')] },
  { id: 'hyperv', name: 'Hyper-V host', type: 'proxmox', blurb: 'Windows hypervisor (needs OpenSSH on Windows)', icons: [], methods: [{ ...SSH('Windows needs the OpenSSH Server feature switched on.'), user: 'Administrator' }] },
  { id: 'linux', name: 'Linux server', type: 'server', blurb: 'Any Linux computer you can SSH into', icons: [di('linux'), si('linux')], methods: [SSH()] },
  { id: 'docker', name: 'Docker host', type: 'server', blurb: 'A server that runs Docker containers', icons: [di('docker'), si('docker')], methods: [SSH('Discovery lists the containers on it.')] },
  { id: 'raspberrypi', name: 'Raspberry Pi', type: 'pi', blurb: 'Raspberry Pi or similar small board', icons: [di('raspberry-pi')], methods: [{ ...SSH(), user: 'pi' }] },
  { id: 'openwrt', name: 'OpenWrt router', type: 'router', blurb: 'Router running OpenWrt', icons: [di('openwrt'), si('openwrt')], methods: [SSH()] },
  { id: 'opnsense', name: 'OPNsense firewall', type: 'router', blurb: 'Firewall and router', icons: [di('opnsense'), si('opnsense')], methods: [SSH('Enable Secure Shell in System, Settings, Administration.')] },
  { id: 'synology', name: 'Synology NAS', type: 'nas', blurb: 'Synology DiskStation storage', icons: [di('synology'), si('synology')], methods: [SSH('Enable SSH in Control Panel, Terminal.')] },
  { id: 'homeassistant', name: 'Home Assistant', type: 'service', blurb: 'Smart home hub', icons: [di('home-assistant')],
    methods: [TOKEN('Long-lived access token', 'Create it on your profile page in Home Assistant, at the bottom.', 8123)], web: { scheme: 'http', port: 8123 } },
  { id: 'n8n', name: 'n8n', type: 'service', blurb: 'Workflow automation', icons: [di('n8n'), si('n8n')], methods: [TOKEN('API key', 'Create it in n8n under Settings, n8n API.', 5678)], web: { scheme: 'http', port: 5678 } },
  { id: 'npm', name: 'Nginx Proxy Manager', type: 'service', blurb: 'Reverse proxy with a web page', icons: [di('nginx-proxy-manager')], methods: [{ id: 'login', label: 'Username and password', secret: 'login', port: 81, user: '', note: 'The login you use on its admin page.' }], web: { scheme: 'http', port: 81 } },
  { id: 'coolify', name: 'Coolify', type: 'service', blurb: 'Self-hosted app platform', icons: [di('coolify'), si('coolify')], methods: [TOKEN('API token', 'Create it in Coolify under Keys and Tokens, API tokens.', 8000)], web: { scheme: 'http', port: 8000 } },
  { id: 'windows', name: 'Windows server', type: 'server', blurb: 'Windows computer with OpenSSH Server', icons: [di('windows-11')], methods: [{ ...SSH('Windows needs the OpenSSH Server feature switched on.'), user: 'Administrator' }] },
  { id: 'kubernetes', name: 'Kubernetes', type: 'service', blurb: 'Cluster, through its API or a control-plane node', icons: [di('kubernetes'), si('kubernetes')],
    methods: [TOKEN('Service account token', 'Create a service account and paste its token. The address is the API server.', 6443), SSH('SSH into a control-plane node and use kubectl there.')], web: { scheme: 'https', port: 6443 } },
  { id: 'unifi', name: 'UniFi controller', type: 'service', blurb: 'UniFi network: switches and access points', icons: [di('unifi')],
    methods: [TOKEN('API key (official UniFi API)', 'Recommended. In UniFi Network open Settings, Control Plane, Integrations and choose Create API Key. Give it only the access you want agents to have. It is shown once.', 443), LOGIN(443, 'A local admin account on the controller (not your Ubiquiti cloud login). Use this only if you need things the API key cannot do.')], web: { scheme: 'https', port: 443 } },
  { id: 'mikrotik', name: 'MikroTik router', type: 'router', blurb: 'RouterOS router or switch', icons: [di('mikrotik'), si('mikrotik')], methods: [{ ...SSH(), user: 'admin' }] },
  { id: 'pfsense', name: 'pfSense firewall', type: 'router', blurb: 'Firewall and router', icons: [di('pfsense'), si('pfsense')], methods: [SSH('Enable Secure Shell in System, Advanced, Admin Access.')] },
  { id: 'truenas', name: 'TrueNAS', type: 'nas', blurb: 'Storage server', icons: [di('truenas'), si('truenas')], methods: [SSH('Turn on the SSH service first.'), TOKEN('API key', 'Create it under the user menu, API Keys.', 443)], web: { scheme: 'https', port: 443 } },
  { id: 'portainer', name: 'Portainer', type: 'service', blurb: 'Web page to manage Docker', icons: [di('portainer'), si('portainer')], methods: [TOKEN('Access token', 'Create it in your user settings, Access tokens.', 9443)], web: { scheme: 'https', port: 9443 } },
  { id: 'pihole', name: 'Pi-hole', type: 'service', blurb: 'Network-wide ad blocker', icons: [di('pi-hole')], methods: [LOGIN(80, 'The password you use on its admin page.')], web: { scheme: 'http', port: 80 } },
  { id: 'adguard', name: 'AdGuard Home', type: 'service', blurb: 'Network-wide ad and tracker blocker', icons: [di('adguard-home')], methods: [LOGIN(3000, 'The login of its admin page.')], web: { scheme: 'http', port: 3000 } },
  { id: 'grafana', name: 'Grafana', type: 'service', blurb: 'Dashboards and graphs', icons: [di('grafana'), si('grafana')], methods: [TOKEN('Service account token', 'Create it under Administration, Service accounts.', 3000)], web: { scheme: 'http', port: 3000 } },
  { id: 'uptimekuma', name: 'Uptime Kuma', type: 'service', blurb: 'Uptime monitoring', icons: [di('uptime-kuma')], methods: [LOGIN(3001, 'The login of its admin page.')], web: { scheme: 'http', port: 3001 } },
  { id: 'gitea', name: 'Gitea', type: 'service', blurb: 'Self-hosted Git', icons: [di('gitea'), si('gitea')], methods: [TOKEN('Access token', 'Create it in Settings, Applications.', 3000)], web: { scheme: 'http', port: 3000 } },
  { id: 'cloudflare', name: 'Cloudflare', type: 'service', blurb: 'DNS, tunnels and website protection (API)', icons: [di('cloudflare'), si('cloudflare')], fixed: { address: 'api.cloudflare.com', url: 'https://api.cloudflare.com' }, mcp: { name: 'cloudflare', url: 'https://mcp.cloudflare.com/mcp' },
    methods: [TOKEN('API token', 'Create it at dash.cloudflare.com under My Profile, API Tokens. Give it only the permissions you need, for example Zone, DNS, Edit for one zone.', 0)] },
  { id: 'google', name: 'Google (Drive, Gmail, Calendar)', type: 'service', blurb: 'Google Workspace through a service account', icons: [di('google-drive'), si('googledrive')], fixed: { address: 'www.googleapis.com', url: 'https://www.googleapis.com' },
    methods: [TOKEN('Service-account key (JSON)', 'In the Google Cloud console create a service account, add a JSON key and paste the whole file here. Share the Drive folders or calendars you want agents to use with the service account\'s email. Gmail needs a Google Workspace admin to allow it.', 0)] },
  { id: 'website', name: 'Website', type: 'website', blurb: 'A website you want to keep an eye on', icons: [], methods: [{ id: 'web', label: 'No login needed', secret: '', port: 0, user: '', note: 'Apiary only checks that it answers.' }] },
];

export const byId = (id) => LIBRARY.find((e) => e.id === id);
// What the page needs. The icon web addresses stay on the server.
export function view() { return LIBRARY.map(({ icons, ...e }) => ({ ...e, hasIcon: icons.length > 0 })); }
// The icon for a device that was not made from the Library: pick by its type.
export const TYPE_ICON = { proxmox: 'proxmox' };

// Strip anything active from a downloaded SVG. It is only ever shown in an <img>, which also blocks scripts, but we do not rely on that alone.
export function cleanSvg(text) {
  let s = String(text);
  if (!/<svg[\s>]/i.test(s)) return null;
  s = s.replace(/<\?xml[^>]*\?>/gi, '').replace(/<!DOCTYPE[^>]*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|foreignObject|iframe|object|embed|audio|video|link|meta|style)\b[\s\S]*?(<\/\1>|\/>)/gi, '').replace(/<(script|foreignObject|iframe|object|embed)\b[^>]*>/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/\s(?:xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, '');
  s = s.replace(/javascript:/gi, '');
  return s.trim();
}

// Fetch the icon live, every time. Tries each public source in order; returns null when none answers.
export async function fetchIcon(id, fetchFn = fetch) {
  const e = byId(id); if (!e) return null;
  for (const u of e.icons) {
    try {
      const r = await fetchFn(u, { redirect: 'follow', signal: AbortSignal.timeout(6000) });
      if (!r.ok) { r.body?.cancel?.().catch(() => {}); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 200_000) continue;
      const svg = cleanSvg(buf.toString('utf8'));
      if (svg) return svg;
    } catch { /* try the next source */ }
  }
  return null;
}

// The kept copy of an icon, if it was downloaded before.
export function storedIcon(dir, id) {
  if (!byId(id)) return null;
  try { const f = path.join(dir, `${id}.svg`); return existsSync(f) ? readFileSync(f, 'utf8') : null; } catch { return null; }
}
// The icon: the kept copy if there is one, otherwise fetched live now and kept from then on. Returns null if it cannot be had.
export async function iconFor(dir, id, fetchFn = fetch) {
  const have = storedIcon(dir, id); if (have) return have;
  const svg = await fetchIcon(id, fetchFn); if (!svg) return null;
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); const f = path.join(dir, `${id}.svg`), tmp = f + '.tmp'; writeFileSync(tmp, svg, { mode: 0o600 }); renameSync(tmp, f); } catch { /* shown this time, tried again next time */ }
  return svg;
}
