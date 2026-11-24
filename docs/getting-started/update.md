# Update and uninstall

## Update

```bash
cd ~/.local/share/apiary
git pull
```

Restart Apiary (`systemctl --user restart apiary` if you use the service). Your projects and settings live in `~/.apiary` and are untouched.

## Uninstall

```bash
systemctl --user disable --now apiary 2>/dev/null
rm -f ~/.local/bin/apiary ~/.config/systemd/user/apiary.service
rm -rf ~/.local/share/apiary
```

Your data is kept in `~/.apiary`. Delete it too if you want everything gone:

```bash
rm -rf ~/.apiary
```

Git branches that agents created (`apiary/...`) stay in your repositories. List and delete them with:

```bash
git branch --list 'apiary/*'
git branch -D <name>
```


## Updating from inside Apiary (0.5.0 and later)

Settings → Updates checks GitHub (automatically every few hours too). A new version is **downloaded but not installed**; an **Update ready** chip appears and **Install** sits next to **Check for updates**. Install restarts Apiary and your browser refreshes itself. If agents are working you are asked before they are stopped. Installs that are not a git checkout cannot self-update.
