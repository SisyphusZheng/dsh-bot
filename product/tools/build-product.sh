#!/usr/bin/env bash
# Reproducible WhaleGirlBot product build.
#
# Derives the external workspace inputs (desk-pet bundle, voice worker/client,
# G2 bridge, optional memory runtime) from this project directory and passes
# them to the DSH desktop packaging explicitly, so the packaging configuration
# contains no developer absolute paths. Fails if the build mutates tracked
# sources, then copies the DMG + SHA-256 into dist/v0.1/.
#
# Usage: tools/build-product.sh [unsigned]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$HERE/.." && pwd)"
FORK="${NISSE_FORK:-$(cd "$PROJECT_ROOT/../nisse-dsh" && pwd)}"
MODE="${1:-unsigned}"

export NISSE_PET_BUNDLE="${NISSE_PET_BUNDLE:-$PROJECT_ROOT/m3/pet/.package-runtime/dist/mac-arm64/NissePet.app}"
export NISSE_VOICE_WORKER_DIR="${NISSE_VOICE_WORKER_DIR:-$PROJECT_ROOT/m5/voice-spike/dist/VoiceWorker}"
export NISSE_VOICE_CLIENT_BUNDLE="${NISSE_VOICE_CLIENT_BUNDLE:-$PROJECT_ROOT/m5/voice-spike/client/inject-bundle.js}"
export NISSE_BRIDGE_PLUGIN_DIR="${NISSE_BRIDGE_PLUGIN_DIR:-$PROJECT_ROOT/m5/dsh-bridge}"

# Bundled memory runtime payload (Hindsight + int8 ONNX model + pg0 + adapter).
export NISSE_MEMORY_DIR="${NISSE_MEMORY_DIR:-$PROJECT_ROOT/product/memory}"

missing=0
for name in NISSE_PET_BUNDLE NISSE_VOICE_WORKER_DIR NISSE_VOICE_CLIENT_BUNDLE NISSE_BRIDGE_PLUGIN_DIR NISSE_MEMORY_DIR; do
  value="${!name}"
  if [[ ! -e "$value" ]]; then
    echo "ERROR: $name missing: $value" >&2
    missing=1
  fi
done
if [[ "$missing" -ne 0 ]]; then
  echo "Refusing to build with missing workspace inputs." >&2
  exit 2
fi

cd "$FORK"
BEFORE="$(git status --porcelain)"
echo "workspace inputs:"
printf '  %s=%s\n' NISSE_PET_BUNDLE "$NISSE_PET_BUNDLE" NISSE_VOICE_WORKER_DIR "$NISSE_VOICE_WORKER_DIR" \
  NISSE_VOICE_CLIENT_BUNDLE "$NISSE_VOICE_CLIENT_BUNDLE" NISSE_BRIDGE_PLUGIN_DIR "$NISSE_BRIDGE_PLUGIN_DIR" \
  NISSE_MEMORY_DIR "$NISSE_MEMORY_DIR"

case "$MODE" in
  unsigned) pnpm run package:desktop:mac:arm64:unsigned ;;
  *) echo "usage: $0 [unsigned]" >&2; exit 1 ;;
esac

AFTER="$(git status --porcelain)"
if [[ "$BEFORE" != "$AFTER" ]]; then
  echo "ERROR: build modified tracked sources:" >&2
  diff <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER") >&2 || true
  exit 3
fi

ARTIFACT_DIR="$FORK/apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts"
DMG="$(ls -t "$ARTIFACT_DIR"/whalegirlbot-0.1.0-mac-arm64-unsigned.dmg 2>/dev/null | head -1)"
if [[ -z "$DMG" ]]; then
  echo "ERROR: expected DMG not found in $ARTIFACT_DIR" >&2
  exit 4
fi
mkdir -p "$PROJECT_ROOT/dist/v0.1"
cp "$DMG" "$PROJECT_ROOT/dist/v0.1/"
BASE="$(basename "$DMG")"
( cd "$PROJECT_ROOT/dist/v0.1" && shasum -a 256 "$BASE" | tee SHA256SUMS.txt )
echo "BUILD OK: $PROJECT_ROOT/dist/v0.1/$BASE"
