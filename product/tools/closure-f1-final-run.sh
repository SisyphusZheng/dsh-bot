#!/bin/bash
# Final F1 verification rerun on the final closure candidate (Lead's 2nd-ping protocol).
# Read-only with respect to git and product source: it records state, runs the agreed suites,
# and stops the isolated memory backend it started. It never runs git write commands.
#
# Usage:
#   CLOSURE_M2_ROOT=<private-root> CLOSURE_M2_EVIDENCE=<evidence-dir> \
#     bash product/tools/closure-f1-final-run.sh
set -u
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z ${REPO:-} ]]; then
  echo "cannot resolve the repository root from $SCRIPT_DIR" >&2
  exit 2
fi
# Private scratch root (isolated Hindsight data/backups). No home-directory default:
# without it the memory e2e is skipped instead of guessing a path.
M2_ROOT=${CLOSURE_M2_ROOT:-}
EVIDENCE=${CLOSURE_M2_EVIDENCE:-$REPO/.agent/evidence/closure-2026-10-31}
OUT=$EVIDENCE/f1
STAMP=$(date +%Y%m%dT%H%M%S)
LOG=$OUT/final-rerun-$STAMP.log
SUMMARY=$OUT/final-rerun-$STAMP.summary.txt
mkdir -p "$OUT"
cd "$REPO" || exit 1
strip_env=(env -u DSH_HOME -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_WEB_URL -u DSH_SHELL -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE)
{
  echo "=== F1 final rerun $STAMP ($(date '+%Y-%m-%d %H:%M:%S %Z')) ==="
  echo "HEAD: $(git rev-parse HEAD)"
  echo "branch: $(git branch --show-current)"
  echo "## git status --porcelain (concurrent agents may have edits; record, never revert)"
  git status --porcelain
  echo "## git diff --stat (tracked)"
  git diff --stat
  echo
} | tee "$LOG" | tee "$SUMMARY"

record () { # name command exit
  printf '%-52s exit=%s\n' "$1" "$3" | tee -a "$SUMMARY"
  printf '\n### %s\nexit=%s\ncommand: %s\n' "$1" "$3" "$2" >> "$LOG"
}

# ---- 1. harness/node tests -------------------------------------------------
"${strip_env[@]}" node --test nisse/packages/host-integration/tests/*.test.mjs >>"$LOG" 2>&1
CODE=$?; record "host-integration node --test" "node --test nisse/packages/host-integration/tests/*.test.mjs" "$CODE"
grep -E '^ℹ (tests|pass|fail|skipped)' "$LOG" | tail -4 | tee -a "$SUMMARY"

# ---- 2. refresh generated host artifacts (gitignored) ----------------------
"${strip_env[@]}" node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc -b tsconfig.host.json >>"$LOG" 2>&1
CODE=$?; record "tsc -b tsconfig.host.json" "node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc -b tsconfig.host.json" "$CODE"
"${strip_env[@]}" ./node_modules/.bin/tsdown --config-loader native --env.DSH_BUILD_FACE host >>"$LOG" 2>&1
CODE=$?; record "tsdown host bundle" "./node_modules/.bin/tsdown --config-loader native --env.DSH_BUILD_FACE host" "$CODE"

# ---- 3. start isolated Hindsight for the memory e2e -----------------------
SPECS=(
  apps/desktop/tests/beta2-host-kernel.spec.ts
  apps/desktop/tests/host-integration-mvp.spec.ts
  apps/desktop/tests/f1-projection-ordering.spec.ts
  apps/desktop/tests/f1-host-restart-unknown.spec.ts
)
HINDSIGHT_PID_FILE=
MEM_ENV=()
if [[ -n ${M2_ROOT:-} && -x $M2_ROOT/start-hindsight.sh ]]; then
  HINDSIGHT_PID_FILE=$M2_ROOT/hindsight.pid
  bash "$M2_ROOT/start-hindsight.sh" >>"$LOG" 2>&1
  HEALTHY=0
  for _ in $(seq 1 120); do
    if curl -s -m 2 http://127.0.0.1:5517/health | grep -q '"status":"healthy"'; then HEALTHY=1; break; fi
    sleep 1
  done
  echo "isolated Hindsight healthy=$HEALTHY (port 5517)" | tee -a "$SUMMARY"
  if [[ $HEALTHY -eq 1 ]]; then
    SPECS+=(apps/desktop/tests/f1-m2-memory-e2e.spec.ts)
    MEM_ENV=(CLOSURE_M2_HINDSIGHT_URL=http://127.0.0.1:5517)
  fi
else
  echo "CLOSURE_M2_ROOT/start-hindsight.sh unavailable; f1-m2-memory-e2e skipped and no backend started" | tee -a "$SUMMARY"
fi

# ---- 4. vitest suites -----------------------------------------------------
"${strip_env[@]}" NODE_USE_ENV_PROXY=0 "${MEM_ENV[@]}" \
  npx --yes pnpm@11.28.5 exec vitest run --maxWorkers=1 "${SPECS[@]}" >>"$LOG" 2>&1
CODE=$?; record "vitest F1 + blueprint specs (5 files)" "npx pnpm@11.28.5 exec vitest run --maxWorkers=1 ${SPECS[*]}" "$CODE"
grep -E 'Test Files|Tests  ' "$LOG" | tail -2 | tee -a "$SUMMARY"
grep -E '✓|×' "$LOG" | sed 's/^[[:space:]]*//' | tail -60 >> "$SUMMARY"

# ---- 5. typecheck gate ----------------------------------------------------
"${strip_env[@]}" ./node_modules/.bin/tsx scripts/build.ts --scope typecheck >>"$LOG" 2>&1
CODE=$?; record "tsx scripts/build.ts --scope typecheck" "tsx scripts/build.ts --scope typecheck" "$CODE"
grep -E 'run-gates: (PASS|[0-9]+ passed)|error TS' "$LOG" | tail -8 | tee -a "$SUMMARY"

# ---- 6. stop the isolated backend it started ------------------------------
if [[ -n ${HINDSIGHT_PID_FILE:-} && -f $HINDSIGHT_PID_FILE ]]; then
  PID=$(cat "$HINDSIGHT_PID_FILE" 2>/dev/null || true)
  if [[ -n ${PID:-} ]]; then
    kill -TERM "$PID" 2>/dev/null || true
    sleep 8
  fi
fi
{
  echo "## teardown"
  lsof -nP -iTCP:5517 -sTCP:LISTEN 2>/dev/null || echo "5517 free"
  ps aux | grep "product/memory/sidecar.mjs" | grep -v grep | head -3 || true
} | tee -a "$SUMMARY" | tee -a "$LOG"

echo "done: $LOG / $SUMMARY"
