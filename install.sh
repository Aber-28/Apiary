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

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1. $2" >&2; exit 1; }; }
need git "Install git first."
need node "Install Node.js 20 or newer (https://nodejs.org)."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node.js 20 or newer is required (found $(node --version))." >&2; exit 1; }

if [ -d "$DIR/.git" ]; then
  echo "Updating Apiary in $DIR"; git -C "$DIR" pull --ff-only
else
  echo "Installing Apiary into $DIR"; mkdir -p "$(dirname "$DIR")"; git clone --depth 1 "$REPO" "$DIR"
fi
mkdir -p "$BIN"; chmod +x "$DIR/bin/apiary.js"; ln -sf "$DIR/bin/apiary.js" "$BIN/apiary"
APIARY="$BIN/apiary"
echo; echo "Installed: $APIARY"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "To use the short command 'apiary', add it to your PATH:  echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.bashrc && source ~/.bashrc" ;; esac
command -v claude >/dev/null || echo "Note: 'claude' CLI not found (npm install -g @anthropic-ai/claude-code), or use a web API key."
command -v codex  >/dev/null || echo "Note: 'codex' CLI not found (npm install -g @openai/codex), or use a web API key."

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
  if node -e "fetch('http://127.0.0.1:$PORT/').then(r=>r.text()).then(t=>process.exit(t.includes('Apiary')?0:1),()=>process.exit(1))" 2>/dev/null; then ready=1; break; fi
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
  echo; echo "Open it from your other device with this private link (it contains your access token, so keep it to yourself):"
  "$APIARY" token | grep -E '^http' || echo "  (run: $APIARY token)"
  echo "If the page does not open, the firewall may block port $PORT (for example: sudo ufw allow $PORT/tcp)."
else
  echo; echo "Open it on this computer:  http://127.0.0.1:$PORT"
  echo "To open it from other devices later, run this installer again with --lan:"
  echo "  curl -fsSL https://raw.githubusercontent.com/Aber-28/Apiary/main/install.sh | bash -s -- --lan"
fi
[ "$started" = background ] && echo "It runs in the background for now. To start it automatically, a systemd user session is needed (log in normally, then run the installer again)."
exit 0
