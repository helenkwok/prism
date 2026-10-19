#!/usr/bin/env bash
# One command over Phase 3's success criterion 5 (ROADMAP.md): the 20-project
# pilot, its floor-effect review, and codebook v1.0's completeness. Runs every
# check, never stopping at the first failure, and prints one PASS or FAIL
# line per check so every result is visible in one pass. Modeled on
# scripts/phase2-acceptance.sh.
#
#   bash scripts/phase3-acceptance.sh   (keys: env vars, else ~/Library/Application Support/prism/{tavily,nebius}.key; GitHub: gh auth token)
#
# This script never reads .env. run.ts loads the Tavily and Nebius keys from
# the environment or from those mode-600 key files, and the GitHub token from
# the environment or `gh auth token`, so an agent can run it end to end.
# Criterion 3 makes the one REAL, live-credentialed invocation of
# `node src/pipeline/run.ts` this run (over the pilot-drawn 20 projects, via
# --slice, never touching Phase 2's 10-project slice file). Without the three
# env vars set, run.ts exits 1 naming exactly which var is missing and this
# script reports that as a FAIL with the blocker clearly printed — it never
# guesses, fakes, or works around a missing credential.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAILED=0
LOG=$(mktemp "${TMPDIR:-/tmp}/prism-phase3-acceptance.XXXXXX")
trap 'rm -f "$LOG"' EXIT

record() {
  local status="$1" name="$2"
  echo "${status} ${name}"
  if [[ "$status" != "PASS" ]]; then
    FAILED=1
  fi
}

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

DATA_DIR="${PRISM_DATA_DIR:-$HOME/.prism-data}"

# ============================================================
# Criterion 1: codebook v1.0 is complete and lint-clean — every one of the
# 24 checks has an operational definition with no leftover draft marker
# (CDB-01..04, CDB-05 freeze precondition).
# ============================================================
run_check "C1a: codebook.md is lint-clean against the 24-check contract (CDB-01..04)" \
  node scripts/check-codebook-lint.mjs

run_check "C1b: none of the 24 checks' operationalDefinition still carries a DRAFT PLACEHOLDER marker" node -e "
  const fs = require('node:fs');
  const path = require('node:path');
  const { extractJsonBlock } = require('./scripts/lib/spike-record.mjs');
  const { loadCheckIds } = require('./scripts/lib/codebook-lint.mjs');
  const md = fs.readFileSync('codebook.md', 'utf8');
  const obj = extractJsonBlock(md);
  const gatesPath = path.join(process.cwd(), 'vendor', 'ai-output-to-value', 'schemas', 'v1', 'decision-gates.json');
  const checkIds = loadCheckIds(gatesPath);
  const draftIds = checkIds.filter((id) => (obj.checks[id] && obj.checks[id].operationalDefinition || '').startsWith('DRAFT PLACEHOLDER'));
  if (draftIds.length > 0) throw new Error('checks still carrying a DRAFT PLACEHOLDER operationalDefinition: ' + draftIds.join(', '));
  console.log('all', checkIds.length, 'checks have real operationalDefinition content');
"

# ============================================================
# Criterion 2: the screened pool and the 20-project pilot draw (D-42) exist
# under PRISM_DATA_DIR/pipeline/pilot-projects.json. This check WRITES that
# file itself: src/pipeline/select/draw-pilot.ts walks the real frame.json
# (DSC-01) in seeded draw order and screens each candidate in two stages (A5,
# Nemotron-3.5-Lightning, Nebius key from the key file), with a plain HTTPS
# preflight of its own page and a headless render when that page is thin. No
# Tavily or GitHub credential is needed. Screening calls are cached.
# ============================================================
run_check "C2: screened seeded draw (DSC-02, A5, D-42): 20 pilot projects, one outcome per walked record, written to pilot-projects.json" env PRISM_DATA_DIR_RESOLVED="$DATA_DIR" node -e "
  const fs = require('node:fs');
  const path = require('node:path');
  const dataDir = process.env.PRISM_DATA_DIR_RESOLVED;
  if (!fs.existsSync(path.join(dataDir, 'pipeline', 'frame.json'))) throw new Error('missing frame.json: run buildFrame() first (Phase 2)');
  const { drawPilot } = require('./src/pipeline/select/draw-pilot.ts');
  (async () => {
    const r = await drawPilot({ targetN: 20 });
    if (r.entries.length !== 20) throw new Error('expected 20 included pilot projects, got ' + r.entries.length + ': the frame is exhausted');
    if (new Set(r.log.map((l) => l.id)).size !== r.log.length) throw new Error('a walked record has more than one outcome');
    if (r.counts.screened !== r.log.length) throw new Error('PRISMA screened count does not cover every walked record');
    console.log('PRISMA', JSON.stringify(r.counts));
  })().catch((err) => { console.error(err.message); process.exitCode = 1; });
"

# ============================================================
# Criterion 3: the one real, live-credentialed invocation of the pipeline —
# over the pilot-drawn 20 projects, via --slice, never touching Phase 2's
# 10-project slice-projects.json.
# ============================================================
PILOT_PATH="$DATA_DIR/pipeline/pilot-projects.json"
RUN_LOG=$(mktemp "${TMPDIR:-/tmp}/prism-phase3-run.XXXXXX")
RUN_STATUS=0
node src/pipeline/run.ts --slice "$PILOT_PATH" >"$RUN_LOG" 2>&1 || RUN_STATUS=$?
# The evidence is the run's own ACCOUNTING line (every project succeeded), not
# its exit status: a run whose every project failed once exited 0.
C3_LABEL="C3: real pipeline run over the 20-project pilot (node src/pipeline/run.ts --slice pilot-projects.json): all 20 projects succeeded"
if node -e '
  const line = require("fs").readFileSync(process.argv[1], "utf8").split("\n").find((l) => l.startsWith("ACCOUNTING: "));
  if (!line) process.exit(1);
  const a = JSON.parse(line.slice("ACCOUNTING: ".length));
  process.exit(a.ranProjects === 20 && a.succeeded === 20 && a.failed === 0 ? 0 : 1);
' "$RUN_LOG"; then
  record PASS "$C3_LABEL"
else
  record FAIL "$C3_LABEL (run.ts exit status $RUN_STATUS)"
  grep -E "FAILED|ACCOUNTING" "$RUN_LOG" | sed 's/^/    /' >&2
fi

# ============================================================
# Criterion 4: the floor-effect report (D-43/D-44) runs over the real,
# just-recorded pilot results and prints exactly one line per check.
# ============================================================
run_check "C4: the floor-effect report prints one line per one of the 24 checks" bash -c "
  OUT=\$(PRISM_DATA_DIR='$DATA_DIR' node scripts/phase3-floor-effect-report.mjs)
  LINES=\$(echo \"\$OUT\" | grep -c 'passPlusClaimed=')
  if [[ \"\$LINES\" -ne 24 ]]; then
    echo \"\$OUT\"
    echo \"expected 24 floor-effect report lines, got \$LINES\" >&2
    exit 1
  fi
  echo \"\$OUT\"
  echo \"floor-effect report lines: \$LINES\"
"

# ============================================================
# Criterion 5: somewhere for 03-10's human confirmation-timing sample to
# land — pipeline_confirmation_log exists as a table in the private sqlite
# (D-45; the table is created idempotently by ensurePipelineSchema, which
# criterion 3's real run above already triggered).
# ============================================================
run_check "C5: pipeline_confirmation_log exists as a table in the private sqlite (D-45)" env PRISM_DATA_DIR_RESOLVED="$DATA_DIR" node -e "
  const path = require('node:path');
  const Database = require('better-sqlite3');
  const dataDir = process.env.PRISM_DATA_DIR_RESOLVED;
  const db = new Database(path.join(dataDir, 'prism.sqlite'), { readonly: true });
  const row = db.prepare(\"select name from sqlite_master where type = 'table' and name = 'pipeline_confirmation_log'\").get();
  if (!row) throw new Error('pipeline_confirmation_log table does not exist in prism.sqlite — run criterion 3 first');
  console.log('pipeline_confirmation_log table exists');
"

echo
echo "--- real pipeline run log kept for inspection ---"
echo "pilot run: $RUN_LOG"
trap - EXIT
rm -f "$LOG"

echo
if [[ "$FAILED" -eq 0 ]]; then
  echo "phase3-acceptance: ALL CHECKS PASSED"
else
  echo "phase3-acceptance: AT LEAST ONE CHECK FAILED" >&2
fi
exit "$FAILED"
