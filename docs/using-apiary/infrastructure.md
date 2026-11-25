# Infrastructure map

The **Infrastructure** menu keeps a living map of what you run: servers, Proxmox, Raspberry Pis, VMs, containers, NAS, routers, websites and services, and how they connect.

## Devices

Press **Add new**, or **Help me map it** (see below). For each item you can set a name, what it is, an address and port, a web address, what it **runs on**, what it **connects to**, the **vault login** to use, and notes. On every card:

* **Test connection** checks that the address is reachable (a quick connection to its port), or that the website answers. It changes nothing on the machine.
* **Update** edits the details. **Remove** takes it off the map only.

Passwords are never stored here. An item only names a login in the [Secrets vault](secrets-vault.md), so agents you allow can use it (for example through `apiary-ssh`).

## Map

A diagram drawn from your devices.

* **Boxes.** A box inside another box runs on it (a VM inside Proxmox, a website inside its VM). Each box has a small icon (the real logo when Apiary knows one), its name and what it is. A green or red dot shows whether the last connection test worked, and a dashed box is waiting for you to confirm it.
* **Layout.** Groups that talk to each other are placed next to each other. Things that run on nothing go in a tidy block underneath, "On their own".
* **Arrows.** Connections are drawn as smooth right-angle lines with rounded corners. They go around boxes instead of through them, and they carry the label you gave. Where two arrows cross, one hops over the other with a small bump, so you can tell they are separate.
* **Follow one box.** Hover over a box (or tab to it) and its arrows light up while everything else fades. Hover over an arrow to see which two things it joins.
* **Moving around.** Drag to move, use the slider or Ctrl + scroll to zoom, **Fit all** shows everything. Click a box to update it. The map redraws by itself as things change.

## Help me map it

Press **Help me map it** and the CEO asks a few short questions, guesses what it can from what it knows and from the map so far, and suggests items. Each suggestion appears on the Devices and Map pages as **Is this right?**: *Yes, add it*, *Edit first*, or *No*. Questions the CEO needs answered appear on the card, where you type the answer. Nothing joins the map until you confirm it, and suggestions can be rejected without any effect.

Agents also suggest items on their own when you mention a device or they discover one while working.

The map is saved in `~/.apiary/infra.json` and is part of an export.

## Moving and zooming the map

The map sits in a window you can move around in. Drag with the mouse (or use the scroll bars, or swipe on a touch screen). Use the **slider** or the **−** and **+** buttons to zoom from 30% to 200%. **Fit all** shows the whole map at once and **100%** goes back to normal size. Holding Ctrl while you scroll also zooms.

Names and addresses shrink to fit their box. If one is still too long it is shortened with …, and hovering over the box shows all of it.
