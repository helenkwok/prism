#!/usr/bin/env bash
# Offline acceptance: private full output, eleven evidence-based summary lines.
set -uo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${HOME}/.asdf/installs/nodejs/24.22.1/bin/node"
export PATH="$(dirname "$NODE"):$PATH"
cd "$ROOT"

DATA_DIR="$("$NODE" --input-type=module -e 'import {resolveDataDir} from "./src/app/server/db.ts";console.log(resolveDataDir())')"
if [[ -z "$DATA_DIR" ]]; then
  for i in {1..11}; do echo "FAIL C$i"; done
  exit 1
fi
mkdir -p "$DATA_DIR/validation"
STAMP="$("$NODE" -p 'new Date().toISOString().replace(/[:.]/g,"-")')"
LOG="$DATA_DIR/validation/phase4-acceptance-${STAMP}-$$.log"
: > "$LOG"
chmod 600 "$LOG"

"$NODE" src/pipeline/validate/phase4-acceptance.ts "$@" > "$LOG" 2>&1

PASSED=0
FAILED=0
for i in {1..11}; do
  if grep -q "^FAIL C${i}$" "$LOG"; then
    echo "FAIL C$i"
    FAILED=$((FAILED + 1))
  elif grep -q "^PASS C${i}$" "$LOG"; then
    echo "PASS C$i"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL C$i"
    FAILED=$((FAILED + 1))
  fi
done
if [[ "$PASSED" -eq 11 && "$FAILED" -eq 0 ]] && grep -q '^ACCEPTANCE-OK$' "$LOG"; then
  exit 0
fi
exit 1
