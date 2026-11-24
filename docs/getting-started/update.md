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

Settings → Updates checks GitHub (automatically every few hours too). A new version is **downloaded but not installed**; an **Update ready** chip appears and **Install** sits next to **Check for updates**. Install opens an **Updating Apiary** screen with a progress bar, a list of steps (download, check, install, verify, restart), a live log and a timer, so you can always see that something is happening. When Apiary is back, the page refreshes itself.

If anything goes wrong the old version is put back automatically and you are told. Updating from 0.6.x or older: do the first update with `git pull` and a restart; the progress screen is there from 0.7.0 on.

The old text: Install restarts Apiary. If agents are working you are asked before they are stopped. Installs that are not a git checkout cannot self-update.
