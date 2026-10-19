#!/usr/bin/env bash
# One command over all five Phase 2 success criteria (ROADMAP.md). Runs every
# check, never stopping at the first failure, and prints one PASS or FAIL
# line per check so every result is visible in one pass. Exits non-zero if
# any line is FAIL. Modeled on scripts/phase1-acceptance.sh.
#
#   TAVILY_API_KEY=... NEBIUS_API_KEY=... GITHUB_TOKEN=... bash scripts/phase2-acceptance.sh
#
# This script does NOT read .env itself — load the three required
# credentials into the environment before invoking it (e.g.
# `set -a; source .env; set +a` in your own shell, never inside this file).
# Criterion 2 makes the first REAL invocation of `node src/pipeline/run.ts`
# this run; criterion 5 makes a second real invocation, over the same 10
# projects, to prove cache-backed resumability on real data. Without the
# three env vars set, run.ts exits 1 naming exactly which var is missing and
# this script reports that as a FAIL with the blocker clearly printed — it
# never guesses, fakes, or works around a missing credential.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAILED=0
LOG=$(mktemp "${TMPDIR:-/tmp}/prism-phase2-acceptance.XXXXXX")
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
# SC1: the 12-month Show HN frame — two-sided weekly Algolia windows,
# every window exhaustive, no author field anywhere in the stored frame
# ============================================================
run_check "SC1: frame.json exists, matches the frozen window, and carries no author field" env PRISM_DATA_DIR_RESOLVED="$DATA_DIR" node -e "
  const fs = require('node:fs');
  const path = require('node:path');
  const framePath = path.join(process.env.PRISM_DATA_DIR_RESOLVED, 'pipeline', 'frame.json');
  if (!fs.existsSync(framePath)) throw new Error('missing: ' + framePath + ' — run buildFrame() first');
  const frame = JSON.parse(fs.readFileSync(framePath, 'utf8'));
  if (frame.window.startEpoch !== 1756684800 || frame.window.endEpochExclusive !== 1788220800) {
    throw new Error('window mismatch: ' + JSON.stringify(frame.window));
  }
  if (!Array.isArray(frame.posts) || frame.posts.length === 0) throw new Error('frame has no posts');
  for (const post of frame.posts) {
    if (Object.prototype.hasOwnProperty.call(post, 'author')) throw new Error('author field found on stored post ' + post.id);
  }
  console.log('windows', frame.windowCount, 'posts', frame.posts.length);
"

run_check "SC1: 10-project slice exists with exactly 10 entries (5 reused + 5 drawn)" env PRISM_DATA_DIR_RESOLVED="$DATA_DIR" node -e "
  const fs = require('node:fs');
  const path = require('node:path');
  const p = path.join(process.env.PRISM_DATA_DIR_RESOLVED, 'pipeline', 'slice-projects.json');
  if (!fs.existsSync(p)) throw new Error('missing: ' + p + ' — run selectSliceProjects() first');
  const entries = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (entries.length !== 10) throw new Error('expected 10 entries, got ' + entries.length);
  const reused = entries.filter((e) => e.source === 'phase1-spike').length;
  const drawn = entries.filter((e) => e.source === 'phase2-drawn').length;
  if (reused !== 5 || drawn !== 5) throw new Error('expected 5 reused + 5 drawn, got ' + reused + ' + ' + drawn);
  console.log('slice ok:', reused, '+', drawn);
"

run_check "SC1: boundary/robots fixtures (own-domain subdomain, github.com adjacency, malformed-URL fail-closed, robots-disallowed rejection)" \
  node --test tests/pipeline/boundary.test.mjs

# ============================================================
# SC2: own-source evidence only — boundary, robots, no contributor data,
# Tavily credits under the per-project cap, resumability. This is the
# FIRST real invocation of the live pipeline in this acceptance run.
# ============================================================
RUN1_LOG=$(mktemp "${TMPDIR:-/tmp}/prism-phase2-run1.XXXXXX")
RUN1_STATUS=0
node src/pipeline/run.ts >"$RUN1_LOG" 2>&1 || RUN1_STATUS=$?
if [[ $RUN1_STATUS -eq 0 ]]; then
  record PASS "SC2: real pipeline run over all 10 projects (node src/pipeline/run.ts) exits 0"
else
  record FAIL "SC2: real pipeline run over all 10 projects (node src/pipeline/run.ts) exits 0"
  sed 's/^/    /' "$RUN1_LOG" >&2
fi

run_check "SC2: GitHub repo evidence carries no contributor/commit-author fields (recursive key scan)" \
  node --test tests/pipeline/github.test.mjs

run_check "SC2: every project has a recorded result, and no recorded snapshot URL falls outside its project's boundary" env PRISM_DATA_DIR_RESOLVED="$DATA_DIR" node -e "
  const fs = require('node:fs');
  const path = require('node:path');
  const Database = require('better-sqlite3');
  const { deriveBoundary, withinBoundary } = require('./src/pipeline/evidence/boundary.ts');
  const dataDir = process.env.PRISM_DATA_DIR_RESOLVED;

  const db = new Database(path.join(dataDir, 'prism.sqlite'), { readonly: true });
  const rows = db.prepare('select project_n from pipeline_project_results').all();
  if (rows.length !== 10) throw new Error('expected 10 recorded projects, got ' + rows.length + ' (' + rows.map((r) => r.project_n).join(',') + ')');

  const sliceEntries = JSON.parse(fs.readFileSync(path.join(dataDir, 'pipeline', 'slice-projects.json'), 'utf8'));
  const byN = new Map(sliceEntries.map((e) => [e.n, e]));
  const manifestDir = path.join(dataDir, 'pipeline', 'manifests');
  let checkedSnapshots = 0;
  for (const row of rows) {
    const entry = byN.get(row.project_n);
    if (!entry) throw new Error('project_n ' + row.project_n + ' has no matching slice entry');
    const boundary = deriveBoundary(entry.final_url);
    const manifestPath = path.join(manifestDir, row.project_n + '.json');
    if (!fs.existsSync(manifestPath)) throw new Error('missing manifest sidecar for project ' + row.project_n);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const snap of manifest.snapshots) {
      checkedSnapshots += 1;
      const extra = [manifest.homepageBoundary, ...(manifest.repoBoundaries ?? [])].filter(Boolean);
      if (!withinBoundary(snap.url, boundary) && !extra.some((b) => withinBoundary(snap.url, b))) {
        throw new Error('project ' + row.project_n + ': snapshot URL ' + snap.url + ' falls OUTSIDE its own boundary');
      }
    }
  }
  console.log('projects', rows.length, 'snapshots checked', checkedSnapshots);
"

run_check "SC2: total Tavily credits spent across the run stays under the per-project ceiling x 10 projects" env RUN1_LOG_PATH="$RUN1_LOG" node -e "
  const fs = require('node:fs');
  const path = require('node:path');
  const runLog = fs.readFileSync(process.env.RUN1_LOG_PATH, 'utf8');
  const line = runLog.split('\n').find((l) => l.startsWith('ACCOUNTING:'));
  if (!line) throw new Error('no ACCOUNTING line found in the real run\'s output');
  const accounting = JSON.parse(line.slice('ACCOUNTING:'.length).trim());
  const CEILING_PER_PROJECT = 40; // D-16
  const ceiling = CEILING_PER_PROJECT * 10;
  if (accounting.approxTavilyCreditsSpent > ceiling) {
    throw new Error('approxTavilyCreditsSpent ' + accounting.approxTavilyCreditsSpent + ' exceeds the ceiling of ' + ceiling);
  }
  console.log('approxTavilyCreditsSpent', accounting.approxTavilyCreditsSpent, 'of', ceiling);
"

# ============================================================
# SC3: content-addressed snapshots, redaction before persistence,
# per-snapshot redaction counts, provider-extracted visibility
# ============================================================
run_check "SC3: redaction unit coverage (email/phone/handle, fenced-code and npm-scope exclusions, EVD-07)" \
  node --test tests/pipeline/redact.test.mjs

run_check "SC3: spot-check 2 stored snapshots — recompute sha256 over the stored redacted text and compare" env PRISM_DATA_DIR_RESOLVED="$DATA_DIR" node -e "
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const snapshotsDir = path.join(process.env.PRISM_DATA_DIR_RESOLVED, 'pipeline', 'snapshots');
  const files = fs.readdirSync(snapshotsDir).filter((f) => f.endsWith('.json'));
  if (files.length < 2) throw new Error('expected at least 2 stored snapshots, found ' + files.length);
  const sample = files.slice(0, 2);
  for (const file of sample) {
    const snap = JSON.parse(fs.readFileSync(path.join(snapshotsDir, file), 'utf8'));
    const recomputed = crypto.createHash('sha256').update(snap.redactedText, 'utf8').digest('hex');
    if (recomputed !== snap.snapshotHash) throw new Error(file + ': recomputed hash does not match the stored snapshotHash');
    if (snap.visibility !== 'provider-extracted') throw new Error(file + ': visibility is not provider-extracted');
    if (!snap.redactionCounts) throw new Error(file + ': no redactionCounts recorded');
  }
  console.log('spot-checked', sample.join(', '));
"

run_check "SC3: every stored snapshot has a non-null redaction-counts record and provider-extracted visibility" env PRISM_DATA_DIR_RESOLVED="$DATA_DIR" node -e "
  const fs = require('node:fs');
  const path = require('node:path');
  const dataDir = process.env.PRISM_DATA_DIR_RESOLVED;
  const manifestDir = path.join(dataDir, 'pipeline', 'manifests');
  const files = fs.readdirSync(manifestDir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) throw new Error('no manifest sidecars found');
  let total = 0;
  for (const file of files) {
    const manifest = JSON.parse(fs.readFileSync(path.join(manifestDir, file), 'utf8'));
    for (const snap of manifest.snapshots) {
      total += 1;
      if (snap.visibility !== 'provider-extracted') throw new Error(file + ': a snapshot is missing provider-extracted visibility');
      if (snap.redactionCounts == null) throw new Error(file + ': a snapshot has no redactionCounts');
    }
  }
  console.log('manifests', files.length, 'snapshots', total);
"

# ============================================================
# SC4: the {checkId, proposedState, spanIds} contract; the quote-or-unknown
# downgrade rule holds against the real recorded store, not just the unit test
# ============================================================
run_check "SC4: contract + quote-or-unknown filter unit coverage (COD-01, COD-02)" \
  node --test tests/pipeline/filter.test.mjs tests/pipeline/coding.test.mjs

run_check "SC4: every recorded check state is pass/fail/unknown/claimed, and no pass/claimed/fail has an empty span_ids_json" env PRISM_DATA_DIR_RESOLVED="$DATA_DIR" node -e "
  const path = require('node:path');
  const Database = require('better-sqlite3');
  const dataDir = process.env.PRISM_DATA_DIR_RESOLVED;
  const db = new Database(path.join(dataDir, 'prism.sqlite'), { readonly: true });
  const rows = db.prepare('select project_n, check_id, filtered_state, span_ids_json from pipeline_check_states').all();
  if (rows.length === 0) throw new Error('no recorded check states');
  const VALID = new Set(['pass', 'fail', 'unknown', 'claimed']);
  const QUOTE_REQUIRED = new Set(['pass', 'claimed', 'fail']);
  for (const row of rows) {
    if (!VALID.has(row.filtered_state)) throw new Error('project ' + row.project_n + ' check ' + row.check_id + ': invalid filtered_state ' + row.filtered_state);
    if (QUOTE_REQUIRED.has(row.filtered_state)) {
      const spanIds = JSON.parse(row.span_ids_json);
      if (!Array.isArray(spanIds) || spanIds.length === 0) {
        throw new Error('project ' + row.project_n + ' check ' + row.check_id + ': state ' + row.filtered_state + ' has an empty span_ids_json — the quote-or-unknown rule was violated');
      }
    }
  }
  console.log('check-state rows', rows.length);
"

# ============================================================
# SC5: 5 claim.json records per project, gated; projection-invariant and
# Node/Python conformance tests; kill-and-rerun resumability on REAL data;
# every result carries a manifest; the per-check tally prints
# ============================================================
run_check "SC5: projection-invariant + Node-vs-Python conformance + gate tests (npm run test:gate)" \
  npm run test:gate

RUN2_LOG=$(mktemp "${TMPDIR:-/tmp}/prism-phase2-run2.XXXXXX")
RUN2_STATUS=0
node src/pipeline/run.ts >"$RUN2_LOG" 2>&1 || RUN2_STATUS=$?
if [[ $RUN2_STATUS -eq 0 ]]; then
  record PASS "SC5: a second real run over the same 10 projects exits 0 (resumability on real data)"
else
  record FAIL "SC5: a second real run over the same 10 projects exits 0 (resumability on real data)"
  sed 's/^/    /' "$RUN2_LOG" >&2
fi

run_check "SC5: the second real run's new Tavily/Nebius/GitHub calls are at most a small fixed overhead above zero" env RUN2_LOG_PATH="$RUN2_LOG" node -e "
  const fs = require('node:fs');
  const line = fs.readFileSync(process.env.RUN2_LOG_PATH, 'utf8').split('\n').find((l) => l.startsWith('ACCOUNTING:'));
  if (!line) throw new Error('no ACCOUNTING line found in the second run\'s output');
  const a = JSON.parse(line.slice('ACCOUNTING:'.length).trim());
  // A small fixed overhead: at most 1 project may legitimately recompute
  // (e.g. one that failed on the first run and is retried here).
  const OVERHEAD_CEILING = 1;
  if (a.evidenceComputed > OVERHEAD_CEILING || a.codeComputed > OVERHEAD_CEILING) {
    throw new Error('second run recomputed evidence for ' + a.evidenceComputed + ' and code for ' + a.codeComputed + ' projects — expected at most ' + OVERHEAD_CEILING + ' of each (cache-backed resumability)');
  }
  console.log('evidenceComputed', a.evidenceComputed, 'codeComputed', a.codeComputed, '(of', a.ranProjects, 'projects)');
"

run_check "SC5: every recorded project carries a non-null manifest (model id, prompt hash, codebook version, gate SHA, snapshot hashes)" env PRISM_DATA_DIR_RESOLVED="$DATA_DIR" node -e "
  const path = require('node:path');
  const Database = require('better-sqlite3');
  const dataDir = process.env.PRISM_DATA_DIR_RESOLVED;
  const db = new Database(path.join(dataDir, 'prism.sqlite'), { readonly: true });
  const rows = db.prepare('select * from pipeline_project_results').all();
  if (rows.length === 0) throw new Error('no recorded projects');
  for (const row of rows) {
    for (const field of ['model_id', 'prompt_hash', 'codebook_version', 'gate_sha', 'snapshot_hashes_json']) {
      if (row[field] === null || row[field] === undefined || row[field] === '') {
        throw new Error('project ' + row.project_n + ': manifest field ' + field + ' is missing');
      }
    }
    const hashes = JSON.parse(row.snapshot_hashes_json);
    if (!Array.isArray(hashes)) throw new Error('project ' + row.project_n + ': snapshot_hashes_json is not an array');
  }
  console.log('manifests ok for', rows.length, 'projects');
"

run_check "SC5: the per-check tally prints a non-empty line for every one of the 24 checks" bash -c "
  OUT=\$(node src/pipeline/tally.ts)
  LINES=\$(echo \"\$OUT\" | grep -c ': pass ')
  if [[ \"\$LINES\" -lt 24 ]]; then
    echo \"\$OUT\"
    echo \"only \$LINES tally lines printed, expected at least 24\" >&2
    exit 1
  fi
  echo \"tally lines: \$LINES\"
"

echo
echo "--- real pipeline run logs kept for inspection ---"
echo "first run:  $RUN1_LOG"
echo "second run: $RUN2_LOG"
trap - EXIT
rm -f "$LOG"

echo
if [[ "$FAILED" -eq 0 ]]; then
  echo "phase2-acceptance: ALL CHECKS PASSED"
else
  echo "phase2-acceptance: AT LEAST ONE CHECK FAILED" >&2
fi
exit "$FAILED"
