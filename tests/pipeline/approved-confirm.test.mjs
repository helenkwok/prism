import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { runApprovedConfirmation, validateSpikeReview } from "../../src/pipeline/validate/approved-confirm.ts";
import { loadCodebook } from "../../src/pipeline/coding/codebook-prompt.ts";
import { DollarBudget } from "../../src/pipeline/coding/spend-guards.ts";
import { inputDigest, projectSpans, spansDigest } from "../../src/pipeline/confirm/confirm.ts";
import { ensurePipelineSchema } from "../../src/pipeline/store/results.ts";
import { ensureGoldSchema } from "../../src/pipeline/validate/gold.ts";
import { ARTCRAFT_HN_ID } from "../../src/pipeline/select/draw-sample.ts";
const codebook = loadCodebook();
const ids = Object.keys(codebook.checks);
const model = "nemotron-3-ultra:cloud";
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const reply = content => ({ ok: true, status: 200, json: { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }] } });

function makeReview(spike) {
  const text = JSON.stringify(spike);
  return { text, review: { completed: true, model, selectedSetting: false, spikeDigest: hash(text), reviewedDecisions: 60, contractFailures: 0, registeredThresholdBreached: false, supportedBySetting: { on: 30, off: 30 } } };
}
async function fixture({ flagged = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-full-confirm-"));
  const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
  await ensurePipelineSchema(db); await ensureGoldSchema(db);
  for (const dir of ["pipeline/manifests", "pipeline/snapshots", "validation"]) fs.mkdirSync(path.join(dataDir, dir), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "pipeline/snapshots/fixture.json"), JSON.stringify({ redactedText: "Synthetic fixture publishes a reproducible example." }));
  const entries = Array.from({ length: 30 }, (_, i) => ({ n: i + 1, hn_id: String(1000 + i) }));
  const selected = [], decisions = [];
  for (const e of entries) {
    fs.writeFileSync(path.join(dataDir, "pipeline/manifests", `${e.n}.json`), JSON.stringify({ snapshotHashesInCollectionOrder: ["fixture"] }));
    const spans = projectSpans(dataDir, e.n);
    const state = e.n === 3 ? "claimed" : "pass";
    for (const id of ids) await db.insertInto("pipeline_check_states").values({ project_n: e.n, check_id: id, proposed_state: id === ids[0] ? state : "unknown", filtered_state: id === ids[0] ? state : "unknown", span_ids_json: JSON.stringify(id === ids[0] ? spans.map(s => s.id) : []) }).execute();
    await db.insertInto("pipeline_gold_outcomes").values({ project_n: e.n, codebook_version: codebook.codebookVersion, labeller_id: "fixture", input_digest: spansDigest(spans), outcome: "labelled" }).execute();
    if (flagged && e.n === 1) await db.insertInto("pipeline_injection_flags").values({ project_n: e.n, span_id: spans[0].id }).execute();
    const p = { projectN: e.n, checkId: ids[0], state, spans, flaggedSpanIds: flagged && e.n === 1 ? [spans[0].id] : [] };
    selected.push({ projectN: e.n, checkId: ids[0], digest: inputDigest(codebook, p) });
    for (const setting of [true, false]) decisions.push({ ...p, setting, failed: false, decision: "rejected", reason: "Synthetic fixture is insufficient." });
  }
  const spike = { model, completedExperiment: true, stopped: null, selected, decisions };
  const { text, review } = makeReview(spike);
  fs.writeFileSync(path.join(dataDir, "validation/confirmation-spike.json"), text);
  fs.writeFileSync(path.join(dataDir, "validation/confirmation-spike-review.json"), JSON.stringify(review));
  const lines = [];
  return { dataDir, db, codebook, entries, goldOrder: entries.map(e => e.hn_id), model, reasoning: false, log: line => lines.push(line), lines, spike, review, text };
}
const client = request => ({ request, dollarBudget: new DollarBudget(5) });

test("review guard binds exact bytes, setting, thirty identical pairs and sixty reviewed outcomes", () => {
  const decisions = Array.from({ length: 30 }, (_, n) => [true, false].map(setting => ({ projectN: n, checkId: ids[0], state: "pass", setting, decision: "rejected", spans: [], flaggedSpanIds: [] }))).flat();
  const spike = { model, completedExperiment: true, selected: Array.from({ length: 30 }, (_, n) => ({ projectN: n, checkId: ids[0], digest: "a".repeat(64) })), decisions };
  const { text, review } = makeReview(spike);
  assert.doesNotThrow(() => validateSpikeReview(review, text, { model, reasoning: false }));
  for (const edit of [{ spikeDigest: "b".repeat(64) }, { reviewedDecisions: 59 }, { selectedSetting: true }, { contractFailures: 1 }, { registeredThresholdBreached: true }]) assert.throws(() => validateSpikeReview({ ...review, ...edit }, text, { model, reasoning: false }));
  assert.throws(() => validateSpikeReview(review, text + "\n", { model, reasoning: false }));
  spike.decisions[1].spans = [{ id: "p1-s1", text: "different fixture" }];
  const changed = makeReview(spike);
  assert.throws(() => validateSpikeReview(changed.review, changed.text, { model, reasoning: false }), /identical/);
});

test("invalid spike outcomes remain in denominator without an invented zero-error threshold", () => {
  const decisions = Array.from({ length: 30 }, (_, n) => [true, false].map(setting => ({ projectN: n, checkId: ids[0], state: "pass", setting, failed: n > 0 || setting, decision: n === 0 && !setting ? "rejected" : null, spans: [] }))).flat();
  const spike = { model, completedExperiment: true, selected: Array.from({ length: 30 }, (_, n) => ({ projectN: n, checkId: ids[0], digest: "a".repeat(64) })), decisions };
  const { text, review } = makeReview(spike);
  review.supportedBySetting = { on: 0, off: 1 };
  assert.doesNotThrow(() => validateSpikeReview(review, text, { model, reasoning: false }));
  assert.throws(() => validateSpikeReview({ ...review, selectedSetting: true }, text, { model, reasoning: true }), /no valid/);
});

test("full confirmation writes decisions immediately and resumes all valid current rows without HTTP", async () => {
  const f = await fixture(); let calls = 0;
  const c = client(async (_path, { body }) => {
    calls++; assert.equal(body.chat_template_kwargs.enable_thinking, false);
    assert.ok(!body.messages[1].content.includes("p2-"));
    if (calls > 1) assert.equal((await f.db.selectFrom("pipeline_confirmations").selectAll().execute()).length, calls - 1);
    return reply({ decision: calls === 1 ? "confirmed" : calls === 2 ? "downgraded" : "rejected", reason: "p1-s001 is synthetic fixture evidence." });
  });
  const first = await runApprovedConfirmation({ ...f, client: c });
  assert.equal(first.ok, true); assert.equal(first.valid, 30); assert.equal(first.remaining, 0); assert.equal(first.downgraded, 1);
  const second = await runApprovedConfirmation({ ...f, client: client(async () => { throw new Error("unexpected request"); }) });
  assert.equal(second.ok, true); assert.equal(second.cached, 30); assert.equal(second.attempted, 0); assert.equal(calls, 30);
  const final = JSON.parse(f.lines.filter(line => line.startsWith("CONFIRMATION:")).at(-1).slice(14));
  assert.equal(final.valid, 30); assert.equal(final.complete, true);
  assert.ok(f.lines.some(line => line.startsWith("BUDGET:"))); assert.ok(f.lines.some(line => line.startsWith("ACCOUNTING:")));
  await f.db.destroy();
});

test("all invalid decisions stop after three attempts and never report complete", async () => {
  const f = await fixture(); let calls = 0;
  const out = await runApprovedConfirmation({ ...f, client: client(async () => { calls++; return reply({ invalid: true }); }) });
  assert.equal(calls, 3); assert.equal(out.ok, false); assert.equal(out.failed, 1); assert.equal(out.valid, 0); assert.equal(out.stopped, 29); assert.equal(out.remaining, 30);
  assert.equal((await f.db.selectFrom("pipeline_confirmations").selectAll().execute()).length, 0);
  await f.db.destroy();
});

test("quota stop preserves the successful prefix and leaves the rest unaccounted", async () => {
  const f = await fixture(); let calls = 0;
  const out = await runApprovedConfirmation({ ...f, client: client(async () => {
    if (++calls === 1) return reply({ decision: "rejected", reason: "p1-s001 lacks the required fixture." });
    const error = new Error("fixture cap"); error.name = "BudgetExceededError"; throw error;
  }) });
  assert.equal(calls, 2); assert.equal(out.valid, 1); assert.equal(out.failed, 0); assert.equal(out.stopped, 29); assert.equal(out.remaining, 29); assert.equal(out.ok, false);
  assert.equal((await f.db.selectFrom("pipeline_confirmations").selectAll().execute()).length, 1);
  await f.db.destroy();
});

test("flagged citations cannot be confirmed or downgraded", async () => {
  const f = await fixture({ flagged: true }); let calls = 0;
  const out = await runApprovedConfirmation({ ...f, client: client(async () => { calls++; return reply({ decision: "confirmed", reason: "p1-s001 synthetic fixture." }); }) });
  assert.equal(calls, 3); assert.equal(out.flagged, 1); assert.equal(out.valid, 0); assert.equal(out.ok, false); assert.equal(out.reason, "FlaggedRuleError");
  await f.db.destroy();
});

test("claimed state cannot be downgraded", async () => {
  const f = await fixture(); let calls = 0;
  const out = await runApprovedConfirmation({ ...f, client: client(async (_path, { body }) => {
    calls++;
    return reply({ decision: body.messages[0].content.includes("proposed (claimed)") ? "downgraded" : "rejected", reason: "p1-s001 synthetic fixture." });
  }) });
  assert.equal(calls, 5); assert.equal(out.valid, 2); assert.equal(out.failed, 1); assert.equal(out.ok, false);
  await f.db.destroy();
});

test("stale reviewed inputs and incomplete gold lock refuse before requests", async () => {
  const f = await fixture(); let calls = 0;
  const c = client(async () => { calls++; throw new Error("unexpected request"); });
  await f.db.updateTable("pipeline_check_states").set({ filtered_state: "claimed" }).where("project_n", "=", 1).where("check_id", "=", ids[0]).execute();
  let out = await runApprovedConfirmation({ ...f, client: c });
  assert.equal(out.reason, "reviewed-spike-inputs-stale"); assert.equal(calls, 0);
  await f.db.deleteFrom("pipeline_gold_outcomes").where("project_n", "=", 2).execute();
  out = await runApprovedConfirmation({ ...f, client: c });
  assert.equal(out.reason, "gold-lock-incomplete"); assert.equal(calls, 0); assert.equal(out.awaitingGold, 1);
  await f.db.destroy();
});

test("excluded worked case stays outside the full confirmation denominator", async () => {
  const f = await fixture(); let calls = 0;
  const out = await runApprovedConfirmation({ ...f, entries: [...f.entries, { n: 31, hn_id: ARTCRAFT_HN_ID }], client: client(async () => { calls++; return reply({ decision: "rejected", reason: "p1-s001 is insufficient." }); }) });
  assert.equal(out.excludedA3, 1); assert.equal(out.total, 30); assert.equal(calls, 30); assert.equal(out.ok, true);
  await f.db.destroy();
});

test("full stage refuses an oversized budget before any requests", async () => {
  const f = await fixture(); let calls = 0;
  await assert.rejects(() => runApprovedConfirmation({ ...f, client: { dollarBudget: new DollarBudget(6), request: async () => { calls++; } } }), /approved budget/);
  assert.equal(calls, 0);
  await f.db.destroy();
});

test("new citation flags invalidate the reviewed spike before requests", async () => {
  const f = await fixture(); let calls = 0;
  const id = projectSpans(f.dataDir, 1)[0].id;
  await f.db.insertInto("pipeline_injection_flags").values({ project_n: 1, span_id: id }).execute();
  const out = await runApprovedConfirmation({ ...f, client: client(async () => { calls++; }) });
  assert.equal(out.reason, "reviewed-spike-inputs-stale"); assert.equal(calls, 0); assert.equal(out.ok, false);
  await f.db.destroy();
});
