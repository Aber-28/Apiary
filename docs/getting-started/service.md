# Run it as a service

To have Apiary start automatically when you log in, use a **systemd user service**.

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/apiary.service <<'UNIT'
[Unit]
Description=Apiary
After=network-online.target

[Service]
ExecStart=%h/.local/bin/apiary
Restart=on-failure
# Pick up claude, codex and gh from your usual locations
Environment=PATH=%h/.local/bin:%h/.npm-global/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now apiary
```

Check it:

```bash
systemctl --user status apiary
journalctl --user -u apiary -f
```

To keep it running when you are logged out: `loginctl enable-linger $USER`.

{% hint style="info" %}
The service must be able to find `claude`, `codex` and `gh`. If `apiary status` shows them as not found, add their folder to the `Environment=PATH=` line (run `which claude` to find it).
{% endhint %}

## Using it from another device (VM, server, phone)

By default Apiary only accepts connections from the computer it runs on (`127.0.0.1`), so opening `http://<server-ip>:7777` from another machine fails. To allow it, start Apiary in **LAN mode**:

```bash
apiary start --lan
```

It listens on your network, creates a private access token (saved in `~/.apiary/token`) and prints a link for every network address of the machine:

```text
Open it from another device on your network with:
  http://192.168.1.50:7777/?token=3f9c…
```

Open that link once; your browser remembers it. To show the link again later: `apiary token`.

If it still cannot be reached, check the firewall on the machine:

```bash
sudo ufw allow 7777/tcp          # Ubuntu / Debian with ufw
sudo firewall-cmd --add-port=7777/tcp --permanent && sudo firewall-cmd --reload   # Fedora / RHEL
```

For the systemd service, change the `ExecStart` line to `ExecStart=%h/.local/bin/apiary start --lan`, then `systemctl --user daemon-reload && systemctl --user restart apiary`. Run `apiary token` to get the link.

To use a name instead of an IP address (for example `my-server.lan`), add `APIARY_ALLOWED_HOSTS=my-server.lan`. Another port: `apiary start --lan --port 8080`.

{% hint style="danger" %}
Anyone with the link can run commands on that machine as your user. Keep it private and only use it on a network you trust. If it leaves your home network, put it behind HTTPS (for example a reverse proxy or a VPN such as WireGuard or Tailscale). See [Security](../reference/security.md).
{% endhint %}
