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


## Updating from inside Apiary

**Settings, System, Updates** checks GitHub. You choose how often: **every day** (the default), **every week**, **every month**, or **only when you press the button**. A new version is **downloaded but not installed**, and an **Update ready** chip appears at the top.

### If nothing is running

Press **Install**. Apiary restarts and shows a progress screen. If anything goes wrong the old version is put back automatically and you are told.

### If agents are working

You are asked first: **wait for the jobs to finish, or install now anyway**.

* **Wait:** the button reads **Waiting for N jobs to finish…**, and N counts down live as jobs finish. **New work is held** while you wait, so the update cannot be delayed forever. When the count reaches zero the button becomes **Update now!**. Press it to install. Held work resumes after Apiary restarts. You can **Cancel** the queued update at any time.
* **Install now anyway:** agents still working are stopped, and anything they were doing on other machines may be cut off part way.

### After the update: What's new

The first thing you see after the restart is a **What's new** window listing what changed since the version you had before. Links inside it open in a new tab so you can come back to the list, and it stays until you press **OK**.

Installs that are not a git checkout cannot self-update. Updating from 0.6.x or older: do the first update with `git pull` and a restart.
