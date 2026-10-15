// COD-06: the durable per-project store, run manifest, and the per-check
// tally, proven against the real, live-loaded 24-check gate file (never a
// hand-typed or alphabetical order).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import { loadGateFile } from "../../src/pipeline/coding/contract.ts";
import { ensurePipelineSchema, readTally, recordProjectResult } from "../../src/pipeline/store/results.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const gatesPath = path.join(root, "vendor", "ai-output-to-value", "schemas", "v1", "decision-gates.json");
const gateFile = loadGateFile(gatesPath);

function freshDb() {
  const sqlite = new Database(":memory:");
  return new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
}

function checkStatesFor(filteredStateByCheckId) {
  return gateFile.checkIds.map((checkId) => ({
    checkId,
    proposedState: filteredStateByCheckId[checkId] ?? "unknown",
    filteredState: filteredStateByCheckId[checkId] ?? "unknown",
    spanIds: [],
  }));
}

describe("ensurePipelineSchema / recordProjectResult / readTally (COD-06)", () => {
  test("ensurePipelineSchema is idempotent against the same temp SQLite connection", async () => {
    const db = freshDb();
    await ensurePipelineSchema(db);
    await assert.doesNotReject(() => ensurePipelineSchema(db));
  });

  test("readTally over 2 synthetic projects matches hand-computed totals, in the gate file's own canonical order", async () => {
    const db = freshDb();
    await ensurePipelineSchema(db);

    const [c0, c1, c2] = gateFile.checkIds;

    await recordProjectResult(db, {
      projectN: 1,
      hnId: "h1",
      modelId: "m",
      promptHash: "p1",
      codebookVersion: "v0",
      gateSha: "g",
      snapshotHashesInCollectionOrder: ["s1a", "s1b"],
      codingAttempts: 1,
      codingAllUnknown: false,
      checkStates: checkStatesFor({ [c0]: "pass", [c1]: "fail", [c2]: "unknown" }),
      claims: [],
    });
    await recordProjectResult(db, {
      projectN: 2,
      hnId: "h2",
      modelId: "m",
      promptHash: "p2",
      codebookVersion: "v0",
      gateSha: "g",
      snapshotHashesInCollectionOrder: ["s2a"],
      codingAttempts: 2,
      codingAllUnknown: false,
      checkStates: checkStatesFor({ [c0]: "pass", [c1]: "pass", [c2]: "claimed" }),
      claims: [],
    });

    const tally = await readTally(db, gateFile);

    assert.deepEqual(
      tally.map((r) => r.checkId),
      gateFile.checkIds,
      "tally order must be the gate file's own canonical checkIds order",
    );

    const byId = new Map(tally.map((r) => [r.checkId, r]));
    assert.deepEqual(byId.get(c0).counts, { pass: 2, fail: 0, unknown: 0, claimed: 0 });
    assert.equal(byId.get(c0).total, 2);
    assert.deepEqual(byId.get(c1).counts, { pass: 1, fail: 1, unknown: 0, claimed: 0 });
    assert.deepEqual(byId.get(c2).counts, { pass: 0, fail: 0, unknown: 1, claimed: 1 });

    // every check not explicitly set above defaulted to "unknown" for both projects
    const c3 = gateFile.checkIds[3];
    assert.deepEqual(byId.get(c3).counts, { pass: 0, fail: 0, unknown: 2, claimed: 0 });
  });

  test("codingAllUnknown is queryable as distinct from a genuine model-coded unknown with identical filtered_state values", async () => {
    const db = freshDb();
    await ensurePipelineSchema(db);

    const allUnknown = Object.fromEntries(gateFile.checkIds.map((id) => [id, "unknown"]));

    await recordProjectResult(db, {
      projectN: 1,
      hnId: "h1",
      modelId: "m",
      promptHash: "p1",
      codebookVersion: "v0",
      gateSha: "g",
      snapshotHashesInCollectionOrder: [],
      codingAttempts: 3,
      codingAllUnknown: true, // retries exhausted
      checkStates: checkStatesFor(allUnknown),
      claims: [],
    });
    await recordProjectResult(db, {
      projectN: 2,
      hnId: "h2",
      modelId: "m",
      promptHash: "p2",
      codebookVersion: "v0",
      gateSha: "g",
      snapshotHashesInCollectionOrder: [],
      codingAttempts: 1,
      codingAllUnknown: false, // genuine model-coded unknown
      checkStates: checkStatesFor(allUnknown),
      claims: [],
    });

    const resultRows = await db
      .selectFrom("pipeline_project_results")
      .select(["project_n", "coding_all_unknown"])
      .orderBy("project_n")
      .execute();
    assert.deepEqual(resultRows.map((r) => r.coding_all_unknown), [1, 0]);

    const checkRows = await db.selectFrom("pipeline_check_states").select(["project_n", "filtered_state"]).execute();
    const states1 = checkRows.filter((r) => r.project_n === 1).map((r) => r.filtered_state);
    const states2 = checkRows.filter((r) => r.project_n === 2).map((r) => r.filtered_state);
    assert.deepEqual(states1, states2, "both projects must have identical filtered_state for every check");
  });

  test("claims are recorded, one row per decision", async () => {
    const db = freshDb();
    await ensurePipelineSchema(db);

    await recordProjectResult(db, {
      projectN: 1,
      hnId: "h1",
      modelId: "m",
      promptHash: "p1",
      codebookVersion: "v0",
      gateSha: "g",
      snapshotHashesInCollectionOrder: [],
      codingAttempts: 1,
      codingAllUnknown: false,
      checkStates: [],
      claims: [
        { decisionId: "rely", claimJson: { a: 1 }, gateStatus: "PASS" },
        { decisionId: "operate", claimJson: { b: 2 }, gateStatus: "BLOCKED" },
      ],
    });

    const rows = await db.selectFrom("pipeline_claims").select(["decision_id", "gate_status", "claim_json"]).execute();
    assert.equal(rows.length, 2);
    const byDecision = new Map(rows.map((r) => [r.decision_id, r]));
    assert.equal(byDecision.get("rely").gate_status, "PASS");
    assert.equal(byDecision.get("operate").gate_status, "BLOCKED");
    assert.deepEqual(JSON.parse(byDecision.get("rely").claim_json), { a: 1 });
  });
});

describe("node src/pipeline/tally.ts (CLI)", () => {
  test("prints at least one line per check, with no uncaught exception, against a seeded temp PRISM_DATA_DIR", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-tally-"));
    const env = { ...process.env, PRISM_DATA_DIR: dataDir };

    const dbPath = JSON.stringify(path.join(root, "src/app/server/db.ts"));
    const resultsPath = JSON.stringify(path.join(root, "src/pipeline/store/results.ts"));
    const contractPath = JSON.stringify(path.join(root, "src/pipeline/coding/contract.ts"));
    const gatesPathLiteral = JSON.stringify(gatesPath);

    const seedScript = [
      `import { getDb } from ${dbPath};`,
      `import { ensurePipelineSchema, recordProjectResult } from ${resultsPath};`,
      `import { loadGateFile } from ${contractPath};`,
      `const gateFile = loadGateFile(${gatesPathLiteral});`,
      `const db = getDb();`,
      `await ensurePipelineSchema(db);`,
      `const checkStates = gateFile.checkIds.map((checkId) => ({ checkId, proposedState: "unknown", filteredState: "unknown", spanIds: [] }));`,
      `await recordProjectResult(db, { projectN: 1, hnId: "h1", modelId: "m", promptHash: "p", codebookVersion: "v0", gateSha: "g", snapshotHashesInCollectionOrder: ["a"], codingAttempts: 1, codingAllUnknown: false, checkStates, claims: [] });`,
    ].join("\n");

    try {
      execFileSync("node", ["--input-type=module", "-e", seedScript], { cwd: root, env });

      const out = execFileSync("node", [path.join(root, "src/pipeline/tally.ts")], {
        cwd: root,
        env,
        encoding: "utf8",
      });

      const lines = out.trim().split("\n").filter(Boolean);
      assert.ok(lines.length >= gateFile.checkIds.length, "must print at least one line per check");
      for (const line of lines) {
        assert.match(line, /^.+: pass \d+, fail \d+, unknown \d+, claimed \d+ \(of N=10\)$/);
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
