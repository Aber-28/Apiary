# Library

The Library is a set of ready-made connectors. Pick what you want to connect, such as Proxmox, a Linux server, Home Assistant or a router, and Apiary asks only for what that type needs.

## How to use it

1. Open **Infrastructure → Devices** and press **Library**.
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
