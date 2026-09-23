// Text-level assertions on .github/workflows/ci.yml. No YAML dependency: the file is
// read as lines, which is enough to pin the properties that matter for supply chain
// and for the guards being present.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(root, ".github", "workflows", "ci.yml");
const text = fs.readFileSync(workflowPath, "utf8");
const lines = text.split(/\r?\n/);
const codeLines = lines.filter((l) => !/^\s*#/.test(l));

test("every action is pinned to a full 40-hex commit id", () => {
  const uses = codeLines.filter((l) => /^\s*-?\s*uses:/.test(l));
  assert.ok(uses.length >= 3, "expected the workflow to use at least checkout, setup-node and setup-python");
  for (const line of uses) {
    assert.match(line, /uses:\s*[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}(\s+#.*)?$/, `not pinned: ${line.trim()}`);
  }
});

test("each pinned action carries a version comment", () => {
  for (const line of codeLines.filter((l) => /^\s*-?\s*uses:/.test(l))) {
    assert.match(line, /#\s*v\d+\.\d+\.\d+\s*$/, `no version comment: ${line.trim()}`);
  }
});

test("token is read-only at the top level and nothing widens it", () => {
  assert.match(text, /^permissions:\s*\n\s+contents:\s*read\s*$/m);
  const scopes = codeLines.filter((l) => /^\s*(contents|packages|id-token|actions|pull-requests|issues|checks|deployments|statuses|security-events):\s*(write|admin)\b/.test(l));
  assert.deepEqual(scopes, []);
  assert.doesNotMatch(text, /permissions:\s*write-all/);
});

test("triggers are push to main and pull_request, never pull_request_target", () => {
  assert.doesNotMatch(text, /pull_request_target/);
  assert.match(text, /^on:\s*\n\s+push:\s*\n\s+branches:\s*\[main\]\s*\n\s+pull_request:/m);
});

test("checkout keeps no credentials and the history-scanning jobs fetch everything", () => {
  const checkouts = (text.match(/actions\/checkout@/g) ?? []).length;
  assert.equal((text.match(/persist-credentials:\s*false/g) ?? []).length, checkouts);
  assert.match(text, /fetch-depth:\s*0/);
  assert.match(text, /fetch-tags:\s*true/);
});

test("the guard steps are present", () => {
  for (const needle of [
    "node scripts/check-forbidden-paths.mjs --tracked",
    "node scripts/check-agent-names.mjs",
    "node scripts/check-protocol-order.mjs",
    "node scripts/check-spike-records.mjs",
    "node scripts/verify-vendor.mjs",
  ]) {
    assert.ok(text.includes(needle), `missing step: ${needle}`);
  }
});

test("the test job installs with npm ci (scripts enabled) and runs npm test", () => {
  assert.match(text, /run:\s*npm ci\s*$/m);
  assert.doesNotMatch(text, /--ignore-scripts/);
  assert.match(text, /run:\s*npm test\s*$/m);
});

test("the gate job installs the pinned requirements and runs the gate tests", () => {
  assert.ok(text.includes("vendor/ai-output-to-value/requirements-claim-gate.txt"));
  assert.match(text, /run:\s*npm run test:gate\s*$/m);
});

test("every required job is present", () => {
  for (const job of ["guards", "test", "gate", "vendor-remote", "protocol-order", "spike-records", "docker-smoke"]) {
    assert.ok(codeLines.includes(`  ${job}:`), `missing job: ${job}`);
  }
});

test("vendor-remote runs both the offline and remote vendor checks", () => {
  assert.match(text, /run:\s*node scripts\/verify-vendor\.mjs\s*$/m);
  assert.match(text, /run:\s*node scripts\/verify-vendor\.mjs --remote\s*$/m);
});

test("protocol-order requires the tag and runs the protocol tests in final mode", () => {
  assert.match(text, /run:\s*node scripts\/check-protocol-order\.mjs --require-tag\s*$/m);
  assert.match(text, /run:\s*PROTOCOL_FINAL=1 node --test tests\/protocol\.test\.mjs\s*$/m);
});

test("protocol-order installs dependencies before running node tests (tests/protocol.test.mjs imports highs)", () => {
  const jobStart = text.indexOf("\n  protocol-order:");
  const jobEnd = text.indexOf("\n  spike-records:");
  assert.ok(jobStart >= 0 && jobEnd > jobStart);
  const job = text.slice(jobStart, jobEnd);
  assert.match(job, /run:\s*npm ci\s*$/m, "protocol-order must run npm ci before node --test");
});

test("spike-records requires every record to be final", () => {
  assert.match(text, /run:\s*node scripts\/check-spike-records\.mjs --require-final\s*$/m);
});

test("docker-smoke builds and smoke-tests the image, then uploads its results", () => {
  assert.match(text, /run:\s*bash scripts\/docker-smoke\.sh --results/);
  assert.match(text, /uses:\s*actions\/upload-artifact@[0-9a-f]{40}\s*#\s*v\d+\.\d+\.\d+\s*$/m);
  assert.match(text, /name:\s*docker-smoke-results/);
});

test("the data-dir negative steps require a specific non-zero exit, not merely any outcome", () => {
  assert.match(text, /PRISM_DATA_DIR="\$GITHUB_WORKSPACE\/data" node scripts\/check-data-dir\.mjs \|\| rc=\$\?/);
  assert.match(text, /\[ "\$rc" -eq 1 \]/);
  assert.match(text, /ln -s "\$GITHUB_WORKSPACE\/data" "\$RUNNER_TEMP\/prism-link"/);
  assert.match(text, /\[ "\$rc" -eq 2 \]/);
});

test("the workflow has no unpinned third-party download or secret reference", () => {
  assert.doesNotMatch(text, /secrets\./);
  assert.doesNotMatch(text, /curl[^\n]*\|\s*(ba)?sh/);
});
