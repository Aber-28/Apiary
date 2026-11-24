# Infrastructure map

The **Infrastructure** menu keeps a living map of what you run: servers, Proxmox, Raspberry Pis, VMs, containers, NAS, routers, websites and services, and how they connect.

## Devices

Press **Add new**, or **Help me map it** (see below). For each item you can set a name, what it is, an address and port, a web address, what it **runs on**, what it **connects to**, the **vault login** to use, and notes. On every card:

* **Test connection** checks that the address is reachable (a quick connection to its port), or that the website answers. It changes nothing on the machine.
* **Update** edits the details. **Remove** takes it off the map only.

Passwords are never stored here. An item only names a login in the [Secrets vault](secrets-vault.md), so agents you allow can use it (for example through `apiary-ssh`).

## Map

A diagram drawn from your devices. A box inside another box runs on it (a VM inside Proxmox, a website inside its VM). Arrows are connections, with the label you gave. A green outline means the last test worked, red that it failed, and a dashed box is waiting for you to confirm it. Click a box to update it. The map redraws by itself as things change.

## Help me map it

Press **Help me map it** and the CEO asks a few short questions, guesses what it can from what it knows and from the map so far, and suggests items. Each suggestion appears on the Devices and Map pages as **Is this right?**: *Yes, add it*, *Edit first*, or *No*. Questions the CEO needs answered appear on the card, where you type the answer. Nothing joins the map until you confirm it, and suggestions can be rejected without any effect.

Agents also suggest items on their own when you mention a device or they discover one while working.

The map is saved in `~/.apiary/infra.json` and is part of an export.
