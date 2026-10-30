#!/bin/bash
# beta2 combined macOS acceptance: the baseline accept-macos.sh 15 checks stay
# byte-identical and run first; the B2 native checks then run against the SAME
# installed app copy (no second DMG install, no rebuilt app).
#
# usage:
#   bash product/tools/accept-beta2-macos.sh /absolute/path/to/candidate.dmg \
#     [build-manifest.json] [output-dir]
#
# Notes:
#  - refuses while 127.0.0.1:59100 is listening (same precondition as accept-macos.sh);
#  - does not build the app, does not touch git, does not publish anything;
#  - writes base-acceptance.log, native/ logs + B2-NATIVE-RESULTS.json and a
#    combined summary.json/summary.md under the output dir.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || { echo 'BLOCKED-ENVIRONMENT: Apple Silicon macOS required'; exit 2; }
: "${1:?Usage: bash product/tools/accept-beta2-macos.sh /absolute/path/to/candidate.dmg [manifest] [outDir]}"
DMG=$1
MANIFEST=${2:-$ROOT/.mvv-build/evidence/macos-build.json}
OUT=${3:-$ROOT/.mvv-build/beta2-acceptance-$(date +%s)}
mkdir -p "$OUT"
LOG="$OUT/accept-beta2.log"
exec > >(tee "$LOG") 2>&1
echo "START accept-beta2-macos $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "ROOT=$ROOT"
echo "DMG=$DMG"
echo "MANIFEST=$MANIFEST"
echo "OUT=$OUT"
[[ -f "$DMG" ]] || { echo "FAIL DMG missing: $DMG"; exit 2; }
[[ -f "$MANIFEST" ]] || { echo "FAIL manifest missing: $MANIFEST"; exit 2; }
if /usr/sbin/lsof -nP -iTCP:59100 -sTCP:LISTEN >/dev/null 2>&1; then
  echo 'BLOCKED-ENVIRONMENT: 127.0.0.1:59100 is listening (reference/dev dsh-bot). Quit it gracefully before native acceptance; this script never kills it.'
  exit 2
fi

# --- stale packaged-App cleanup (Lead-required precondition) -----------------
# Only processes whose executable is under THIS repo's .mvv-build/acceptance-*/app
# are touched; user/dev dsh-bot instances are never matched.
stale_report="$OUT/stale-app-cleanup.txt"
python3 - "$ROOT" "$stale_report" <<'PY_STALE'
import os, signal, subprocess, sys, time
root, report = sys.argv[1], sys.argv[2]
marker = os.path.join(root, '.mvv-build', 'acceptance-')
def scan():
    out = subprocess.run(['ps', '-axo', 'pid=,command='], capture_output=True, text=True).stdout
    hits = []
    for line in out.splitlines():
        line = line.strip()
        if not line or 'dsh-bot.app/Contents/MacOS/dsh-bot' not in line or marker not in line:
            continue
        if '/.mvv-build/acceptance-' not in line:
            continue
        try: pid = int(line.split(None, 1)[0])
        except ValueError: continue
        # Only the packaged app binary path, never our shell/grep lines.
        command = line.split(None, 1)[1]
        if not any(command.startswith(p) or (' ' + p) in command for p in [marker]) and marker not in command:
            continue
        hits.append((pid, command[:300]))
    return hits
before = scan()
killed, survivors = [], []
for pid, _ in before:
    try:
        os.kill(pid, signal.SIGTERM); killed.append(pid)
    except ProcessLookupError:
        pass
    except PermissionError:
        survivors.append(pid)
deadline = time.time() + 20
while time.time() < deadline:
    if not scan(): break
    time.sleep(0.5)
left = scan()
for pid, _ in left:
    try: os.kill(pid, signal.SIGKILL); survivors.append(pid)
    except ProcessLookupError: pass
    except PermissionError: pass
time.sleep(1)
remaining = scan()
lines = [
    f'utc={time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}',
    f'stale_before={len(before)}',
    f'pids_termed={killed}',
    f'force_killed={survivors}',
    f'remaining_after={len(remaining)}',
    f'listeners_59100={subprocess.run(["/usr/sbin/lsof","-nP","-iTCP:59100","-sTCP:LISTEN"],capture_output=True,text=True).stdout.strip() or "none"}',
]
open(report, 'w').write('\n'.join(lines) + '\n')
print('\n'.join(lines))
sys.exit(0 if not remaining else 4)
PY_STALE
STALE_RC=$?
if [[ $STALE_RC -ne 0 ]]; then
  echo "BLOCKED-ENVIRONMENT: could not clear stale .mvv-build acceptance App instances (see $stale_report)"
  exit 2
fi
if /usr/sbin/lsof -nP -iTCP:59100 -sTCP:LISTEN >/dev/null 2>&1; then
  echo 'BLOCKED-ENVIRONMENT: 127.0.0.1:59100 is listening after stale-App cleanup; refusing to run'
  exit 2
fi
# -----------------------------------------------------------------------------

python3 - "$DMG" "$MANIFEST" "$OUT" <<'PY'
import hashlib, json, sys
from pathlib import Path
dmg, manifest_path, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
manifest = json.loads(manifest_path.read_text())
sha = hashlib.sha256()
with dmg.open('rb') as handle:
    for chunk in iter(lambda: handle.read(1 << 20), b''):
        sha.update(chunk)
actual = sha.hexdigest()
record = {
    'schemaVersion': 1,
    'kind': 'beta2-acceptance-input-binding',
    'dmg': str(dmg.resolve()),
    'dmgSha256': actual,
    'manifestPath': str(manifest_path.resolve()),
    'manifestArtifactSha256': manifest.get('artifact', {}).get('sha256'),
    'manifestSourceCommit': manifest.get('sourceCommit'),
    'matchesManifest': actual == manifest.get('artifact', {}).get('sha256'),
    'manifestPathMatches': str(manifest.get('artifact', {}).get('path', '')) == str(dmg.resolve()),
}
(out / 'input-binding.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps(record, indent=2))
sys.exit(0 if record['matchesManifest'] else 3)
PY
BINDING_RC=$?
if [[ $BINDING_RC -ne 0 ]]; then
  echo "FAIL candidate DMG does not match the build manifest (exit $BINDING_RC); not running acceptance on the wrong bytes"
  exit 1
fi

echo "STEP base-acceptance start $(date -u +%Y-%m-%dT%H:%M:%SZ)"
BASE_START=$(date +%s)
BASE_RC=0
bash product/tools/accept-macos.sh "$DMG" "$MANIFEST" 2>&1 | tee "$OUT/base-acceptance.log" || BASE_RC=$?
BASE_DUR=$(( $(date +%s) - BASE_START ))
echo "STEP base-acceptance done exit=$BASE_RC duration=${BASE_DUR}s"
BASE_RUN=$(sed -n 's/^PASS macOS app start\/stop\/restart and Hindsight semantic persistence\. Evidence: \(.*\)$/\1/p' "$OUT/base-acceptance.log" | tail -1)
if [[ -z "$BASE_RUN" ]]; then
  BASE_RUN=$(sed -n 's/^.*Evidence: \(\/.*\)$/\1/p' "$OUT/base-acceptance.log" | tail -1)
fi
if [[ -z "$BASE_RUN" || ! -d "$BASE_RUN" ]]; then
  BASE_RUN=$(ls -dt "$ROOT"/.mvv-build/acceptance-* 2>/dev/null | head -1 || true)
fi
echo "BASE_RUN=${BASE_RUN:-none}"
BASE_RESULTS="$BASE_RUN/RESULTS.json"
if [[ -n "$BASE_RUN" && -f "$BASE_RESULTS" ]]; then
  cp "$BASE_RESULTS" "$OUT/base-RESULTS.json"
  node -e 'const r=require(process.argv[1]);const required=["native-signatures","first-launchservices","restart-launchservices","first-bridge","first-web-boot-and-navigation","first-memory","memory-write-and-cross-session","first-shutdown","first-descriptor-cleanup","restart-bridge","restart-web-boot-and-navigation","restart-memory","memory-restart-recall","restart-shutdown","restart-descriptor-cleanup"];const missing=required.filter(n=>r.phases?.[n]!=="PASS");console.log(JSON.stringify({status:r.status,phases:r.phases,missing,fifteenChecksPresent:required.length===15},null,2));process.exit(r.status==="PASS"&&missing.length===0?0:1)' "$BASE_RESULTS" > "$OUT/base-phase-summary.json" || true
fi
BASE_APP_COPY=""
[[ -n "$BASE_RUN" && -d "$BASE_RUN/dsh-bot.app" ]] && BASE_APP_COPY="$BASE_RUN/dsh-bot.app"
echo "INSTALLED_APP=${BASE_APP_COPY:-none}"
if [[ -z "$BASE_APP_COPY" ]]; then
  echo "FAIL base acceptance did not leave an installed app copy; cannot run B2 native checks on the same installed app"
  node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({schemaVersion:1,kind:"beta2-combined-acceptance",status:"FAIL",reason:"base acceptance did not leave an installed app copy",base:{run:process.argv[2]||null,exitCode:Number(process.argv[3]||1),durationS:Number(process.argv[4]||0)}},null,2)+"\n")' "$OUT/summary.json" "${BASE_RUN:-}" "$BASE_RC" "$BASE_DUR"
  exit 1
fi

NATIVE_DIR="$OUT/native"
mkdir -p "$NATIVE_DIR"
echo "STEP native-b2 start $(date -u +%Y-%m-%dT%H:%M:%SZ)"
NATIVE_START=$(date +%s)
NATIVE_RC=0
node product/tools/accept-native-beta2.mjs --app "$BASE_APP_COPY" --run "$NATIVE_DIR" --manifest "$MANIFEST" 2>&1 | tee "$OUT/native-beta2.log" || NATIVE_RC=$?
NATIVE_DUR=$(( $(date +%s) - NATIVE_START ))
echo "STEP native-b2 done exit=$NATIVE_RC duration=${NATIVE_DUR}s"

node - "$OUT" "$BASE_RC" "$BASE_DUR" "$NATIVE_RC" "$NATIVE_DUR" "${BASE_RUN:-}" <<'JS'
const fs = require('fs')
const path = require('path')
const [out, baseRc, baseDur, nativeRc, nativeDur, baseRun] = process.argv.slice(2)
const read = file => { try { return JSON.parse(fs.readFileSync(path.join(out, file), 'utf8')) } catch { return null } }
const base = read('base-phase-summary.json')
const native = read('native/B2-NATIVE-RESULTS.json')
const input = read('input-binding.json')
const basePass = Number(baseRc) === 0 && base?.status === 'PASS' && (base?.missing ?? []).length === 0
const nativeStatus = native?.overall?.status ?? 'NOT-RUN'
const nativeFail = nativeStatus === 'FAIL' || Number(nativeRc) === 1
const overall = basePass && !nativeFail ? (nativeStatus === 'PASS-WITH-BLOCKED-ENVIRONMENT' ? 'PASS-WITH-BLOCKED-ENVIRONMENT' : 'PASS') : 'FAIL'
const summary = {
  schemaVersion: 1,
  kind: 'beta2-combined-acceptance',
  generatedAt: new Date().toISOString(),
  dmg: input?.dmg, dmgSha256: input?.dmgSha256, manifestSourceCommit: input?.manifestSourceCommit,
  base: { exitCode: Number(baseRc), durationS: Number(baseDur), status: basePass ? 'PASS' : 'FAIL', run: baseRun || null, phases: base?.phases ?? null, fifteenChecksPresent: base?.fifteenChecksPresent ?? false },
  native: { exitCode: Number(nativeRc), durationS: Number(nativeDur), status: nativeStatus, results: 'native/B2-NATIVE-RESULTS.json', firstAttemptSuccess: native?.firstAttemptSuccess ?? null, failed: native?.overall?.failed ?? [], blocked: native?.overall?.blocked ?? [] },
  overall: { status: overall, scope: 'base 15-check acceptance + B2 native checks on the same installed app copy; real microphone/provider/audio and physical multi-display remain manual boundaries' },
}
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
const rows = [
  '# beta2 combined macOS acceptance', '',
  `- DMG: \`${summary.dmg}\``,
  `- DMG sha256: \`${summary.dmgSha256}\``,
  `- sourceCommit (build manifest): \`${summary.manifestSourceCommit}\``,
  `- base accept-macos.sh: **${summary.base.status}** (exit ${summary.base.exitCode}, ${summary.base.durationS}s, 15 phases present=${summary.base.fifteenChecksPresent})`,
  `- B2 native checks: **${summary.native.status}** (exit ${summary.native.exitCode}, ${summary.native.durationS}s, first-attempt-success=${summary.native.firstAttemptSuccess})`,
  `- overall: **${summary.overall.status}**`, '',
  '## B2 native checks', '',
  '| check | status | detail |', '|---|---|---|',
]
for (const [id, check] of Object.entries(native?.checks ?? {})) rows.push(`| ${id} | ${check.status} | ${String(check.detail ?? '').replace(/\|/g, '\\|').slice(0, 240)} |`)
if (summary.native.failed.length) rows.push('', `Failed: ${summary.native.failed.join(', ')}`)
if (summary.native.blocked.length) rows.push('', `Blocked-Environment: ${summary.native.blocked.join(', ')}`)
rows.push('', 'Base acceptance evidence:', `- \`${baseRun || 'not found'}\``, '', `Combined evidence: \`${out}\``)
fs.writeFileSync(path.join(out, 'summary.md'), rows.join('\n') + '\n')
console.log(JSON.stringify({ overall: overall, base: summary.base.status, native: summary.native.status, out }, null, 2))
process.exit(overall === 'FAIL' ? 1 : 0)
JS
COMBINED_RC=$?
# Post-run: never leave this run's packaged App alive for the next attempt.
python3 - "$ROOT" "$OUT/post-run-app-cleanup.txt" <<'PY_POST'
import os, signal, subprocess, sys, time
root, report = sys.argv[1], sys.argv[2]
marker = os.path.join(root, '.mvv-build')
def scan():
    out = subprocess.run(['ps', '-axo', 'pid=,command='], capture_output=True, text=True).stdout
    hits = []
    for line in out.splitlines():
        if 'dsh-bot.app/Contents/MacOS/dsh-bot' not in line or '/.mvv-build/acceptance-' not in line:
            continue
        try: hits.append((int(line.strip().split(None, 1)[0]), line.strip()[:300]))
        except ValueError: pass
    return hits
before = scan()
for pid, _ in before:
    try: os.kill(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError): pass
deadline = time.time() + 15
while time.time() < deadline and scan(): time.sleep(0.4)
left = scan()
for pid, _ in left:
    try: os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError): pass
open(report, 'w').write(f'stale_before={len(before)}\nremaining_after={len(scan())}\n')
PY_POST
echo "DONE accept-beta2-macos overall_exit=$COMBINED_RC out=$OUT $(date -u +%Y-%m-%dT%H:%M:%SZ)"
exit "$COMBINED_RC"
