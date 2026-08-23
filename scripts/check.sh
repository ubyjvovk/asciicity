#!/usr/bin/env bash
# Full gate: install → typecheck → unit → build → e2e (if e2e/ exists).
# Full output goes to a log; stdout gets one line per stage + the log path.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p .tigerteam/logs/tests
log=".tigerteam/logs/tests/check-$(date -u +%Y%m%d-%H%M%S)-$$.log"
run() { local name="$1"; shift; if "$@" >>"$log" 2>&1; then echo "$name: ok"; else echo "$name: FAIL (see $log)"; exit 1; fi; }
[ -d node_modules ] || run install npm ci --prefer-offline --no-audit --no-fund
run typecheck npx tsc --noEmit
run unit npx vitest run
run build npx vite build
if [ -d e2e ]; then run e2e npx playwright test; else echo "e2e: skipped (no e2e/)"; fi
echo "log: $log"
