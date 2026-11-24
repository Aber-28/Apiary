#!/usr/bin/env bash
# Apiary installer: installs Apiary, starts it, and tells you where to open it.
#   curl -fsSL https://raw.githubusercontent.com/Aber-28/Apiary/main/install.sh | bash
# Options (after `bash -s --`):  --lan  reachable from other devices on your network (with an access token)
#                                --local  only this computer     --no-service  do not run it as a service
set -euo pipefail
REPO="${APIARY_REPO:-https://github.com/Aber-28/Apiary.git}"
DIR="${APIARY_DIR:-$HOME/.local/share/apiary}"
BIN="${APIARY_BIN:-$HOME/.local/bin}"
DATA="${APIARY_HOME:-$HOME/.apiary}"
PORT="${APIARY_PORT:-7777}"
LAN=""; SERVICE=1
for a in "$@"; do case "$a" in --lan) LAN=yes ;; --local) LAN=no ;; --no-service) SERVICE=0 ;; esac; done

# git, curl and Node.js 20+ are needed. On Debian/Ubuntu the installer can fetch them for you (it asks first).
nodeok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
missing=""
command -v git >/dev/null 2>&1 || missing="$missing git"
command -v curl >/dev/null 2>&1 || missing="$missing curl"
nodeok || missing="$missing nodejs"
if [ -n "$missing" ]; then
  echo "Apiary needs:$missing"
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "This is not Debian/Ubuntu, so install them yourself: git, curl and Node.js 20 or newer (https://nodejs.org)." >&2; exit 1
  fi
  SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
  if [ -n "$SUDO" ] && ! command -v sudo >/dev/null 2>&1; then echo "sudo is not available. Run this installer as root, or install:$missing" >&2; exit 1; fi
  go=""
  if [ "${APIARY_YES:-}" = 1 ]; then go=y
  elif { : </dev/tty; } 2>/dev/null; then
    printf 'Install them now with apt (this asks for your password)? [Y/n] ' >/dev/tty; read -r go </dev/tty || go=""; [ -z "$go" ] && go=y
  fi
  case "$go" in y|Y|yes|YES) ;; *) echo "Install them, then run this installer again:  sudo apt install -y git curl   (and Node.js 20+: https://nodejs.org)" >&2; exit 1 ;; esac
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get update -y
  $SUDO apt-get install -y git curl ca-certificates
  if ! nodeok; then
    echo "Adding the official NodeSource Node.js 22 repository…"
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
    $SUDO apt-get install -y nodejs
  fi
  nodeok || { echo "Node.js 20 or newer is still missing. Install it from https://nodejs.org and run this again." >&2; exit 1; }
  echo "Prerequisites installed."
fi

if [ -d "$DIR/.git" ]; then
  echo "Updating Apiary in $DIR"; git -C "$DIR" pull --ff-only
else
  echo "Installing Apiary into $DIR"; mkdir -p "$(dirname "$DIR")"; git clone --depth 1 "$REPO" "$DIR"
fi
mkdir -p "$BIN"; chmod +x "$DIR/bin/apiary.js"; ln -sf "$DIR/bin/apiary.js" "$BIN/apiary"
APIARY="$BIN/apiary"
echo; echo "Installed: $APIARY"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "To use the short command 'apiary', add it to your PATH:  echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.bashrc && source ~/.bashrc" ;; esac
if ! command -v claude >/dev/null && ! command -v codex >/dev/null && [ ! -x "$BIN/claude" ] && [ ! -x "$BIN/codex" ]; then
  echo "No AI tool (Claude Code or Codex) is installed yet. You do not need to do anything: Apiary offers to install one for you when you open it."
fi

# Who may open it? Only this computer (safest), or other devices on the network (needs the access token).
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/apiary.service"
if [ -z "$LAN" ]; then
  if { : </dev/tty; } 2>/dev/null; then
    printf '\nWill you open Apiary from another device (for example a laptop, with this installed on a server)? [y/N] ' >/dev/tty
    read -r ans </dev/tty || ans=""
    case "$ans" in y|Y|yes|YES) LAN=yes ;; *) LAN=no ;; esac
  elif [ -f "$UNIT" ] && grep -q -- '--lan' "$UNIT"; then LAN=yes   # keep what was chosen before
  else LAN=no; fi
fi
LANFLAG=""; [ "$LAN" = yes ] && LANFLAG="--lan"

# For other devices, offer a username and password (so no long link is needed). Skipped when one exists or there is no keyboard.
if [ "$LAN" = yes ] && { : </dev/tty; } 2>/dev/null && ! "$APIARY" user 2>/dev/null | grep -q 'is on'; then
  printf '\nCreate a username and password for signing in from other devices? [Y/n] ' >/dev/tty; read -r ua </dev/tty || ua=""
  case "$ua" in n|N|no|NO) ;; *)
    printf 'Username: ' >/dev/tty; read -r uname </dev/tty || uname=""
    [ -n "$uname" ] && { "$APIARY" user set "$uname" </dev/tty || echo "Skipped. You can do it later: apiary user set <name>"; } ;;
  esac
fi

# Start it: as a service (starts at every login and restarts itself) when systemd is available, else in the background.
started=""
if [ "$SERVICE" = 1 ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  if "$APIARY" service install $LANFLAG >/dev/null && systemctl --user restart apiary; then started=service; fi
fi
if [ -z "$started" ]; then
  mkdir -p "$DATA"
  nohup "$APIARY" start $LANFLAG >"$DATA/apiary.log" 2>&1 </dev/null &
  started=background
fi

# Wait until it really answers, so "installed" never means "not running".
ready=""
for _ in $(seq 1 40); do
  if node -e "fetch('http://127.0.0.1:$PORT/',{headers:{accept:'text/html'}}).then(r=>r.text()).then(t=>process.exit(t.includes('Apiary')?0:1),()=>process.exit(1))" 2>/dev/null; then ready=1; break; fi
  sleep 0.5
done

echo
if [ -z "$ready" ]; then
  echo "Apiary was installed but is not answering on port $PORT (something else may be using that port)." >&2
  if [ "$started" = service ]; then echo "Look at why with:  journalctl --user -u apiary -n 40" >&2; else echo "Look at why with:  cat $DATA/apiary.log" >&2; fi
  echo "If the port is already used, pick another:  APIARY_PORT=7790 $APIARY" >&2
  exit 1
fi
echo "✔ Apiary is running$([ "$started" = service ] && echo ' (as a service: it starts by itself and restarts if it stops)')."
if [ "$LAN" = yes ]; then
  if "$APIARY" user 2>/dev/null | grep -q 'is on'; then echo; echo "Open it from your other device and sign in with your username and password:"; "$APIARY" token | grep -E '^http' | sed -E 's#/\?token=.*#/#'; echo; echo "(Backup: the private link below also works. It contains an access token, so keep it to yourself.)"; else echo; echo "Open it from your other device with this private link (it contains your access token, so keep it to yourself):"; fi
  "$APIARY" token | grep -E '^http' || echo "  (run: $APIARY token)"
  echo "If the page does not open, the firewall may block port $PORT (for example: sudo ufw allow $PORT/tcp)."
else
  echo; echo "Open it on this computer:  http://127.0.0.1:$PORT"
  echo "To open it from other devices later, run this installer again with --lan:"
  echo "  curl -fsSL https://raw.githubusercontent.com/Aber-28/Apiary/main/install.sh | bash -s -- --lan"
fi
[ "$started" = background ] && echo "It runs in the background for now. To start it automatically, a systemd user session is needed (log in normally, then run the installer again)."
exit 0
