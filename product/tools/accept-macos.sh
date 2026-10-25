#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || exit 2
: "${1:?Usage: bash product/tools/accept-macos.sh /absolute/path/to/candidate.dmg}"
RUN="$ROOT/.mvv-build/acceptance-$(date +%s)"
mkdir -p "$RUN/mount" "$RUN/home"
exec > >(tee "$RUN/acceptance.log") 2>&1
lsof -nP -iTCP:59100 -sTCP:LISTEN >/dev/null && { echo 'Close the existing dsh-bot before acceptance'; exit 2; }
hdiutil attach "$1" -readonly -nobrowse -mountpoint "$RUN/mount"
SOURCE=$(find "$RUN/mount" -maxdepth 1 -name '*.app' -print -quit)
ditto "$SOURCE" "$RUN/dsh-bot.app"
hdiutil detach "$RUN/mount"
BIN="$RUN/dsh-bot.app/Contents/MacOS/dsh-bot"
file "$BIN" | grep -q arm64
PID=''
stop_app(){ if [[ -n "$PID" ]]; then kill -TERM "$PID" 2>/dev/null || true; for i in {1..60}; do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done; if kill -0 "$PID" 2>/dev/null; then echo 'FAIL shutdown deadline'; return 1; fi; wait "$PID" || true; PID=''; fi; }
trap stop_app EXIT
start_app(){ HOME="$RUN/home" CFFIXED_USER_HOME="$RUN/home" "$BIN" --user-data-dir="$RUN/user-data" > "$RUN/app-$1.log" 2>&1 & PID=$!; }
wait_ready(){ for i in {1..300}; do [[ -f "$RUN/user-data/dsh-home/memory/runtime.json" && -f "$RUN/user-data/dsh-home/bot/bridge.json" ]] && return; kill -0 "$PID" 2>/dev/null || { echo 'FAIL app exited'; return 1; }; sleep 1; done; echo 'FAIL readiness deadline'; return 1; }
start_app first
wait_ready
node product/tools/memory-acceptance.mjs "$RUN/user-data/dsh-home/memory/runtime.json" "$RUN/marker.json" write "$RUN/user-data/dsh-home/bot/bridge.json"
stop_app
[[ ! -f "$RUN/user-data/dsh-home/memory/runtime.json" && ! -f "$RUN/user-data/dsh-home/bot/bridge.json" ]]
start_app restart
wait_ready
node product/tools/memory-acceptance.mjs "$RUN/user-data/dsh-home/memory/runtime.json" "$RUN/marker.json" verify
stop_app
trap - EXIT
echo "PASS macOS app start/stop/restart and Hindsight semantic persistence. Evidence: $RUN"
