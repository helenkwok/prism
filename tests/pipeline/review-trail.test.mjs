// VAL-04 / D-58: trail.ts — blind payload, edit filter, gold lock, person decisions/gold.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import { loadCodebook } from "../../src/pipeline/coding/codebook-prompt.ts";
import { loadGateFile, resolveGatesPath } from "../../src/pipeline/coding/contract.ts";
import {
  ensureConfirmationSchema,
  ensureEditsSchema,
  spansDigest,
  projectSpans,
} from "../../src/pipeline/confirm/confirm.ts";
import {
  readTrail,
  recordEdit,
  recordPersonDecision,
  recordPersonGold,
} from "../../src/pipeline/review/trail.ts";
import { ensureGoldSchema } from "../../src/pipeline/validate/gold.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const codebook = loadCodebook(path.join(repoRoot, "codebook.md"));
const gate = loadGateFile(resolveGatesPath());
const checkId = gate.checkIds[0];

function memDb() {
  return new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
}

function makeDataDir(projectN, text = "We publish a status page for customers.") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-trail-"));
  const hash = "snap1";
  fs.mkdirSync(path.join(dir, "pipeline", "manifests"), { recursive: true });
  fs.mkdirSync(path.join(dir, "pipeline", "snapshots"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "pipeline", "manifests", `${projectN}.json`),
    JSON.stringify({ snapshotHashesInCollectionOrder: [hash] }),
  );
  fs.writeFileSync(
    path.join(dir, "pipeline", "snapshots", `${hash}.json`),
    JSON.stringify({ redactedText: text }),
  );
  return dir;
}

async function seedModel(db, projectN, rows) {
  await db.schema
    .createTable("pipeline_check_states")
    .ifNotExists()
    .addColumn("project_n", "integer")
    .addColumn("check_id", "text")
    .addColumn("proposed_state", "text")
    .addColumn("filtered_state", "text")
    .addColumn("span_ids_json", "text")
    .addPrimaryKeyConstraint("pcs_pk", ["project_n", "check_id"])
    .execute();
  for (const r of rows) {
    await db
      .insertInto("pipeline_check_states")
      .values({
        project_n: projectN,
        check_id: r.checkId,
        proposed_state: r.state,
        filtered_state: r.state,
        span_ids_json: JSON.stringify(r.spanIds ?? []),
      })
      .execute();
  }
}

async function unlockGold(db, dataDir, projectN) {
  await ensureGoldSchema(db);
  const digest = spansDigest(projectSpans(dataDir, projectN));
  await db
    .insertInto("pipeline_gold_outcomes")
    .values({
      project_n: projectN,
      codebook_version: codebook.codebookVersion,
      labeller_id: "gold:test",
      input_digest: digest,
      outcome: "labelled",
      reason: null,
      decided_at: "t",
    })
    .execute();
  return digest;
}

describe("readTrail blind vs full", () => {
  test("blind mode omits model, second, confirmations, edits, gold, published keys", async () => {
    const db = memDb();
    const dataDir = makeDataDir(1);
    await seedModel(db, 1, [{ checkId, state: "pass", spanIds: ["p1-s001"] }]);
    const trail = await readTrail(db, dataDir, 1, { blind: true, codebook });
    assert.equal(trail.blind, true);
    assert.ok(trail.checks.length >= 1);
    const check = trail.checks.find((c) => c.checkId === checkId);
    assert.ok(check);
    assert.equal("model" in check, false);
    assert.equal("second" in check, false);
    assert.equal("confirmations" in check, false);
    assert.equal("edits" in check, false);
    assert.equal("gold" in check, false);
    assert.equal("published" in check, false);
    assert.ok(typeof check.rule === "string" && check.rule.length > 0);
    assert.ok(Array.isArray(check.spans));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test("non-blind returns model and published keys", async () => {
    const db = memDb();
    const dataDir = makeDataDir(1);
    await seedModel(db, 1, [{ checkId, state: "pass", spanIds: ["p1-s001"] }]);
    await ensureConfirmationSchema(db);
    await unlockGold(db, dataDir, 1);
    const trail = await readTrail(db, dataDir, 1, { blind: false, codebook });
    const check = trail.checks.find((c) => c.checkId === checkId);
    assert.equal("model" in check, true);
    assert.equal(check.model.filtered, "pass");
    assert.equal("published" in check, true);
    assert.equal("confirmations" in check, true);
    assert.equal("edits" in check, true);
    assert.equal("gold" in check, true);
    assert.equal("second" in check, true);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe("recordEdit", () => {
  test("pass with no span ids stores filtered_state unknown; known span keeps pass", async () => {
    const db = memDb();
    const dataDir = makeDataDir(1);
    await seedModel(db, 1, [{ checkId, state: "unknown", spanIds: [] }]);
    await unlockGold(db, dataDir, 1);
    await ensureEditsSchema(db);

    const unk = await recordEdit(db, dataDir, {
      projectN: 1,
      checkId,
      state: "pass",
      spanIds: [],
      actorId: "person:a@example.com",
    });
    assert.equal(unk.filteredState, "unknown");

    const ok = await recordEdit(db, dataDir, {
      projectN: 1,
      checkId,
      state: "pass",
      spanIds: ["p1-s001"],
      actorId: "person:a@example.com",
    });
    assert.equal(ok.filteredState, "pass");
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test("throws before writing on unknown span, unknown check, invalid state, or awaiting gold", async () => {
    const db = memDb();
    const dataDir = makeDataDir(1);
    await seedModel(db, 1, [{ checkId, state: "unknown", spanIds: [] }]);

    await assert.rejects(
      () =>
        recordEdit(db, dataDir, {
          projectN: 1,
          checkId,
          state: "pass",
          spanIds: ["p1-s001"],
          actorId: "person:a@example.com",
        }),
      /awaiting gold/,
    );

    await unlockGold(db, dataDir, 1);

    await assert.rejects(
      () =>
        recordEdit(db, dataDir, {
          projectN: 1,
          checkId: "not-a-real-check",
          state: "pass",
          spanIds: ["p1-s001"],
          actorId: "person:a@example.com",
        }),
      /unknown check/,
    );
    await assert.rejects(
      () =>
        recordEdit(db, dataDir, {
          projectN: 1,
          checkId,
          state: "maybe",
          spanIds: ["p1-s001"],
          actorId: "person:a@example.com",
        }),
      /invalid state/,
    );
    await assert.rejects(
      () =>
        recordEdit(db, dataDir, {
          projectN: 1,
          checkId,
          state: "pass",
          spanIds: ["p9-nope"],
          actorId: "person:a@example.com",
        }),
      /unknown span/,
    );

    const rows = await db.selectFrom("pipeline_edits").selectAll().execute().catch(() => []);
    assert.equal(rows.length, 0);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe("recordPersonDecision", () => {
  test("writes person confirmation; refuses downgrade from claimed and own-edit decide", async () => {
    const db = memDb();
    const dataDir = makeDataDir(1);
    await seedModel(db, 1, [{ checkId, state: "pass", spanIds: ["p1-s001"] }]);
    await unlockGold(db, dataDir, 1);
    const actor = "person:helen@example.com";

    await recordPersonDecision(db, dataDir, {
      projectN: 1,
      checkId,
      decision: "confirmed",
      reason: "p1-s001 shows it",
      actorId: actor,
      codebook,
    });
    const row = await db.selectFrom("pipeline_confirmations").selectAll().executeTakeFirst();
    assert.equal(row.confirmer_kind, "person");
    assert.equal(row.confirmer_id, actor);
    assert.equal(row.decision, "confirmed");
    assert.ok(row.input_digest);

    // Downgrade from claimed refused
    await db.deleteFrom("pipeline_check_states").execute();
    await seedModel(db, 1, [{ checkId, state: "claimed", spanIds: ["p1-s001"] }]);
    await assert.rejects(
      () =>
        recordPersonDecision(db, dataDir, {
          projectN: 1,
          checkId,
          decision: "downgraded",
          reason: "x",
          actorId: "person:other@example.com",
          codebook,
        }),
      /downgrade only from pass/,
    );

    // Own-edit refuse
    await recordEdit(db, dataDir, {
      projectN: 1,
      checkId,
      state: "pass",
      spanIds: ["p1-s001"],
      actorId: actor,
    });
    await assert.rejects(
      () =>
        recordPersonDecision(db, dataDir, {
          projectN: 1,
          checkId,
          decision: "confirmed",
          reason: "x",
          actorId: actor,
          codebook,
        }),
      /cannot decide on own edit/,
    );
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test("recordEdit and recordPersonDecision throw awaiting gold without outcome", async () => {
    const db = memDb();
    const dataDir = makeDataDir(2);
    await seedModel(db, 2, [{ checkId, state: "pass", spanIds: ["p1-s001"] }]);
    await assert.rejects(
      () =>
        recordPersonDecision(db, dataDir, {
          projectN: 2,
          checkId,
          decision: "rejected",
          reason: "x",
          actorId: "person:a@example.com",
          codebook,
        }),
      /awaiting gold/,
    );
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe("recordPersonGold", () => {
  test("writes 24 person gold rows plus outcome without reading proposals", async () => {
    const db = memDb();
    const dataDir = makeDataDir(3);
    // No pipeline_check_states seeded — function must not need them.
    const labels = gate.checkIds.map((id) => ({
      checkId: id,
      state: id === checkId ? "pass" : "unknown",
      spanIds: id === checkId ? ["p1-s001"] : [],
    }));
    await recordPersonGold(db, dataDir, {
      projectN: 3,
      labels,
      actorId: "person:labeller@example.com",
      codebookVersion: codebook.codebookVersion,
    });
    const golds = await db.selectFrom("pipeline_gold_labels").selectAll().execute();
    assert.equal(golds.length, 24);
    assert.ok(golds.every((g) => g.labeller_kind === "person"));
    const outcome = await db.selectFrom("pipeline_gold_outcomes").selectAll().executeTakeFirst();
    assert.equal(outcome.outcome, "labelled");
    assert.equal(outcome.labeller_id, "person:labeller@example.com");
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
