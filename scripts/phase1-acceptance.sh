#!/usr/bin/env bash
# One command over all five Phase 1 success criteria (ROADMAP.md). Runs every
# check, never stopping at the first failure, and prints one PASS or FAIL
# line per check so every result is visible in one pass. Exits non-zero if
# any line is FAIL.
#
#   bash scripts/phase1-acceptance.sh
#
# The repository visibility flip is a one-way door pre-authorised by Helen in
# plan 01-09 (recorded decision: "public-now" - the repository was made
# public at first push, not left private for a later flip). This script
# never flips visibility on its own authority: if the repository is ever
# found private here, it reports a FAIL and a blocker rather than guessing
# at consent. The only way to authorise a flip through this script is the
# explicit PRISM_VISIBILITY_FLIP_AUTHORIZED=true environment variable, set
# by a human who has re-read plan 01-09's decision and confirmed the
# private-then-flip path, never by this script itself.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAILED=0
LOG=$(mktemp "${TMPDIR:-/tmp}/prism-phase1-acceptance.XXXXXX.log")
trap 'rm -f "$LOG"' EXIT

record() {
  local status="$1" name="$2"
  echo "${status} ${name}"
  if [[ "$status" != "PASS" ]]; then
    FAILED=1
  fi
}

# Runs a command; records PASS on exit 0, FAIL otherwise, with the command's
# output indented on stderr when it fails.
run_check() {
  local name="$1"
  shift
  : >"$LOG"
  if "$@" >"$LOG" 2>&1; then
    record PASS "$name"
  else
    record FAIL "$name"
    sed 's/^/    /' "$LOG" >&2
  fi
}

# Same, but PASS means the command exited non-zero.
run_check_expect_nonzero() {
  local name="$1"
  shift
  : >"$LOG"
  if "$@" >"$LOG" 2>&1; then
    record FAIL "$name"
    sed 's/^/    /' "$LOG" >&2
  else
    record PASS "$name"
  fi
}

# ============================================================
# Repository identity (from the actual remote, never hard-coded)
# ============================================================
ORIGIN_URL=$(git remote get-url origin 2>/dev/null || echo "")
REPO=""
if [[ -n "$ORIGIN_URL" ]]; then
  REPO=$(node -e "
    const m = process.argv[1].match(/github\.com[:/]+([^/]+)\/([^/.]+?)(\.git)?\$/);
    if (!m) process.exit(2);
    process.stdout.write(m[1] + '/' + m[2]);
  " "$ORIGIN_URL" 2>/dev/null || echo "")
fi
if [[ -z "$REPO" ]]; then
  record FAIL "repository identity resolves from git remote get-url origin"
else
  record PASS "repository identity resolves from git remote get-url origin (${REPO})"
fi

# ============================================================
# SC1: licensed repo, merged/tagged upstream, hash-pinned vendored gate
# ============================================================
run_check "SC1: vendored gate matches its pin (offline)" \
  node scripts/verify-vendor.mjs
run_check "SC1: vendored gate matches upstream at the pinned commit (remote)" \
  node scripts/verify-vendor.mjs --remote
run_check "SC1: vendor-pin tamper tests" \
  node --test tests/vendor-pin.test.mjs
run_check "SC1: gate tests through the pinned jsonschema" \
  npm run test:gate

run_check "SC1: upstream tag is recorded in PIN.json and the vendored LICENSE is present" node -e "
  const fs = require('node:fs');
  const pin = JSON.parse(fs.readFileSync('vendor/ai-output-to-value/PIN.json', 'utf8'));
  if (!pin.tag) throw new Error('PIN.json has no tag');
  if (!fs.existsSync('vendor/ai-output-to-value/LICENSE')) throw new Error('vendored LICENSE is missing');
  console.log('tag', pin.tag);
"

if [[ -n "$REPO" ]]; then
  run_check "SC1: GitHub licence detection prints Apache-2.0 for ${REPO}" bash -c "
    spdx=\$(gh api 'repos/${REPO}' --jq '.license.spdx_id' 2>/dev/null)
    echo \"detected: \${spdx}\"
    [[ \"\$spdx\" == 'Apache-2.0' ]]
  "
else
  record FAIL "SC1: GitHub licence detection prints Apache-2.0 (no repository resolved)"
fi

# ============================================================
# SC2: PRISM_DATA_DIR containment; reference-document hook
# ============================================================
run_check_expect_nonzero "SC2: PRISM_DATA_DIR set inside the repo makes check-data-dir.mjs exit non-zero" \
  env PRISM_DATA_DIR="${ROOT}/data" node scripts/check-data-dir.mjs
run_check "SC2: data-dir and forbidden-path unit tests (the hook blocks a staged reference document)" \
  node --test tests/data-dir.test.mjs tests/forbidden-paths.test.mjs

# ============================================================
# SC3: dated, tagged, pre-registered protocol
# ============================================================
run_check "SC3: protocol tests in final mode" \
  env PROTOCOL_FINAL=1 node --test tests/protocol.test.mjs
run_check "SC3: protocol-v1 tag exists and is respected" \
  node scripts/check-protocol-order.mjs --require-tag
run_check "SC3: disclosure-audit tests" \
  node --test tests/disclosure-audit.test.mjs

# ============================================================
# SC4: spike records exist, readable, final
# ============================================================
run_check "SC4: every spike record is present and final" \
  node scripts/check-spike-records.mjs --require-final

# ============================================================
# SC5: the Docker image serves sign-in and a takumi PDF, proven in CI
# ============================================================
run_check "SC5: local build-and-serve smoke (npm run smoke)" \
  npm run smoke

HEAD_SHA=$(git rev-parse HEAD)
if [[ -n "$REPO" ]]; then
  : >"$LOG"
  if RUN_ID=$(gh run list --repo "$REPO" --commit "$HEAD_SHA" --json databaseId,status,conclusion \
      --jq '[.[] | select(.status == "completed")] | sort_by(.databaseId) | last | .databaseId' 2>"$LOG") \
      && [[ -n "$RUN_ID" && "$RUN_ID" != "null" ]]; then
    CONCLUSION=$(gh run view "$RUN_ID" --repo "$REPO" --json conclusion --jq '.conclusion' 2>>"$LOG")
    DOCKER_CONCLUSION=$(gh run view "$RUN_ID" --repo "$REPO" --json jobs --jq '.jobs[] | select(.name == "docker-smoke") | .conclusion' 2>>"$LOG")
    if [[ "$CONCLUSION" == "success" && "$DOCKER_CONCLUSION" == "success" ]]; then
      record PASS "SC5: the latest CI run for HEAD (${HEAD_SHA:0:12}) concluded success, including docker-smoke (run ${RUN_ID})"
    else
      record FAIL "SC5: the latest CI run for HEAD (${HEAD_SHA:0:12}) is not fully green (run ${RUN_ID}, conclusion=${CONCLUSION}, docker-smoke=${DOCKER_CONCLUSION})"
    fi
  else
    record FAIL "SC5: no completed CI run found for HEAD (${HEAD_SHA:0:12}); push this commit first"
    sed 's/^/    /' "$LOG" >&2
  fi
else
  record FAIL "SC5: the latest CI run for HEAD concluded success (no repository resolved)"
fi

# ============================================================
# Whole-repo guards
# ============================================================
run_check "npm test (full suite)" npm test
run_check "forbidden-paths guard (every tracked file)" \
  node scripts/check-forbidden-paths.mjs --tracked
run_check "name guard (files, commit history, tags)" \
  node scripts/check-agent-names.mjs

# ============================================================
# Repository visibility (FND-01): public only, one-way flip only if
# pre-authorised out of band (see header comment)
# ============================================================
if [[ -n "$REPO" ]]; then
  VISIBILITY=$(gh repo view "$REPO" --json visibility --jq '.visibility' 2>/dev/null || echo "")
  if [[ "$VISIBILITY" == "PUBLIC" ]]; then
    record PASS "repository visibility is public"
  elif [[ "${PRISM_VISIBILITY_FLIP_AUTHORIZED:-}" == "true" && "$FAILED" -eq 0 ]]; then
    echo "[phase1-acceptance] flipping visibility to public (PRISM_VISIBILITY_FLIP_AUTHORIZED=true, every other check passed)" >&2
    gh repo edit "$REPO" --visibility public --accept-visibility-change-consequences >/dev/null
    VISIBILITY=$(gh repo view "$REPO" --json visibility --jq '.visibility' 2>/dev/null || echo "")
    if [[ "$VISIBILITY" == "PUBLIC" ]]; then
      record PASS "repository visibility is public (flipped this run, pre-authorised)"
      run_check "SC1: GitHub licence detection prints Apache-2.0 for ${REPO} (post-flip)" bash -c "
        spdx=\$(gh api 'repos/${REPO}' --jq '.license.spdx_id' 2>/dev/null)
        echo \"detected: \${spdx}\"
        [[ \"\$spdx\" == 'Apache-2.0' ]]
      "
    else
      record FAIL "repository visibility is public"
    fi
  else
    record FAIL "repository visibility is public (repository is ${VISIBILITY:-unknown}; not flipped - no PRISM_VISIBILITY_FLIP_AUTHORIZED=true, or an earlier check failed)"
  fi
else
  record FAIL "repository visibility is public (no repository resolved)"
fi

echo
if [[ "$FAILED" -eq 0 ]]; then
  echo "phase1-acceptance: ALL CHECKS PASSED"
else
  echo "phase1-acceptance: AT LEAST ONE CHECK FAILED" >&2
fi
exit "$FAILED"
