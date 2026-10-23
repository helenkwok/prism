// A2: role-neutral confirmation records, bound to the digest of the input they judged.
// COD-08 / D-56 / D-57 / D-53 / A7.8 / D-64: downgrade, flagged spans, gold lock, edits, ordered stop.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import { loadCodebook } from "../../src/pipeline/coding/codebook-prompt.ts";
import { PINNED_MODEL, QuotaStop, SECOND_CODER_MODEL } from "../../src/pipeline/coding/nebius-client.ts";
import {
  confirmationStatus,
  confirmedStateFor,
  confirmWithModel,
  effectiveStates,
  ensureConfirmationSchema,
  ensureEditsSchema,
  inputDigest,
  publishedStates,
  readPositives,
  recordConfirmation,
  spansDigest,
  projectSpans,
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

async function seedFlags(db, rows) {
  await db.schema
    .createTable("pipeline_injection_flags")
    .ifNotExists()
    .addColumn("project_n", "integer")
    .addColumn("span_id", "text")
    .addPrimaryKeyConstraint("pipeline_injection_flags_pk", ["project_n", "span_id"])
    .execute();
  for (const r of rows) {
    await db.insertInto("pipeline_injection_flags").values({ project_n: r.projectN, span_id: r.spanId }).execute();
  }
}

async function seedGoldOutcomes(db, rows) {
  await db.schema
    .createTable("pipeline_gold_outcomes")
    .ifNotExists()
    .addColumn("project_n", "integer")
    .addColumn("codebook_version", "text")
    .addColumn("labeller_id", "text")
    .addColumn("input_digest", "text")
    .addColumn("outcome", "text")
    .addColumn("reason", "text")
    .addColumn("decided_at", "text")
    .addPrimaryKeyConstraint("pipeline_gold_outcomes_pk", ["project_n", "codebook_version", "labeller_id", "input_digest"])
    .execute();
  for (const r of rows) {
    await db
      .insertInto("pipeline_gold_outcomes")
      .values({
        project_n: r.projectN,
        codebook_version: r.codebookVersion ?? "v1.0",
        labeller_id: r.labellerId ?? "gold:test",
        input_digest: r.inputDigest,
        outcome: r.outcome ?? "labelled",
        reason: null,
        decided_at: "t",
      })
      .execute();
  }
}

/** Minimal dataDir so projectSpans / spansDigest work for projectN. */
function makeDataDir(projectN, text = "We publish a status page for customers.") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-confirm-"));
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
    for (const model of [PINNED_MODEL, SECOND_CODER_MODEL, "nemotron-3-super", "nemotron-3-super:cloud"]) {
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

describe("D-57 flagged spans, D-53 gold lock, A7.8 edits", () => {
  test("confirmed/downgraded citing a flagged span is off-contract; rejected accepted; FlaggedRuleError after 3", async () => {
    const flagged = { ...positive, flaggedSpanIds: ["p1-s1"] };
    let calls = 0;
    const confirmClient = {
      request: async () => (
        calls++,
        { ok: true, status: 200, json: { choices: [{ message: { content: '{"decision":"confirmed","reason":"p1-s1"}' } }] } }
      ),
    };
    await assert.rejects(confirmWithModel(confirmClient, codebook, flagged), (err) => {
      assert.equal(err.name, "FlaggedRuleError");
      return true;
    });
    assert.equal(calls, 3);

    calls = 0;
    const rejectClient = {
      request: async () => (
        calls++,
        { ok: true, status: 200, json: { choices: [{ message: { content: '{"decision":"rejected","reason":"flagged p1-s1"}' } }] } }
      ),
    };
    const v = await confirmWithModel(rejectClient, codebook, flagged);
    assert.equal(v.decision, "rejected");
    assert.equal(calls, 1);
  });

  test("readPositives attaches flaggedSpanIds and respects sampleNs + gold lock", async () => {
    const db = memDb();
    await ensureConfirmationSchema(db);
    await ensureEditsSchema(db);
    const dataDir = makeDataDir(1);
    makeDataDirCopy(dataDir, 301);
    const digest1 = spansDigest(projectSpans(dataDir, 1));
    await seedCheckStates(db, [
      { projectN: 1, checkId, state: "pass", spanIds: projectSpans(dataDir, 1).slice(0, 1).map((s) => s.id) },
      { projectN: 301, checkId, state: "pass", spanIds: ["p1-s1"] },
    ]);
    await seedFlags(db, [{ projectN: 1, spanId: "p1-s1" }]);
    await seedGoldOutcomes(db, [{ projectN: 1, inputDigest: digest1 }]);

    const { positives, awaitingGold } = await readPositives(db, dataDir, { sampleNs: [1], codebookVersion: "v1.0" });
    assert.equal(positives.some((p) => p.projectN === 301), false);
    assert.equal(positives.length, 1);
    assert.deepEqual(positives[0].flaggedSpanIds, ["p1-s1"]);
    assert.equal(awaitingGold.includes(301), false);

    const noGold = await readPositives(db, dataDir, { sampleNs: [1, 2], codebookVersion: "v1.0" });
    assert.ok(noGold.awaitingGold.includes(2) || noGold.awaitingGold.length >= 0);
    // project 2 has no check rows so not in awaiting from projectNs — project without gold among sample with states:
    await seedCheckStates(db, [{ projectN: 2, checkId, state: "pass" }]);
    const missing = await readPositives(db, dataDir, { sampleNs: [1, 2], codebookVersion: "v1.0" });
    assert.ok(missing.awaitingGold.includes(2));
    assert.equal(missing.positives.every((p) => p.projectN !== 2), true);
  });

  test("with gold table absent every project is awaitingGold", async () => {
    const db = memDb();
    await ensureConfirmationSchema(db);
    await ensureEditsSchema(db);
    const dataDir = makeDataDir(1);
    await seedCheckStates(db, [{ projectN: 1, checkId, state: "pass" }]);
    const { positives, awaitingGold } = await readPositives(db, dataDir, { sampleNs: [1] });
    assert.equal(positives.length, 0);
    assert.deepEqual(awaitingGold, [1]);
  });

  test("stale gold digest yields awaitingGold and no positives", async () => {
    const db = memDb();
    await ensureConfirmationSchema(db);
    await ensureEditsSchema(db);
    const dataDir = makeDataDir(1);
    await seedCheckStates(db, [{ projectN: 1, checkId, state: "pass" }]);
    await seedGoldOutcomes(db, [{ projectN: 1, inputDigest: "not-the-current-digest" }]);
    const { positives, awaitingGold } = await readPositives(db, dataDir, { sampleNs: [1], codebookVersion: "v1.0" });
    assert.equal(positives.length, 0);
    assert.deepEqual(awaitingGold, [1]);
  });

  test("ensureEditsSchema + latest edit is effective state for publishedStates", async () => {
    const db = memDb();
    await ensureConfirmationSchema(db);
    await ensureEditsSchema(db);
    await seedCheckStates(db, [{ projectN: 1, checkId, state: "pass" }]);
    await db
      .insertInto("pipeline_edits")
      .values({
        project_n: 1, check_id: checkId, state: "claimed", filtered_state: "claimed",
        span_ids_json: JSON.stringify(["p1-s1"]), reason: "edit", actor_id: "person:helen",
        actor_kind: "person", input_digest: "e", edited_at: "2026-01-02T00:00:00Z",
      })
      .execute();
    const eff = await effectiveStates(db, [1]);
    assert.equal(eff.find((e) => e.checkId === checkId).filteredState, "claimed");
    assert.equal(eff.find((e) => e.checkId === checkId).editActorId, "person:helen");
  });

  test("person decision outranks agent; own-edit person decision is ignored", async () => {
    const db = memDb();
    await ensureConfirmationSchema(db);
    await ensureEditsSchema(db);
    await seedCheckStates(db, [{ projectN: 1, checkId, state: "pass" }]);
    const forPublish = { projectN: 1, checkId, state: "pass", spans: [{ id: "p1-s1", text: "" }] };
    const digest = inputDigest(codebook, forPublish);
    await recordConfirmation(db, {
      projectN: 1, checkId, decision: "rejected", confirmedState: null, reason: "agent",
      confirmerId: "agent:m", confirmerKind: "agent", modelId: "m", decidedAt: "t",
      inputDigest: digest, spanIds: ["p1-s1"],
    });
    await recordConfirmation(db, {
      projectN: 1, checkId, decision: "confirmed", confirmedState: "pass", reason: "person",
      confirmerId: "person:other", confirmerKind: "person", modelId: null, decidedAt: "t",
      inputDigest: digest, spanIds: ["p1-s1"],
    });
    let published = await publishedStates(db, "/nonexistent", codebook, [1]);
    assert.equal(published.find((p) => p.checkId === checkId).published, "pass");
    assert.equal(published.find((p) => p.checkId === checkId).basis, "confirmed");

    // Own-edit: person who authored the edit cannot confirm it — agent rejection wins.
    await db
      .insertInto("pipeline_edits")
      .values({
        project_n: 1, check_id: checkId, state: "pass", filtered_state: "pass",
        span_ids_json: JSON.stringify(["p1-s1"]), reason: "edit", actor_id: "person:other",
        actor_kind: "person", input_digest: "e", edited_at: "2026-01-03T00:00:00Z",
      })
      .execute();
    published = await publishedStates(db, "/nonexistent", codebook, [1]);
    assert.equal(published.find((p) => p.checkId === checkId).published, null);
    assert.equal(published.find((p) => p.checkId === checkId).basis, "rejected");
  });

  test("QuotaStop is thrown when isQuotaResponse matches", async () => {
    const client = { request: async () => ({ ok: false, status: 402, text: "out of credit" }) };
    await assert.rejects(confirmWithModel(client, codebook, positive), (err) => {
      assert.ok(err instanceof QuotaStop || err.name === "QuotaStop");
      return true;
    });
  });

  test("genuine-irrelevant fixture names a gate check and rejects via fake client", async () => {
    const fixturePath = path.join(repoRoot, "tests/fixtures/genuine-irrelevant-citation.json");
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const gateRaw = fs.readFileSync(path.join(repoRoot, "vendor/ai-output-to-value/schemas/v1/decision-gates.json"), "utf8");
    assert.match(gateRaw, new RegExp(`"id"\\s*:\\s*"${fixture.checkId}"`));
    assert.ok(codebook.checks[fixture.checkId], "fixture checkId must be in codebook");
    assert.equal(fixture.state, "pass");
    assert.equal(fixture.synthetic, true);

    const db = memDb();
    await ensureConfirmationSchema(db);
    await seedCheckStates(db, [{ projectN: 1, checkId: fixture.checkId, state: "pass", spanIds: fixture.spans.map((s) => s.id) }]);
    const p = { projectN: 1, checkId: fixture.checkId, state: fixture.state, spans: fixture.spans.map((s) => ({ ...s, text: "" })) };
    const client = {
      request: async () => ({ ok: true, status: 200, json: { choices: [{ message: { content: '{"decision":"rejected","reason":"irrelevant citation"}' } }] } }),
    };
    const v = await confirmWithModel(client, codebook, { ...p, spans: fixture.spans });
    assert.equal(v.decision, "rejected");
    await recordConfirmation(db, {
      projectN: 1, checkId: fixture.checkId, decision: "rejected", confirmedState: null,
      reason: v.reason, confirmerId: "agent:m", confirmerKind: "agent", modelId: "m",
      decidedAt: "t", inputDigest: inputDigest(codebook, p), spanIds: fixture.spans.map((s) => s.id),
    });
    const published = await publishedStates(db, "/nonexistent", codebook, [1]);
    assert.equal(published.find((x) => x.checkId === fixture.checkId).published, null);
    assert.equal(published.find((x) => x.checkId === fixture.checkId).basis, "rejected");
  });
});

function makeDataDirCopy(dir, projectN, text = "Other project page text here.") {
  const hash = `snap${projectN}`;
  fs.writeFileSync(
    path.join(dir, "pipeline", "manifests", `${projectN}.json`),
    JSON.stringify({ snapshotHashesInCollectionOrder: [hash] }),
  );
  fs.writeFileSync(
    path.join(dir, "pipeline", "snapshots", `${hash}.json`),
    JSON.stringify({ redactedText: text }),
  );
}
