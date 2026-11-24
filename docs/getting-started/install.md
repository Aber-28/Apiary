# Install on Linux

Apiary has **no dependencies** beyond Node.js. You install it by pulling it from GitHub.

## Requirements

On Debian and Ubuntu the installer checks for git, curl and Node.js 20 or newer, and offers to install whatever is missing with `apt` (it asks first and needs your password). On other distributions, install them yourself.

| Needed | Why | Check |
| --- | --- | --- |
| Linux (any modern distribution) | Apiary runs on your machine | `uname -a` |
| Node.js 20 or newer | Runs the app | `node --version` |
| git | Pulls Apiary and manages agent branches | `git --version` |
| `claude` and/or `codex` CLI | The AI models (or use a web API key instead) | `claude --version` |
| `gh` (optional) | Easiest GitHub login | `gh --version` |

### Install Node.js 20+

Debian / Ubuntu:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

Fedora:

```bash
sudo dnf install -y nodejs git
```

Arch:

```bash
sudo pacman -S nodejs npm git
```

## Option 1: one-line installer (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/Aber-28/Apiary/main/install.sh | bash
```

The script checks Node and git, clones Apiary to `~/.local/share/apiary`, links the `apiary` command into `~/.local/bin`, **starts Apiary**, waits until it really answers, and prints where to open it. Read it first if you like: it is short.

- It asks: *will you open Apiary from another device?* Answer **y** when Apiary is on a server or VM and you use a browser on another computer. You then get a private link that contains your access token.
- With systemd it runs Apiary as a **service**: it starts at login and restarts itself. Without systemd it runs in the background for now.
- Options (after `bash -s --`): `--lan` (reachable from other devices, with a token), `--local` (only this computer), `--no-service`.
- Run it again any time to update, or to switch between local and network access.

```bash
curl -fsSL https://raw.githubusercontent.com/Aber-28/Apiary/main/install.sh | bash -s -- --lan
```

If the page does not open from another device, the firewall may block port 7777 (for example `sudo ufw allow 7777/tcp`).

## Option 2: clone it yourself

```bash
git clone https://github.com/Aber-28/Apiary.git ~/.local/share/apiary
cd ~/.local/share/apiary
mkdir -p ~/.local/bin
ln -sf "$PWD/bin/apiary.js" ~/.local/bin/apiary
```

Make sure `~/.local/bin` is on your `PATH`:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

## Option 3: private repository

If the repository is private, sign in first and clone with the GitHub CLI:

```bash
gh auth login
gh repo clone Aber-28/Apiary ~/.local/share/apiary
```

## Start it

```bash
apiary
```

Then open **http://127.0.0.1:7777** in your browser. The [setup wizard](setup-wizard.md) starts automatically: it connects your AI, lets you choose default models, and asks whether Apiary should start automatically.

**Installed on a VM or server and want to open it from another computer?** Start it with `apiary start --lan` instead. See [Run it as a service](service.md#using-it-from-another-device-vm-server-phone).

To use another port: `APIARY_PORT=8080 apiary`.

## Check it works

```bash
apiary --version
apiary status
```

Next: [First run and connections](first-run.md).
