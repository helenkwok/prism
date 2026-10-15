// COD-04 coverage for buildClaimsForProject(): rely-before-operate ordering,
// the deliverable-gate-passed override, the D-29 thin-evidence case, the
// claimed -> unknown projection, and canonical check order.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildClaimsForProject } from "../../src/pipeline/claims/build-claims.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const gatesPath = path.join(root, "vendor", "ai-output-to-value", "schemas", "v1", "decision-gates.json");
const gates = JSON.parse(fs.readFileSync(gatesPath, "utf8"));

/** All 24 check ids across all 5 decisions, each defaulted to "unknown" with no spans (the D-29 case). */
function allUnknownStates() {
  const states = [];
  for (const decision of Object.values(gates.decisions)) {
    for (const check of decision.requiredChecks) {
      if (!states.some((s) => s.checkId === check.id)) {
        states.push({ checkId: check.id, proposedState: "unknown", spanIds: [] });
      }
    }
  }
  return states;
}

function fakeRunGate(reliedStatus, order) {
  return async (record) => {
    order?.push(record.targetDecision);
    return { status: reliedStatus, raw: { status: reliedStatus }, gateSha: "fake-sha" };
  };
}

describe("buildClaimsForProject (COD-04)", () => {
  test("every one of the 5 records has assertedClaimLevel === requiredClaimLevel", async () => {
    const out = await buildClaimsForProject({
      project: "Test Project",
      filteredStates: allUnknownStates(),
      runGate: fakeRunGate("INSUFFICIENT_EVIDENCE"),
      gatesPath,
    });
    assert.equal(Object.keys(out).length, 5);
    for (const { record } of Object.values(out)) {
      assert.equal(record.assertedClaimLevel, record.requiredClaimLevel);
    }
  });

  test("rely's runGate is invoked before operate's record is built", async () => {
    const order = [];
    await buildClaimsForProject({
      project: "Test Project",
      filteredStates: allUnknownStates(),
      runGate: fakeRunGate("PASS", order),
      gatesPath,
    });
    assert.equal(order[0], "rely");
    assert.equal(order[1], "operate");
  });

  test("the operate record's deliverable-gate-passed reflects the PASS/BLOCKED/INSUFFICIENT_EVIDENCE override, overriding the model's own proposal", async () => {
    for (const [reliedStatus, expected] of [
      ["PASS", "pass"],
      ["BLOCKED", "fail"],
      ["INSUFFICIENT_EVIDENCE", "not-applicable"],
    ]) {
      const states = allUnknownStates();
      // the model itself proposes "pass" for this check with a real span — the
      // override must win regardless.
      const idx = states.findIndex((s) => s.checkId === "deliverable-gate-passed");
      states[idx] = { checkId: "deliverable-gate-passed", proposedState: "pass", spanIds: ["s001"] };

      const out = await buildClaimsForProject({
        project: "Test Project",
        filteredStates: states,
        spanUrls: { s001: "https://example.com/" },
        runGate: fakeRunGate(reliedStatus),
        gatesPath,
      });
      assert.equal(out.operate.record.gateChecks["deliverable-gate-passed"], expected, `relied status ${reliedStatus}`);
    }
  });

  test("the D-29 thin-evidence case: every requiredChecks id is present in gateChecks for all 5 records", async () => {
    const out = await buildClaimsForProject({
      project: "Test Project",
      filteredStates: allUnknownStates(),
      runGate: fakeRunGate("INSUFFICIENT_EVIDENCE"),
      gatesPath,
    });
    for (const [decisionId, { record }] of Object.entries(out)) {
      const requiredIds = gates.decisions[decisionId].requiredChecks.map((c) => c.id);
      for (const id of requiredIds) {
        assert.ok(id in record.gateChecks, `${decisionId} missing ${id}`);
      }
      assert.equal(Object.keys(record.gateChecks).length, requiredIds.length);
    }
  });

  test("a claimed input state is never present in any record's gateChecks", async () => {
    const states = allUnknownStates();
    const idx = states.findIndex((s) => s.checkId === "intended-use-defined");
    states[idx] = { checkId: "intended-use-defined", proposedState: "claimed", spanIds: ["s001"] };

    const out = await buildClaimsForProject({
      project: "Test Project",
      filteredStates: states,
      spanUrls: { s001: "https://example.com/" },
      runGate: fakeRunGate("INSUFFICIENT_EVIDENCE"),
      gatesPath,
    });
    for (const { record } of Object.values(out)) {
      assert.ok(!Object.values(record.gateChecks).includes("claimed"));
    }
    assert.equal(out.rely.record.gateChecks["intended-use-defined"], "unknown");
  });

  test("a decision's gateChecks keys follow decision-gates.json's own requiredChecks order", async () => {
    const out = await buildClaimsForProject({
      project: "Test Project",
      filteredStates: allUnknownStates(),
      runGate: fakeRunGate("INSUFFICIENT_EVIDENCE"),
      gatesPath,
    });
    for (const [decisionId, { record }] of Object.entries(out)) {
      const expectedOrder = gates.decisions[decisionId].requiredChecks.map((c) => c.id);
      assert.deepEqual(Object.keys(record.gateChecks), expectedOrder);
    }
  });
});
