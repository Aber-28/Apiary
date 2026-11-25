# Discovery

Discovery finds the virtual machines and containers that live on a server, so you don't have to type each one in.

## How to use it

1. In the Secrets vault, add an **SSH login** for the server (username and address), then link it to the device on **Infrastructure → Devices**.
2. Press **Discover** on that device's card.
3. Apiary lists what it found. Each new thing appears as an **Is this right?** card. Press **Yes, add it**, **Edit first**, or **No**. With three or more finds, **Yes to all** answers them at once.

## It only reads

Discovery runs listing commands only (for example `qm list` or `virsh list --all`). It never starts, stops, changes or deletes anything, however many times you press it. If a listing needs administrator rights, it retries the same listing with `sudo -n`, which never asks for a password.

## What it understands

Proxmox (virtual machines and containers), KVM/libvirt, VMware ESXi, XCP-ng/XenServer, Hyper-V (Windows over SSH), Docker, LXC, Incus and LXD. It tries them all and reports which ones answered. Anything that is not installed is simply skipped.

## Yes, No and "ignored"

- **Yes** adds it to your device map under the server.
- **No** drops the suggestion. It is not remembered as a ban: press Discover again and it comes back, so you can change your mind.
- Anything you ignore stays waiting on the page until you answer.
- Things already on your map are never suggested twice. Their running or stopped state is refreshed, and the result tells you about known items that were not found this time.

## If something goes wrong

- *Vault is locked:* unlock it, then press Discover again.
- *Could not connect:* the message says whether the address, the login or the SSH service is the likely cause.
- *A hypervisor could not be listed* (for example Docker permission denied): the others still work, and the result says which one failed.
