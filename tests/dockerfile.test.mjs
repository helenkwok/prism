// Static checks over Dockerfile, .dockerignore and scripts/docker-smoke.sh.
// No Docker daemon needed: everything here is a text-level assertion, so
// this suite runs in `npm test` and needs nothing beyond node:test.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const dockerignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8");
const dockerignoreLines = dockerignore.split(/\r?\n/);
const fromLines = dockerfile.split(/\r?\n/).filter((l) => /^\s*FROM\s/i.test(l));

test("both stages pin the same base image, by tag and digest", () => {
  assert.equal(fromLines.length, 2, `expected exactly two FROM lines, found ${fromLines.length}`);
  const refs = fromLines.map((l) => l.replace(/^\s*FROM\s+/i, "").split(/\s+AS\s+/i)[0].trim());
  assert.equal(refs[0], refs[1], "both FROM lines must reference the identical image");
  assert.match(refs[0], /^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/, `not pinned by tag and digest: ${refs[0]}`);
});

test("the container runs as a non-root user", () => {
  assert.match(dockerfile, /^USER node\s*$/m);
});

test("no ARG or ENV name suggests a secret", () => {
  const suspicious = /\b(ARG|ENV)\s+[A-Za-z0-9_]*(SECRET|PASSWORD|TOKEN|KEY|CREDENTIAL)[A-Za-z0-9_]*/i;
  for (const line of dockerfile.split(/\r?\n/)) {
    assert.doesNotMatch(line, suspicious, `looks like a secret declaration: ${line.trim()}`);
  }
});

test("dependencies install with npm ci, scripts never disabled", () => {
  assert.match(dockerfile, /^\s*RUN\s+npm ci\s*$/m);
  assert.doesNotMatch(dockerfile, /--ignore-scripts/);
});

test("the runtime stage installs python3, creates /opt/gate and installs the pinned gate requirements", () => {
  const runtimeStart = dockerfile.indexOf(fromLines[1]);
  assert.ok(runtimeStart >= 0);
  const runtimeStage = dockerfile.slice(runtimeStart);
  assert.match(runtimeStage, /apt-get install[^\n]*\bpython3\b/);
  assert.match(runtimeStage, /python3\s+-m\s+venv\s+\/opt\/gate/);
  assert.match(runtimeStage, /\/opt\/gate\/bin\/pip install[^\n]*-r requirements-gate\.txt/);
  assert.match(runtimeStage, /ENV\s+PRISM_PYTHON=\/opt\/gate\/bin\/python/);
});

test("the build stage copies only the allow-listed source paths", () => {
  const buildStart = dockerfile.indexOf(fromLines[0]);
  const buildEnd = dockerfile.indexOf(fromLines[1]);
  const buildStage = dockerfile.slice(buildStart, buildEnd);
  assert.match(buildStage, /COPY\s+package\.json\s+package-lock\.json/);
  assert.match(buildStage, /COPY\s+.*\bsrc\b/);
  assert.match(buildStage, /RUN\s+npm run build/);
});

test(".dockerignore is deny-all-first, then a named allow-list", () => {
  const codeLines = dockerignoreLines.filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  assert.equal(codeLines[0].trim(), "*", "the first non-comment line must be a bare '*'");
  assert.ok(codeLines.some((l) => l.trim() === "!src/**"), "must allow src/**");
  assert.ok(codeLines.some((l) => l.trim() === "!vendor/**"), "must allow vendor/**");
  assert.ok(
    codeLines.every((l) => l.trim() === "*" || l.trim().startsWith("!")),
    "every rule after the first must be a negated (allow) rule",
  );
});

test(".dockerignore names no agent-tool or planning directory", () => {
  // Base64-encoded so this test file itself never carries a bare pattern
  // in cleartext (D-23/D-25 name guard self-scan).
  const NEEDLES_B64 = [
    "LmNsYXVkZQ==",
    "LmN1cnNvcg==",
    "LmNvZGV4",
    "LmFnZW50cw==",
    "LmdlbWluaQ==",
    "LndpbmRzdXJm",
    "LnBsYW5uaW5n",
    "LmdzZA==",
  ];
  for (const b64 of NEEDLES_B64) {
    const needle = Buffer.from(b64, "base64").toString("utf8");
    assert.ok(!dockerignore.includes(needle), `must not name a forbidden directory`);
  }
});

test("scripts/docker-smoke.sh is syntactically valid bash", () => {
  const res = spawnSync("bash", ["-n", path.join(root, "scripts", "docker-smoke.sh")], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
});

test("scripts/docker-smoke.sh runs under a strict shell mode and cleans up", () => {
  const smoke = fs.readFileSync(path.join(root, "scripts", "docker-smoke.sh"), "utf8");
  assert.match(smoke, /set -euo pipefail/);
  assert.match(smoke, /trap\s+\S*cleanup\S*\s+EXIT/);
});
