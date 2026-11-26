# Library

The Library is a set of ready-made connectors. Pick what you want to connect, such as Proxmox, a Linux server, Home Assistant or a router, and Apiary asks only for what that type needs.

## How to use it

1. Open **Infrastructure → Library** in the left menu.
2. Click a card, for example **Proxmox VE**.
3. Fill in the address, and the username and password, key or token. Where there is more than one way in, choose **Connect with**. The card says which is best.
4. Press **Add and test**.

Apiary puts the login into the encrypted **Secrets vault**, adds the device to your map already linked to it, and tests it. Only the *name* of the login is kept on the device, never the password. The vault must be created and unlocked first.

## What the test checks

The test first checks that the address answers on its port. For an **SSH login** it then signs in for real and runs a harmless command, so "works" means the login works. Token logins (Proxmox API, Home Assistant, n8n, Coolify) are stored and ready for agents to use, but are not checked against the service.

## The best way in

- **Servers, hypervisors, routers, NAS:** SSH, ideally with a private key. This also lets [Discovery](discovery.md) list virtual machines and containers.
- **Proxmox:** SSH for Discovery, or an API token.
- **Home Assistant, n8n, Coolify:** a long-lived token or API key.
- **Nginx Proxy Manager:** the username and password of its admin page.
- **Kubernetes:** a service account token for the API, or SSH into a control-plane node.
- **UniFi, Pi-hole, AdGuard Home, Uptime Kuma:** the username and password of the admin page.
- **Portainer, Grafana, Gitea, TrueNAS:** an access token or API key (TrueNAS also offers SSH).
- **Website:** no login; Apiary only checks that it answers.

## Icons

Each entry shows its product's icon on the Library cards, on the device card and on the map. Apiary fetches an icon live from a public icon set on the internet the first time it is needed. Once downloaded it is **kept for good and never deleted**, and not downloaded again, so it works offline afterwards. A [factory reset](factory-reset.md) leaves the icons alone. If an icon cannot be fetched (or none exists, as for Hyper-V), a letter shows instead. Only the fixed addresses built into Apiary are ever fetched, and anything active inside an icon file is removed.

## Cloudflare

Pick **Cloudflare**, give it a name and paste an **API token**. Create it at dash.cloudflare.com under *My Profile, API Tokens*, and give it only the permissions you need (for example *Zone, DNS, Edit* for one zone). There is no username, password or address to type. **Add and test** asks Cloudflare whether the token is active.

Cloudflare's own **MCP server** (`https://mcp.cloudflare.com/mcp`, the official way for AI agents to use the whole Cloudflare API) is built in. When an agent needs Cloudflare it asks to use the login; once you approve, that turn has Cloudflare's tools available. The token goes to the agent's process through its environment for that turn only. It is never written into a file, the chat or the logs. For now this works for **Claude** agents; Codex agents can still use the token for direct calls.

## UniFi

Pick **UniFi controller**, give it the console's address (for example `192.0.2.10`) and paste an **API key**. Create the key in UniFi Network under *Settings, Control Plane, Integrations, Create API Key*. It needs UniFi Network 9.0 or newer, and it is shown only once. Give it only the access you want your agents to have.

**Add and test** asks your console whether it accepts the key. Consoles use a self-signed certificate by default, so this one check does not insist on a trusted certificate, and it only talks to the address you typed.

Ubiquiti does not offer an official MCP server for UniFi. What it does offer is the official UniFi Network API, and that is what Apiary uses. Agents are told where it is (`/proxy/network/integration/v1` on your console), that the key goes in the `X-API-KEY` header, and to ask before using it. They start by reading, and change nothing without asking you. The key reaches the agent for that turn only and is never written into a file, the chat or the logs.

If you need something the API key cannot do, the older **username and password** method (a local admin account) is still there.

## Google (Drive, Gmail, Calendar)

Pick **Google** and paste a **service-account key**: in the Google Cloud console create a service account, add a JSON key, and paste the whole file. Apiary checks the key by signing in with it and shows the service account's email. To let agents use a Drive folder, a calendar or a sheet, **share it with that email address**, like sharing with a person. Gmail only works if a Google Workspace admin allows it for the service account. The key is stored in the Secrets vault and only reaches an agent you approve.

