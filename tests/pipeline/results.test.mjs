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
import {
  endConfirmation,
  ensurePipelineSchema,
  readTally,
  recordInjectionFlags,
  recordMissingData,
  recordProjectResult,
  startConfirmation,
} from "../../src/pipeline/store/results.ts";

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

  test("ensurePipelineSchema's three new structures exist after the first call", async () => {
    const db = freshDb();
    await ensurePipelineSchema(db);

    // missing_data column: an insert naming it (via a direct update after a
    // recordProjectResult row exists) must not throw "no such column".
    await recordProjectResult(db, {
      projectN: 1,
      hnId: "h1",
      modelId: "m",
      promptHash: "p",
      codebookVersion: "v0",
      gateSha: "g",
      snapshotHashesInCollectionOrder: [],
      codingAttempts: 1,
      codingAllUnknown: false,
      checkStates: [],
      claims: [],
    });
    await assert.doesNotReject(() => recordMissingData(db, 1, true));

    await assert.doesNotReject(() => recordInjectionFlags(db, 1, [{ spanId: "p1-s003" }]));
    await assert.doesNotReject(() => startConfirmation(db, 1));
  });

  test("recordMissingData sets missing_data=1 for the touched project; an untouched project reads back falsy", async () => {
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
      codingAllUnknown: false,
      checkStates: [],
      claims: [],
    });

    await recordMissingData(db, 1, true);

    const rows = await db.selectFrom("pipeline_project_results").select(["project_n", "missing_data"]).orderBy("project_n").execute();
    assert.equal(rows.find((r) => r.project_n === 1).missing_data, 1);
    assert.ok(!rows.find((r) => r.project_n === 2).missing_data, "an untouched project must read back 0/null, never throw");
  });

  test("recordInjectionFlags replaces a project's rows on each call, never accumulating duplicates", async () => {
    const db = freshDb();
    await ensurePipelineSchema(db);

    await recordInjectionFlags(db, 1, [{ spanId: "p1-s001" }, { spanId: "p1-s002" }]);
    await recordInjectionFlags(db, 1, [{ spanId: "p1-s003" }]);

    const rows = await db.selectFrom("pipeline_injection_flags").select(["project_n", "span_id"]).where("project_n", "=", 1).execute();
    assert.deepEqual(
      rows.map((r) => r.span_id),
      ["p1-s003"],
      "only the second call's flags must remain",
    );
  });

  test("recordInjectionFlags with an empty array clears a project that no longer has any flagged span", async () => {
    const db = freshDb();
    await ensurePipelineSchema(db);

    await recordInjectionFlags(db, 1, [{ spanId: "p1-s001" }]);
    await recordInjectionFlags(db, 1, []);

    const rows = await db.selectFrom("pipeline_injection_flags").select(["span_id"]).where("project_n", "=", 1).execute();
    assert.deepEqual(rows, []);
  });

  test("startConfirmation then endConfirmation leaves one row with both timestamps set; started_at unchanged by endConfirmation", async () => {
    const db = freshDb();
    await ensurePipelineSchema(db);

    await startConfirmation(db, 1);
    const afterStart = await db
      .selectFrom("pipeline_confirmation_log")
      .select(["started_at", "ended_at"])
      .where("project_n", "=", 1)
      .executeTakeFirst();
    assert.ok(afterStart.started_at, "started_at must be set");
    assert.equal(afterStart.ended_at, null);

    await endConfirmation(db, 1);
    const rows = await db.selectFrom("pipeline_confirmation_log").select(["project_n", "started_at", "ended_at"]).execute();
    assert.equal(rows.length, 1, "exactly one row for the project");
    assert.equal(rows[0].started_at, afterStart.started_at, "started_at must not change");
    assert.ok(rows[0].ended_at, "ended_at must be set");
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

  test("readTally({ projectNs }) counts only those projects (04-03)", async () => {
    const db = freshDb();
    await ensurePipelineSchema(db);
    const [c0] = gateFile.checkIds;

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
      checkStates: checkStatesFor({ [c0]: "pass" }),
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
      codingAllUnknown: false,
      checkStates: checkStatesFor({ [c0]: "fail" }),
      claims: [],
    });
    await recordProjectResult(db, {
      projectN: 3,
      hnId: "h3",
      modelId: "m",
      promptHash: "p3",
      codebookVersion: "v0",
      gateSha: "g",
      snapshotHashesInCollectionOrder: [],
      codingAttempts: 1,
      codingAllUnknown: false,
      checkStates: checkStatesFor({ [c0]: "claimed" }),
      claims: [],
    });

    const scoped = await readTally(db, gateFile, { projectNs: [1, 3] });
    const row = scoped.find((r) => r.checkId === c0);
    assert.deepEqual(row.counts, { pass: 1, fail: 0, unknown: 0, claimed: 1 });
    assert.equal(row.total, 2, "scoped tally N is the filtered project count, not every row in the DB");
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
        // N is the real tally total for the check (here 1 seeded project), never a hardcoded constant.
        assert.match(line, /^.+: pass \d+, fail \d+, unknown \d+, claimed \d+ \(of N=\d+\)$/);
        assert.match(line, /\(of N=1\)$/);
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

test("ensurePipelineSchema adds missing_data to a pipeline_project_results table created by the Phase 2 schema", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE pipeline_project_results (project_n integer primary key, hn_id text, model_id text,
    prompt_hash text, codebook_version text, gate_sha text, snapshot_hashes_json text, coding_attempts integer,
    coding_all_unknown integer, completed_at text)`);
  sqlite.exec(`INSERT INTO pipeline_project_results (project_n, hn_id) VALUES (1, 'h1')`);
  const db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });

  await ensurePipelineSchema(db);
  await ensurePipelineSchema(db);
  await recordMissingData(db, 1, true);

  const row = sqlite.prepare("SELECT hn_id, missing_data FROM pipeline_project_results WHERE project_n = 1").get();
  assert.deepEqual(row, { hn_id: "h1", missing_data: 1 });
});
