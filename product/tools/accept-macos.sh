#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || exit 2
: "${1:?Usage: bash product/tools/accept-macos.sh /absolute/path/to/candidate.dmg}"
MANIFEST=${2:-$ROOT/.mvv-build/evidence/macos-build.json}
node product/tools/macos-artifacts.mjs verify "$1" "$MANIFEST"
RUN="$ROOT/.mvv-build/acceptance-$(date +%s)"
mkdir -p "$RUN/mount" "$RUN/home"
exec > >(tee "$RUN/acceptance.log") 2>&1
lsof -nP -iTCP:59100 -sTCP:LISTEN >/dev/null && { echo 'Close the existing dsh-bot before acceptance'; exit 2; }
trap 'hdiutil detach "$RUN/mount" >/dev/null 2>&1 || true' EXIT
hdiutil attach "$1" -readonly -nobrowse -mountpoint "$RUN/mount"
SOURCE=$(find "$RUN/mount" -maxdepth 1 -name '*.app' -print -quit)
ditto "$SOURCE" "$RUN/dsh-bot.app"
hdiutil detach "$RUN/mount"
node product/tools/macos-artifacts.mjs app "$RUN/dsh-bot.app"
BIN="$RUN/dsh-bot.app/Contents/MacOS/dsh-bot"
file "$BIN" | grep -q arm64
PID=''
OPEN_PID=''
record(){ node product/tools/record-macos-acceptance.mjs "$RUN" "$MANIFEST" "$@"; }
record initialize
stop_app(){
  if [[ -z "$PID" && -n "$OPEN_PID" ]]; then PID=$(node product/tools/find-macos-app-pid.mjs "$RUN/user-data") || return 1; fi
  if [[ -n "$PID" ]]; then
    kill -TERM "$PID" 2>/dev/null || true
    for i in {1..60}; do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
    if kill -0 "$PID" 2>/dev/null; then echo 'FAIL shutdown deadline'; record shutdown FAIL; return 1; fi
    PID=''
  fi
  if [[ -n "$OPEN_PID" ]]; then
    for i in {1..20}; do kill -0 "$OPEN_PID" 2>/dev/null || break; sleep 0.5; done
    if kill -0 "$OPEN_PID" 2>/dev/null; then echo 'FAIL LaunchServices wrapper shutdown deadline'; return 1; fi
    local code=0; wait "$OPEN_PID" || code=$?; OPEN_PID=''
    if [[ $code -ne 0 ]]; then echo "FAIL LaunchServices exit status $code"; return 1; fi
  fi
}
cleanup(){ local result=$?; trap - EXIT; if ! stop_app; then result=1; fi; if [[ $result -ne 0 ]]; then record overall FAIL; fi; exit "$result"; }
trap cleanup EXIT
start_app(){
  # LaunchServices need not inherit HOME. Isolation is through user-data-dir.
  node -e 'require("fs").rmSync(process.argv[1],{force:true})' "$RUN/user-data/DevToolsActivePort"
  env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS /usr/bin/open -n -W "$RUN/dsh-bot.app" --args --user-data-dir="$RUN/user-data" --remote-debugging-address=127.0.0.1 --remote-debugging-port=0 > "$RUN/launchservices-$1.log" 2>&1 & OPEN_PID=$!
  for i in {1..90}; do
    PID=$(node product/tools/find-macos-app-pid.mjs "$RUN/user-data") || return 1
    if [[ -n "$PID" ]]; then return 0; fi
    if ! kill -0 "$OPEN_PID" 2>/dev/null; then cat "$RUN/launchservices-$1.log"; echo 'FAIL normal LaunchServices start'; return 1; fi
    sleep 0.5
  done
  echo 'FAIL LaunchServices process deadline'; return 1
}
phase(){ local name=$1; shift; echo "START $name"; if "$@"; then record "$name" PASS; else record "$name" FAIL; return 1; fi; }
wait_ready(){
  local launch=$1
  phase "$launch-bridge" node product/tools/wait-agent-ready.mjs "$RUN/user-data/dsh-home/bot/bridge.json"
  phase "$launch-web-boot-and-navigation" node product/tools/desktop-web-acceptance.mjs "$RUN/user-data" "$RUN/user-data/dsh-home/bot/bridge.json" "$RUN/web-$launch.json"
  phase "$launch-memory" node product/tools/wait-memory-ready.mjs "$RUN/user-data/dsh-home/memory/runtime.json"
}
descriptors_gone(){ [[ ! -f "$RUN/user-data/dsh-home/memory/runtime.json" && ! -f "$RUN/user-data/dsh-home/bot/bridge.json" ]]; }
phase native-signatures node product/tools/verify-macos-app.mjs "$RUN/dsh-bot.app"
phase first-launchservices start_app first
wait_ready first
phase memory-write-and-cross-session node product/tools/memory-acceptance.mjs "$RUN/user-data/dsh-home/memory/runtime.json" "$RUN/marker.json" write "$RUN/user-data/dsh-home/bot/bridge.json"
phase first-shutdown stop_app
phase first-descriptor-cleanup descriptors_gone
phase restart-launchservices start_app restart
wait_ready restart
phase memory-restart-recall node product/tools/memory-acceptance.mjs "$RUN/user-data/dsh-home/memory/runtime.json" "$RUN/marker.json" verify
phase restart-shutdown stop_app
phase restart-descriptor-cleanup descriptors_gone
trap - EXIT
record overall PASS
echo "PASS macOS app start/stop/restart and Hindsight semantic persistence. Evidence: $RUN"
