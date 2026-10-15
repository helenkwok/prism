// COD-01 robustness coverage for codeProjectWithRetry()/allUnknownChecks():
// D-28's exactly-3-attempt retry-to-unknown policy, proven against the
// real, live-loaded 24-check contract (never a hand-typed or fixture
// count).

import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildContract, loadGateFile } from "../../src/pipeline/coding/contract.ts";
import { allUnknownChecks, codeProjectWithRetry } from "../../src/pipeline/coding/retry.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const gatesPath = path.join(root, "vendor", "ai-output-to-value", "schemas", "v1", "decision-gates.json");
const gateFile = loadGateFile(gatesPath);
const contract = buildContract(gateFile.checkIds);

const SPAN_IDS = ["s001", "s002"];

function validReplyText() {
  const checks = contract.checkIds.map((checkId) => ({ checkId, proposedState: "unknown", spanIds: [] }));
  return JSON.stringify({ checks });
}

describe("codeProjectWithRetry (COD-01, D-28)", () => {
  test("invalid on attempts 1 and 2, valid on attempt 3 resolves {valid:true, attempts:3}", async () => {
    let calls = 0;
    const callOnce = async () => {
      calls += 1;
      return calls < 3 ? "not json" : validReplyText();
    };

    const result = await codeProjectWithRetry({ client: {}, cfg: {}, contract, spanIds: SPAN_IDS, callOnce });

    assert.equal(result.valid, true);
    assert.equal(result.attempts, 3);
    assert.equal(calls, 3);
  });

  test("invalid on all 3 attempts resolves {valid:false, attempts:3, allUnknown:true}, checks sized to the live contract", async () => {
    let calls = 0;
    const callOnce = async () => {
      calls += 1;
      return "still not json";
    };

    const result = await codeProjectWithRetry({ client: {}, cfg: {}, contract, spanIds: SPAN_IDS, callOnce });

    assert.equal(result.valid, false);
    assert.equal(result.attempts, 3);
    assert.equal(result.allUnknown, true);
    assert.equal(result.checks.length, contract.checkIds.length);
    for (const check of result.checks) {
      assert.equal(check.proposedState, "unknown");
      assert.deepEqual(check.spanIds, []);
    }
    assert.equal(calls, 3, "callOnce must never be called a 4th time after a 3rd invalid result");
  });

  test("allUnknownChecks(contract.checkIds) covers exactly the live-loaded check ids, in order", () => {
    const checks = allUnknownChecks(contract.checkIds);
    assert.deepEqual(checks.map((c) => c.checkId), contract.checkIds);
    assert.ok(checks.every((c) => c.proposedState === "unknown" && Array.isArray(c.spanIds) && c.spanIds.length === 0));
  });
});
