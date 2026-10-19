// A2: role-neutral confirmation records, bound to the digest of the input they judged.

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
  confirmWithModel,
  ensureConfirmationSchema,
  inputDigest,
  recordConfirmation,
} from "../../src/pipeline/confirm/confirm.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const codebook = loadCodebook(path.join(repoRoot, "codebook.md"));
const checkId = Object.keys(codebook.checks)[0];
const positive = { projectN: 1, checkId, state: "pass", spans: [{ id: "p1-s1", text: "We publish a status page." }] };

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
    const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
    await ensureConfirmationSchema(db);
    const base = { projectN: 1, checkId, reason: "p1-s1 shows it", confirmerKind: "agent", modelId: "m", decidedAt: "t", inputDigest: "d", spanIds: ["p1-s1"] };
    await recordConfirmation(db, { ...base, decision: "rejected", confirmerId: "agent:m" });
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
