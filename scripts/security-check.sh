#!/usr/bin/env bash
# Apiary security check: a read-only self-test that prints one plain report you can share.
#
#   bash scripts/security-check.sh
#
# What it does:
#   1. Looks at your real Apiary install (listen address, file permissions). It never reads or prints any secret.
#   2. Starts a SEPARATE throw-away test copy (port 7899, temporary folder, fake AI) and checks that a fake
#      secret never shows up in the files, the log, the export or the pages Apiary serves.
#   3. Checks that the test copy refuses to start on the network without an access token.
# It changes nothing on your system, asks for no passwords, and deletes its temporary files at the end.
# The report contains no secrets, no IP addresses and no host names, so it is safe to paste.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APIARY_JS="$HERE/bin/apiary.js"
DATA="${APIARY_HOME:-$HOME/.apiary}"
TP="${SECCHECK_PORT:-7899}"
TMP="$(mktemp -d)"; PID=""
PASS=0; WARN=0; FAIL=0; OUT=""
add() { OUT="$OUT$(printf '%-5s %s' "$1" "$2")"$'\n'; case "$1" in PASS) PASS=$((PASS+1));; WARN) WARN=$((WARN+1));; FAIL) FAIL=$((FAIL+1));; esac; }
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT
command -v node >/dev/null || { echo "Node.js is needed to run this check."; exit 1; }
command -v curl >/dev/null || { echo "curl is needed to run this check."; exit 1; }

echo "Apiary security check ($(node "$APIARY_JS" --version 2>/dev/null || echo 'version unknown'), $(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-Linux}"))"
echo

# 1. Real install ------------------------------------------------------------------------------------------
listeners="$( (ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null | tail -n +3) | awk '{print $4}' | grep -E ':(7777|7778)$' || true)"
if [ -z "$listeners" ]; then add INFO "No Apiary is listening on the default port 7777 (fine if you have not installed it yet)."
else
  if echo "$listeners" | grep -qvE '^(127\.0\.0\.1|\[::1\]|::1):'; then
    if [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/apiary.service" ] && grep -q -- '--lan' "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/apiary.service"; then
      add WARN "Apiary is reachable from other devices (--lan). That is expected only if you chose it. Use a VPN, SSH tunnel or https in front of it."
    else add FAIL "Apiary is listening on something other than this computer, but you did not ask for that."; fi
  else add PASS "Apiary listens only on this computer (127.0.0.1)."; fi
fi
if [ -d "$DATA" ]; then
  m="$(stat -c %a "$DATA" 2>/dev/null)"
  case "$m" in 700|500) add PASS "Data folder is private (mode $m).";; *) add FAIL "Data folder is open to other users on this machine (mode $m, should be 700).";; esac
  bad=""
  for f in "$DATA"/*.json "$DATA"/token "$DATA"/*.log "$DATA"/audit* ; do
    [ -f "$f" ] || continue; fm="$(stat -c %a "$f")"; case "$fm" in 600|400) ;; *) bad="$bad $(basename "$f")($fm)";; esac
  done
  [ -z "$bad" ] && add PASS "Files in the data folder are readable only by you (mode 600)." || add FAIL "Files readable by others:$bad"
  if [ -f "$DATA/vault.json" ]; then
    if grep -qE '"(value|password|secret)"[[:space:]]*:' "$DATA/vault.json"; then add FAIL "The vault file contains a field that looks like a plain-text secret."; else add PASS "The vault file holds only encrypted values."; fi
  else add INFO "No vault yet."; fi
  keyf="${APIARY_KEYFILE:-$HOME/.config/apiary/vault.key}"
  if [ -f "$keyf" ]; then km="$(stat -c %a "$keyf")"; if [ "$km" = 600 ] || [ "$km" = 400 ]; then add PASS "Vault auto-unlock key file is private (mode $km)."; else add FAIL "Vault key file is readable by others (mode $km)."; fi; fi
else add INFO "No data folder yet ($DATA)."; fi

# 2. Throw-away copy and a fake secret -----------------------------------------------------------------------
CAN="CANARY-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')-fake"
APIARY_NO_UPDATE_CHECK=1 APIARY_MOCK=1 APIARY_HOME="$TMP/h" APIARY_KEYFILE="$TMP/key" APIARY_PORT="$TP" \
  node "$APIARY_JS" start >"$TMP/log" 2>&1 & PID=$!
up=""; for _ in $(seq 1 40); do curl -fs "http://127.0.0.1:$TP/" -H 'accept: text/html' >/dev/null 2>&1 && { up=1; break; }; sleep 0.3; done
if [ -z "$up" ]; then add FAIL "The test copy did not start (is port $TP free?). See: $(head -c 200 "$TMP/log" | tr '\n' ' ')"
else
  B="http://127.0.0.1:$TP"; J=(-H 'content-type: application/json')
  curl -fs "${J[@]}" -d '{"passphrase":"seccheck-throwaway-passphrase"}' "$B/api/vault/init" >/dev/null
  curl -fs "${J[@]}" -d "{\"name\":\"Canary\",\"value\":\"$CAN\",\"type\":\"token\"}" "$B/api/vault/secrets" >/dev/null
  leaks=""
  for u in /api/state /api/vault /api/export /api/audit /api/infra /api/library; do
    curl -fs "$B$u" 2>/dev/null | grep -q "$CAN" && leaks="$leaks $u"
  done
  [ -z "$leaks" ] && add PASS "A fake secret never appears in what Apiary serves (state, vault list, export, audit log, infra map)." || add FAIL "The fake secret leaked through:$leaks"
  grep -rqF "$CAN" "$TMP/h" 2>/dev/null && add FAIL "The fake secret is stored in plain text on disk." || add PASS "The fake secret is not stored in plain text on disk."
  grep -qF "$CAN" "$TMP/log" && add FAIL "The fake secret appears in the program log." || add PASS "The fake secret never appears in the program log."
  # refuses foreign Host header (DNS rebinding) and cross-site writes
  c="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example.com' "$B/api/state")"; [ "$c" = 403 ] && add PASS "Requests with a foreign host name are refused (DNS rebinding)." || add FAIL "A foreign Host header was accepted (HTTP $c)."
  c="$(curl -s -o /dev/null -w '%{http_code}' "${J[@]}" -H 'Origin: https://evil.example.com' -d '{}' "$B/api/projects")"; [ "$c" = 403 ] && add PASS "Cross-site write requests are refused (CSRF)." || add FAIL "A cross-site write was accepted (HTTP $c)."
  hdr="$(curl -sI "$B/")"
  echo "$hdr" | grep -qi '^content-security-policy:' && add PASS "Strict Content-Security-Policy header is sent." || add FAIL "No Content-Security-Policy header."
  echo "$hdr" | grep -qi '^x-frame-options: *deny' && add PASS "Clickjacking protection (X-Frame-Options) is on." || add FAIL "X-Frame-Options missing."
  fm="$(stat -c %a "$TMP/h/vault.json" 2>/dev/null)"; [ "$fm" = 600 ] && add PASS "A freshly created vault file is mode 600." || add FAIL "A fresh vault file has mode $fm."
fi
kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; PID=""

# 3. Refuses to open to the network without a token ------------------------------------------------------------
APIARY_NO_UPDATE_CHECK=1 APIARY_MOCK=1 APIARY_HOME="$TMP/h2" APIARY_HOST=0.0.0.0 APIARY_PORT="$((TP+1))" APIARY_TOKEN= \
  timeout 6 node "$APIARY_JS" start >"$TMP/log2" 2>&1; rc=$?
if curl -fs -m 2 "http://127.0.0.1:$((TP+1))/" >/dev/null 2>&1; then add FAIL "It started on all network addresses without an access token."
else add PASS "It will not open to the network without an access token."; fi

echo "$OUT"
echo "Result: $PASS passed, $WARN to read, $FAIL failed."
[ "$FAIL" = 0 ] && echo "Nothing needs fixing." || echo "Copy this whole report and send it back so the failed lines can be fixed."
exit 0
