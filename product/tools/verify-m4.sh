#!/usr/bin/env bash
# verify-m4.sh — one-command repeatable M4 verification (thin wrapper around verify-m4.mjs).
#
#   ./tools/verify-m4.sh              deterministic local suites + REAL approval allow/reject
#   ./tools/verify-m4.sh --no-model   deterministic suites only (approval E2E SKIP/UNVERIFIED)
#   ./tools/verify-m4.sh --full       also rerun the full 6-file M4 E2E/security suite
#
# Exit codes: 0 = all required steps PASS, 1 = any FAIL, 2 = preflight/usage error.
# Evidence: nisse/m4/evidence/VERIFY-M4.json (+ per-suite JSONs in the same dir).
# Isolation: approval E2E runs a real DSH host with DSH_HOME=/tmp/nisse-m4-approval-verify/dsh-home;
# ~/.dsh is only read (credentials copied read-only into the isolated DSH_HOME).
set -euo pipefail
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
NODE="${NODE:-node}"
exec "$NODE" "$HERE/verify-m4.mjs" "$@"
