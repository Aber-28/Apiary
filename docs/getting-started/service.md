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

## Using it from another device

By default Apiary only accepts connections from the computer it runs on. To open it from your phone or another PC, set a token **and** the allowed host name:

```bash
APIARY_HOST=0.0.0.0 APIARY_TOKEN='a-long-random-secret' APIARY_ALLOWED_HOSTS=my-server.lan apiary
```

Open `http://my-server.lan:7777/?token=a-long-random-secret` once; your browser remembers it. Apiary refuses to listen on a non-local address without a token. Put it behind HTTPS (for example a reverse proxy) if it leaves your home network. See [Security](../reference/security.md).
