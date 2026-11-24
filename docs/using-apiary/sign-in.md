# Sign-in from any laptop

Apiary can ask for a username and password, so you can open it from any laptop on your network without the long access link.

## Turn it on

* **In the app:** Settings > Sign-in, choose a username and a password (at least 10 characters; three or four random words works well), then press **Turn on sign-in**.
* **From the terminal:** `apiary user set <name>`. The password is typed hidden.
* **At install:** when you answer *yes* to using Apiary from another device, the installer offers to create one.

Then open `http://<ip-of-the-machine>:7777` on any laptop and sign in. On the machine itself nothing changes until you turn it on.

## What it does

* The password is never stored, only a salted scrypt hash in `~/.apiary/auth.json` (private to your user).
* Staying signed in lasts 14 days per browser. **Sign out** is in the top bar.
* Wrong tries are slowed down, per address and per username.
* **Changing the password signs every other device out.**
* Changing or removing the account needs the current password.

## Forgot the password?

On the machine running Apiary: `apiary user set <name>` (or `apiary user remove` to turn sign-in off). The access link from `apiary token` also still works.

## Plain http

Apiary speaks plain http. At home that is usually fine, but the password is not encrypted on the way. Outside a network you trust, reach it through an SSH tunnel (`ssh -L 7777:127.0.0.1:7777 you@server`), Tailscale, or an https reverse proxy (Apiary then marks the cookie Secure when the proxy sends `X-Forwarded-Proto: https`).
