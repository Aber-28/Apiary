#!/usr/bin/env bash
# Apiary installer: clones the repository and links the `apiary` command.
set -euo pipefail
REPO="${APIARY_REPO:-https://github.com/Aber-28/Apiary.git}"
DIR="${APIARY_DIR:-$HOME/.local/share/apiary}"
BIN="${APIARY_BIN:-$HOME/.local/bin}"

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
echo; echo "Installed: $BIN/apiary"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Add it to your PATH:  echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.bashrc && source ~/.bashrc" ;; esac
command -v claude >/dev/null || echo "Note: 'claude' CLI not found (npm install -g @anthropic-ai/claude-code), or use a web API key."
command -v codex  >/dev/null || echo "Note: 'codex' CLI not found (npm install -g @openai/codex), or use a web API key."
echo; echo "Start it with:  apiary     then open http://127.0.0.1:7777"
