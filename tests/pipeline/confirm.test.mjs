// A2: role-neutral confirmation records, bound to the digest of the input they judged.
// COD-08 / D-56: downgrade, confirmed_state, publishedStates.

import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import { loadCodebook } from "../../src/pipeline/coding/codebook-prompt.ts";
import { PINNED_MODEL, SECOND_CODER_MODEL } from "../../src/pipeline/coding/nebius-client.ts";
import {
  confirmationStatus,
  confirmedStateFor,
  confirmWithModel,
  ensureConfirmationSchema,
  inputDigest,
  publishedStates,
  recordConfirmation,
} from "../../src/pipeline/confirm/confirm.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const codebook = loadCodebook(path.join(repoRoot, "codebook.md"));
const checkId = Object.keys(codebook.checks)[0];
const positive = { projectN: 1, checkId, state: "pass", spans: [{ id: "p1-s1", text: "We publish a status page." }] };

function memDb() {
  return new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
}

async function seedCheckStates(db, rows) {
  await db.schema
    .createTable("pipeline_check_states")
    .ifNotExists()
    .addColumn("project_n", "integer")
    .addColumn("check_id", "text")
    .addColumn("proposed_state", "text")
    .addColumn("filtered_state", "text")
    .addColumn("span_ids_json", "text")
    .addPrimaryKeyConstraint("pipeline_check_states_pk", ["project_n", "check_id"])
    .execute();
  for (const r of rows) {
    await db
      .insertInto("pipeline_check_states")
      .values({
        project_n: r.projectN,
        check_id: r.checkId,
        proposed_state: r.state,
        filtered_state: r.state,
        span_ids_json: JSON.stringify(r.spanIds ?? ["p1-s1"]),
      })
      .execute();
  }
}

describe("confirmation records", () => {
  test("a decision on the current input is decided; on changed spans, state or rule it is stale", () => {
    const d = { project_n: 1, check_id: checkId, input_digest: inputDigest(codebook, positive), decision: "confirmed" };
    assert.equal(confirmationStatus([positive], [d], codebook)[0].state, "decided");
    for (const changed of [
      { ...positive, spans: [{ id: "p1-s1", text: "We publish a status page!" }] },
      { ...positive, state: "claimed" },
    ]) {
      assert.equal(confirmationStatus([changed], [d], codebook)[0].state, "stale");
    }
    const otherRule = { ...codebook, checks: { ...codebook.checks, [checkId]: { ...codebook.checks[checkId], passRule: "changed" } } };
    assert.equal(confirmationStatus([positive], [d], otherRule)[0].state, "stale");
    assert.equal(confirmationStatus([positive], [], codebook)[0].state, "undecided");
  });

  test("records round-trip through the store, keyed per confirmer", async () => {
    const db = memDb();
    await ensureConfirmationSchema(db);
    const base = {
      projectN: 1, checkId, reason: "p1-s1 shows it", confirmerKind: "agent", modelId: "m",
      decidedAt: "t", inputDigest: "d", spanIds: ["p1-s1"], confirmedState: "pass",
    };
    await recordConfirmation(db, { ...base, decision: "rejected", confirmedState: null, confirmerId: "agent:m" });
    await recordConfirmation(db, { ...base, decision: "confirmed", confirmerId: "agent:m" });
    await recordConfirmation(db, { ...base, decision: "confirmed", confirmerId: "person:reviewer", confirmerKind: "person", modelId: null });
    const rows = await db.selectFrom("pipeline_confirmations").selectAll().orderBy("confirmer_id").execute();
    assert.deepEqual(rows.map((r) => [r.confirmer_id, r.decision]), [["agent:m", "confirmed"], ["person:reviewer", "confirmed"]]);
  });

  test("a model that coded the projects is refused as confirmer (A2)", async () => {
    for (const model of [PINNED_MODEL, SECOND_CODER_MODEL]) {
      await assert.rejects(confirmWithModel({ request: async () => assert.fail("must not call") }, codebook, positive, model), /A2/);
    }
  });

  test("an off-contract reply is retried, then refused", async () => {
    let calls = 0;
    const client = { request: async () => (calls++, { ok: true, status: 200, json: { choices: [{ message: { content: '{"decision":"maybe","reason":"x"}' } }] } }) };
    await assert.rejects(confirmWithModel(client, codebook, positive), /no valid reply/);
    assert.equal(calls, 3);
  });
});

describe("D-56 downgrade and publishedStates", () => {
  test("a pass downgraded records claimed and publishedStates returns claimed", async () => {
    const db = memDb();
    await ensureConfirmationSchema(db);
    await seedCheckStates(db, [{ projectN: 1, checkId, state: "pass" }]);
    let calls = 0;
    const client = {
      request: async () => (
        calls++,
        { ok: true, status: 200, json: { choices: [{ message: { content: '{"decision":"downgraded","reason":"p1-s1 is only a claim"}' } }] } }
      ),
    };
    const v = await confirmWithModel(client, codebook, positive);
    assert.equal(v.decision, "downgraded");
    assert.equal(calls, 1);
    // publishedStates rebuilds spans from dataDir; with none, text is "" — digest must match that shape.
    const forPublish = { ...positive, spans: [{ id: "p1-s1", text: "" }] };
    const digest = inputDigest(codebook, forPublish);
    await recordConfirmation(db, {
      projectN: 1, checkId, decision: v.decision, confirmedState: confirmedStateFor(v.decision, "pass"),
      reason: v.reason, confirmerId: "agent:m", confirmerKind: "agent", modelId: "m",
      decidedAt: "t", inputDigest: digest, spanIds: ["p1-s1"],
    });
    const row = await db.selectFrom("pipeline_confirmations").selectAll().executeTakeFirst();
    assert.equal(row.decision, "downgraded");
    assert.equal(row.confirmed_state, "claimed");
    const published = await publishedStates(db, "/nonexistent", codebook, [1]);
    const hit = published.find((p) => p.checkId === checkId);
    assert.equal(hit.published, "claimed");
    assert.equal(hit.basis, "downgraded");
  });

  test("downgraded for a claimed positive is off-contract: 3 attempts, nothing recorded", async () => {
    const db = memDb();
    await ensureConfirmationSchema(db);
    const claimed = { ...positive, state: "claimed" };
    let calls = 0;
    const client = {
      request: async () => (
        calls++,
        { ok: true, status: 200, json: { choices: [{ message: { content: '{"decision":"downgraded","reason":"x"}' } }] } }
      ),
    };
    await assert.rejects(confirmWithModel(client, codebook, claimed), /no valid reply/);
    assert.equal(calls, 3);
    const n = await db.selectFrom("pipeline_confirmations").selectAll().execute();
    assert.equal(n.length, 0);
  });

  test("confirmed/rejected set confirmed_state; publishedStates null for rejected and undecided", async () => {
    const db = memDb();
    await ensureConfirmationSchema(db);
    const passId = checkId;
    const claimedId = Object.keys(codebook.checks)[1];
    const undecidedId = Object.keys(codebook.checks)[2];
    await seedCheckStates(db, [
      { projectN: 1, checkId: passId, state: "pass" },
      { projectN: 1, checkId: claimedId, state: "claimed" },
      { projectN: 1, checkId: undecidedId, state: "pass" },
    ]);
    // Empty span text matches publishedStates when dataDir has no snapshots.
    const passPos = { projectN: 1, checkId: passId, state: "pass", spans: [{ id: "p1-s1", text: "" }] };
    const claimedPos = { projectN: 1, checkId: claimedId, state: "claimed", spans: [{ id: "p1-s1", text: "" }] };
    await recordConfirmation(db, {
      projectN: 1, checkId: passId, decision: "confirmed", confirmedState: "pass",
      reason: "ok", confirmerId: "agent:m", confirmerKind: "agent", modelId: "m",
      decidedAt: "t", inputDigest: inputDigest(codebook, passPos), spanIds: ["p1-s1"],
    });
    await recordConfirmation(db, {
      projectN: 1, checkId: claimedId, decision: "rejected", confirmedState: null,
      reason: "no", confirmerId: "agent:m", confirmerKind: "agent", modelId: "m",
      decidedAt: "t", inputDigest: inputDigest(codebook, claimedPos), spanIds: ["p1-s1"],
    });
    const rows = await db.selectFrom("pipeline_confirmations").selectAll().orderBy("check_id").execute();
    const byId = Object.fromEntries(rows.map((r) => [r.check_id, r]));
    assert.equal(byId[passId].confirmed_state, "pass");
    assert.equal(byId[claimedId].confirmed_state, null);

    const published = await publishedStates(db, "/nonexistent", codebook, [1]);
    assert.equal(published.find((p) => p.checkId === passId).published, "pass");
    assert.equal(published.find((p) => p.checkId === passId).basis, "confirmed");
    assert.equal(published.find((p) => p.checkId === claimedId).published, null);
    assert.equal(published.find((p) => p.checkId === claimedId).basis, "rejected");
    assert.equal(published.find((p) => p.checkId === undecidedId).published, null);
    assert.equal(published.find((p) => p.checkId === undecidedId).basis, "unconfirmed");
  });

  test("fail and unknown pass through publishedStates unchanged", async () => {
    const db = memDb();
    await ensureConfirmationSchema(db);
    const failId = Object.keys(codebook.checks)[0];
    const unknownId = Object.keys(codebook.checks)[1];
    await seedCheckStates(db, [
      { projectN: 2, checkId: failId, state: "fail", spanIds: [] },
      { projectN: 2, checkId: unknownId, state: "unknown", spanIds: [] },
    ]);
    const published = await publishedStates(db, "/nonexistent", codebook, [2]);
    assert.equal(published.find((p) => p.checkId === failId).published, "fail");
    assert.equal(published.find((p) => p.checkId === failId).basis, "not-positive");
    assert.equal(published.find((p) => p.checkId === unknownId).published, "unknown");
    assert.equal(published.find((p) => p.checkId === unknownId).basis, "not-positive");
  });

  test("ensureConfirmationSchema adds confirmed_state to an existing table that lacks it", async () => {
    const db = memDb();
    await db.schema
      .createTable("pipeline_confirmations")
      .addColumn("project_n", "integer")
      .addColumn("check_id", "text")
      .addColumn("confirmer_id", "text")
      .addColumn("confirmer_kind", "text")
      .addColumn("model_id", "text")
      .addColumn("decision", "text")
      .addColumn("reason", "text")
      .addColumn("decided_at", "text")
      .addColumn("input_digest", "text")
      .addColumn("span_ids_json", "text")
      .addPrimaryKeyConstraint("pipeline_confirmations_pk", ["project_n", "check_id", "confirmer_id"])
      .execute();
    const before = (await db.introspection.getTables()).find((t) => t.name === "pipeline_confirmations");
    assert.equal(before.columns.some((c) => c.name === "confirmed_state"), false);
    await ensureConfirmationSchema(db);
    const after = (await db.introspection.getTables()).find((t) => t.name === "pipeline_confirmations");
    assert.equal(after.columns.some((c) => c.name === "confirmed_state"), true);
  });
});
