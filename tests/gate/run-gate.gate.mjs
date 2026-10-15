// COD-05 coverage for runGate() against the REAL .venv-gate interpreter (same
// resolution as tests/gate/gate-smoke.gate.mjs). Not part of `npm test` (the
// .gate.mjs suffix); run with `npm run test:gate`.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { runGate } from "../../src/pipeline/gate/run-gate.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = JSON.parse(fs.readFileSync(path.join(root, "vendor", "ai-output-to-value", "tests", "fixtures", "claim-gate-conformance.json"), "utf8"));
const pin = JSON.parse(fs.readFileSync(path.join(root, "vendor", "ai-output-to-value", "PIN.json"), "utf8"));

describe("runGate against the real .venv-gate interpreter (COD-05)", () => {
  test("a record that passes every required check resolves PASS, with the pinned gateSha", async () => {
    const result = await runGate(fixture.baseRecord, { repoRoot: root });
    assert.equal(result.status, "PASS");
    assert.equal(result.gateSha, pin.files["scripts/claim_gate.py"].sha256);
    assert.equal(result.raw.status, "PASS");
  });

  test("a record with a failed required check resolves BLOCKED, with the same gateSha", async () => {
    const blocked = {
      ...structuredClone(fixture.baseRecord),
      gateChecks: { ...fixture.baseRecord.gateChecks, "acceptance-criteria-met": "fail" },
    };
    const result = await runGate(blocked, { repoRoot: root });
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.gateSha, pin.files["scripts/claim_gate.py"].sha256);
  });
});
