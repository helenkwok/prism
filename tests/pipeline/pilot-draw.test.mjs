// D-42/D-43 coverage: the seeded, deterministic 20-project pilot draw and
// the floor-effect report over the pilot's recorded tally, against the
// real, live-loaded gate file (never a hand-typed check-id list).

import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import { loadGateFile } from "../../src/pipeline/coding/contract.ts";
import { PILOT_DRAW_SEED, selectPilotProjects } from "../../src/pipeline/select/pilot-draw.ts";
import { floorEffectReport } from "../../src/pipeline/store/floor-effect.ts";
import { ensurePipelineSchema, recordProjectResult } from "../../src/pipeline/store/results.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const gatesPath = path.join(root, "vendor", "ai-output-to-value", "schemas", "v1", "decision-gates.json");
const gateFile = loadGateFile(gatesPath);

function freshDb() {
  const sqlite = new Database(":memory:");
  return new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
}

function pool(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}` }));
}

function checkStatesFor(filteredStateByCheckId) {
  return gateFile.checkIds.map((checkId) => ({
    checkId,
    proposedState: filteredStateByCheckId[checkId] ?? "unknown",
    filteredState: filteredStateByCheckId[checkId] ?? "unknown",
    spanIds: [],
  }));
}

describe("selectPilotProjects (D-42)", () => {
  test("draws exactly 20 from a 25-candidate pool", () => {
    const drawn = selectPilotProjects({ candidates: pool(25) });
    assert.equal(drawn.length, 20);
  });

  test("the same pool and seed produce byte-identical output across two calls", () => {
    const a = selectPilotProjects({ candidates: pool(25) });
    const b = selectPilotProjects({ candidates: pool(25) });
    assert.deepEqual(a, b);
  });

  test("a pool of only 15 candidates throws, naming 15 and 20", () => {
    assert.throws(() => selectPilotProjects({ candidates: pool(15) }), /15.*20|15 of 20/);
  });

  test("a different seed produces a different order over the same pool", () => {
    const a = selectPilotProjects({ candidates: pool(25) });
    const b = selectPilotProjects({ candidates: pool(25), seed: "deadbeefdeadbeef" });
    assert.notDeepEqual(a, b);
  });

  test("PILOT_DRAW_SEED is distinct from Phase 2's SLICE_DRAW_SEED and the protocol's five official seeds", () => {
    const officialAndSlice = [
      "ae0b3a26c3b17672",
      "fa23e4fccbc39ce5",
      "d1481ad50ed309ea",
      "cc45c03dd0094b92",
      "1a8a5e2c0f6afdcb",
      "58ccec070ccb8d4e",
    ];
    assert.equal(officialAndSlice.includes(PILOT_DRAW_SEED), false);
  });
});

describe("floorEffectReport (D-43)", () => {
  test("flags only a check with zero pass+claimed across 20 synthetic projects", async () => {
    const db = freshDb();
    await ensurePipelineSchema(db);

    const [floorCheck, oneClaimedCheck] = gateFile.checkIds;

    for (let n = 1; n <= 20; n++) {
      const states = { [floorCheck]: "fail" };
      if (n === 1) states[oneClaimedCheck] = "claimed";
      await recordProjectResult(db, {
        projectN: n,
        hnId: `h${n}`,
        modelId: "m",
        promptHash: "p",
        codebookVersion: "v0",
        gateSha: "g",
        snapshotHashesInCollectionOrder: [`s${n}`],
        codingAttempts: 1,
        codingAllUnknown: false,
        checkStates: checkStatesFor(states),
        claims: [],
      });
    }

    const report = await floorEffectReport(db, gateFile);
    const byId = new Map(report.map((r) => [r.checkId, r]));

    assert.equal(byId.get(floorCheck).passPlusClaimed, 0);
    assert.equal(byId.get(floorCheck).isFloorEffect, true);

    assert.equal(byId.get(oneClaimedCheck).passPlusClaimed, 1);
    assert.equal(byId.get(oneClaimedCheck).isFloorEffect, false);

    const flagged = report.filter((r) => r.isFloorEffect).map((r) => r.checkId);
    assert.deepEqual(flagged.includes(floorCheck), true);
    assert.deepEqual(flagged.includes(oneClaimedCheck), false);
  });
});
