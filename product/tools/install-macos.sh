#!/bin/bash
# Stable local acceptance path. Never changes Gatekeeper or quarantine.
set -euo pipefail
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || { echo 'Requires Apple Silicon macOS'; exit 2; }
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
: "${1:?Usage: bash product/tools/install-macos.sh /path/to/dsh-bot.app [--replace]}"
SOURCE=$(cd "$1" && pwd)
TARGET="$HOME/Applications/dsh-bot.app"
node "$ROOT/product/tools/verify-macos-app.mjs" "$SOURCE"
if pgrep -x dsh-bot >/dev/null; then echo 'Quit dsh-bot before installing'; exit 2; fi
mkdir -p "$HOME/Applications"
STAGE=$(mktemp -d "$HOME/Applications/dsh-bot-install.XXXXXX")
trap 'rmdir "$STAGE" 2>/dev/null || true' EXIT
ditto "$SOURCE" "$STAGE/dsh-bot.app"
node "$ROOT/product/tools/verify-macos-app.mjs" "$STAGE/dsh-bot.app"
if [[ -e "$TARGET" ]]; then
  [[ ${2:-} == --replace ]] || { echo "Existing App kept. Staged candidate: $STAGE/dsh-bot.app. Use --replace to back up and replace."; exit 2; }
  BACKUP="$HOME/Applications/dsh-bot-backup-$(date +%Y%m%d-%H%M%S)-$$.app"
  mv "$TARGET" "$BACKUP"
  echo "Rollback App: $BACKUP"
fi
mv "$STAGE/dsh-bot.app" "$TARGET"
echo "Installed: $TARGET"
echo 'Open this App in Finder. If blocked, inspect Privacy & Security; do not disable Gatekeeper.'
