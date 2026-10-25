import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { runApprovedConfirmation, validateSpikeReview, verifiedConfirmationCorrections } from "../../src/pipeline/validate/approved-confirm.ts";
import { loadCodebook } from "../../src/pipeline/coding/codebook-prompt.ts";
import { DollarBudget, estimateMessagesTokens } from "../../src/pipeline/coding/spend-guards.ts";
import { confirmMessages, inputDigest, projectSpans, spansDigest } from "../../src/pipeline/confirm/confirm.ts";
import { createRollingProjection } from "../../src/pipeline/validate/rolling-projection.ts";
import { APPROVED_CAPS } from "../../src/pipeline/validate/approved-budget.ts";
import { ensurePipelineSchema } from "../../src/pipeline/store/results.ts";
import { ensureGoldSchema } from "../../src/pipeline/validate/gold.ts";
import { buildContract } from "../../src/pipeline/coding/contract.ts";
import { PINNED_MODEL } from "../../src/pipeline/coding/nebius-client.ts";
import { SIGNOFF_MODEL } from "../../src/pipeline/signoff/signoff.ts";
import { buildCodingMessages, chunkSpans } from "../../src/pipeline/run.ts";
import { a7Section } from "../../src/pipeline/validate/gold.ts";
import { a9Section, A9_ITEMS } from "../../src/pipeline/signoff/a9.ts";
import { SAMPLING_SEED, QUARTER_STARTS } from "../../src/pipeline/select/draw-sample.ts";
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
  return { dataDir, db, codebook, entries, goldOrder: entries.map(e => e.hn_id), model, reasoning: false, concurrency: 1, log: line => lines.push(line), lines, spike, review, text };
}
const client = request => ({ request, dollarBudget: new DollarBudget(APPROVED_CAPS["full-confirm"]) });

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
  await assert.rejects(() => runApprovedConfirmation({ ...f, client: { dollarBudget: new DollarBudget(7.51), request: async () => { calls++; } } }), /approved.*budget/);
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

test("the default two slots overlap, await completion, and resume current rows without HTTP", async () => {
  const f = await fixture(); const ready = Promise.withResolvers(); const release = Promise.withResolvers();
  let calls = 0; let active = 0; let maximum = 0; let returned = false;
  const c = client(async () => {
    const call = ++calls; active++; maximum = Math.max(maximum, active);
    if (call === 2) ready.resolve();
    if (call <= 2) await release.promise;
    else await new Promise(resolve => setImmediate(resolve));
    active--;
    return reply({ decision: "rejected", reason: "p1-s001 is insufficient synthetic evidence." });
  });
  const running = runApprovedConfirmation({ ...f, concurrency: undefined, client: c }).then(out => { returned = true; return out; });
  await ready.promise; assert.equal(active, 2); assert.equal(returned, false); release.resolve();
  const out = await running;
  assert.equal(maximum, 2); assert.equal(active, 0); assert.equal(out.valid, 30); assert.equal(out.attempted, 30); assert.equal(out.ok, true);
  const resumed = await runApprovedConfirmation({ ...f, concurrency: 2, client: client(async () => { calls++; throw new Error("unexpected HTTP"); }) });
  assert.equal(resumed.cached, 30); assert.equal(resumed.attempted, 0); assert.equal(calls, 30);
  await f.db.destroy();
});

test("a cap stops the queue before job three while an in-flight valid result is retained", async () => {
  const f = await fixture(); const ready = Promise.withResolvers(); const fail = Promise.withResolvers(); const finish = Promise.withResolvers();
  let calls = 0; let returned = false;
  const c = client(async () => {
    const call = ++calls; if (call === 2) ready.resolve();
    if (call === 1) { await fail.promise; const error = new Error("fixture cap"); error.name = "BudgetExceededError"; throw error; }
    await finish.promise;
    return reply({ decision: "confirmed", reason: "p1-s001 supplies synthetic evidence." });
  });
  const running = runApprovedConfirmation({ ...f, concurrency: 2, client: c }).then(out => { returned = true; return out; });
  await ready.promise; fail.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(returned, false); assert.equal(calls, 2);
  finish.resolve(); const out = await running;
  assert.equal(calls, 2); assert.equal(out.valid, 1); assert.equal(out.accounted, 1); assert.equal(out.stopped, 29); assert.equal(out.failed, 0); assert.equal(out.ok, false);
  const rows = await f.db.selectFrom("pipeline_confirmations").selectAll().execute();
  assert.equal(rows.length, 1); assert.equal(rows[0].project_n, 2); assert.equal(rows[0].decision, "confirmed");
  assert.equal(rows[0].confirmer_id, "agent:ollama:nemotron-3-ultra:thinking-off");
  const accounting = JSON.parse(f.lines.at(-1).slice("ACCOUNTING: ".length));
  assert.equal(accounting.accounted + accounting.stopped, accounting.total); assert.equal(accounting.valid, 1);
  await f.db.destroy();
});

test("a stop also prevents another model retry by the in-flight job", async () => {
  const f = await fixture(); const ready = Promise.withResolvers(); const fail = Promise.withResolvers(); const invalid = Promise.withResolvers(); let calls = 0;
  const c = client(async () => {
    const call = ++calls; if (call === 2) ready.resolve();
    if (call === 1) { await fail.promise; const error = new Error("fixture quota"); error.name = "QuotaStop"; throw error; }
    await invalid.promise; return reply({ invalid: true });
  });
  const running = runApprovedConfirmation({ ...f, concurrency: 2, client: c });
  await ready.promise; fail.resolve(); await new Promise(resolve => setImmediate(resolve)); invalid.resolve();
  const out = await running;
  assert.equal(calls, 2); assert.equal(out.failed, 0); assert.equal(out.valid, 0); assert.equal(out.stopped, 30); assert.equal(out.reason, "QuotaStop");
  await f.db.destroy();
});

test("pool size is restricted to one or two before requests", async () => {
  const f = await fixture(); let calls = 0;
  for (const concurrency of [0, 3, 1.5]) await assert.rejects(runApprovedConfirmation({ ...f, concurrency, client: client(async () => { calls++; }) }), /concurrency must be 1–2/);
  assert.equal(calls, 0); await f.db.destroy();
});

function projection(f, onCheckpoint) {
  const remainingPrompts = f.spike.selected.map(row => {
    const p = f.spike.decisions.find(p => p.projectN === row.projectN && p.checkId === row.checkId);
    return { projectN: p.projectN, checkId: p.checkId, estimatedInputTokens: estimateMessagesTokens(confirmMessages(codebook, p)) };
  });
  return createRollingProjection({ stage: "full-confirm", provider: "ollama", model, thinking: true, total: remainingPrompts.length, completed: 0, remaining: remainingPrompts.length, cap: APPROVED_CAPS["full-confirm"], completedUsage: { requests: 0, inputTokens: 0, outputTokens: 0, estimatedInputTokens: 0, spentUsd: 0 }, remainingPromptTokens: remainingPrompts.reduce((sum, p) => sum + p.estimatedInputTokens, 0), remainingPrompts }, { onCheckpoint });
}
const measuredReply = (inputTokens = 100, outputTokens = 10) => ({ ...reply({ decision: "rejected", reason: "p1-s001 is insufficient fixture evidence." }), json: { ...reply({ decision: "rejected", reason: "p1-s001 is insufficient fixture evidence." }).json, usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens } } });

test("rolling projection stops after saving a valid decision without counting it as failed", async () => {
  const f = await fixture(); const reports = []; const tracker = projection(f, report => reports.push(report)); let calls = 0;
  const out = await runApprovedConfirmation({ ...f, projectionTracker: tracker, client: client(async () => { calls++; return measuredReply(100, 100_000); }) });
  assert.equal(calls, 1); assert.equal(out.valid, 1); assert.equal(out.failed, 0); assert.equal(out.accounted, 1); assert.equal(out.stopped, 29); assert.equal(out.reason, "ProjectedBudgetExceededError");
  assert.equal((await f.db.selectFrom("pipeline_confirmations").selectAll().execute()).length, 1); assert.equal(tracker.snapshot().completed, 1); assert.ok(reports.some(report => report.projectedTotalUsd > 7));
  await f.db.destroy();
});

test("missing usage and persistence hook errors stop after preserving valid decisions", async () => {
  for (const hookFailure of [false, true]) {
    const f = await fixture(); const tracker = projection(f, hookFailure ? () => { throw new Error("fixture checkpoint failure"); } : undefined);
    let calls = 0;
    const out = await runApprovedConfirmation({ ...f, projectionTracker: tracker, client: client(async () => { calls++; return hookFailure ? measuredReply(100, 100_000) : reply({ decision: "rejected", reason: "p1-s001 synthetic fixture." }); }) });
    assert.equal(calls, 1); assert.equal(out.valid, 1); assert.equal(out.failed, 0); assert.equal(out.ok, false);
    assert.equal((await f.db.selectFrom("pipeline_confirmations").selectAll().execute()).length, 1);
    await f.db.destroy();
  }
});

test("a below-cap rolling projection continues and finalizes all valid outcomes", async () => {
  const f = await fixture(); const reports = []; const tracker = projection(f, report => reports.push(report));
  const out = await runApprovedConfirmation({ ...f, projectionTracker: tracker, client: client(async () => measuredReply()) });
  assert.equal(out.ok, true); assert.equal(out.valid, 30); assert.equal(tracker.snapshot().completed, 30); assert.equal(tracker.snapshot().remaining, 0);
  assert.equal(reports.length, 2); assert.equal(reports[0].checkpointReason, "twenty-completed"); assert.equal(reports[1].checkpointReason, "final");
  await f.db.destroy();
});

test("rolling attribution includes internal HTTP attempts without duplicating the final usage", async () => {
  const f = await fixture(); const tracker = projection(f); let calls = 0;
  const c = client(async () => {
    calls++; const response = measuredReply(100, 10);
    response.json.usage_attempts = [{ prompt_tokens: 80, completion_tokens: 20 }, response.json.usage];
    return response;
  });
  const out = await runApprovedConfirmation({ ...f, projectionTracker: tracker, client: c });
  assert.equal(out.ok, true); assert.equal(calls, 30);
  assert.equal(tracker.snapshot().completedUsage.requests, 60); assert.equal(tracker.snapshot().completedUsage.inputTokens, 5400); assert.equal(tracker.snapshot().completedUsage.outputTokens, 900);
  await f.db.destroy();
});

// Synthetic complete retained samples exercise the full proof chain.
const correctionBook = loadCodebook();
const jsonHash = value => hash(JSON.stringify(value));
async function correctionFixture(t) {
  const id = ids[0], codebook = { ...correctionBook, checks: { [ids[0]]: correctionBook.checks[ids[0]] } };
  const at = "2026-10-24T01:00:00.000Z";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-revalidation-proof-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
  t.after(() => db.destroy()); await ensurePipelineSchema(db); await ensureGoldSchema(db);
  const file = name => path.join(dataDir, name);
  const write = (name, value) => { fs.mkdirSync(path.dirname(file(name)), { recursive: true }); fs.writeFileSync(file(name), JSON.stringify(value)); };
  const guidance = { version: "c1", checks: { [id]: "Synthetic fixed clarification." } };
  const doc = JSON.stringify(guidance), context = "Synthetic complete rule context.", item = "Codebook correction c1";
  const approved = { item, decision: "approved", docDigest: hash(doc), inputDigest: jsonHash({ doc, context, item }), decidedAt: "2026-10-24T00:00:00.000Z", reviewer: { id: `agent:${SIGNOFF_MODEL}`, kind: "agent", modelId: SIGNOFF_MODEL } };
  write("validation/guidance.json", guidance); write("validation/proposal.json", { doc, context, item });
  fs.mkdirSync(file("decisions")); fs.writeFileSync(file("decisions/release-signoff.jsonl"), JSON.stringify(approved) + "\n");
  const previousEntries = Array.from({ length: 300 }, (_, i) => ({ n: i + 1, hn_id: String(i + 1001), quarter: Math.floor(i / 75) + 1, created_at: QUARTER_STARTS[Math.floor(i / 75)] + "T00:00:00Z", final_url: "https://example.test/" }));
  const entries = Array.from({ length: 76 }, (_, i) => ({ n: i + 301, hn_id: String(i + 2001), quarter: Math.floor(i / 19) + 1, created_at: QUARTER_STARTS[Math.floor(i / 19)] + "T00:00:00Z", final_url: "https://example.test/" }));
  const source = { posts: entries.map(e => ({ id: e.hn_id, created_at: e.created_at })), previousEntries, previousLog: [] };
  write("validation/sampling-source.json", source); write("pipeline/fresh-projects.json", entries);
  write("pipeline/fresh-validation-sample.json", { version: 1, seed: SAMPLING_SEED, perQuarter: 19, entriesDigest: jsonHash(entries), sourceDigest: jsonHash({ seed: SAMPLING_SEED, perQuarter: 19, ...source }) });
  const text = "Synthetic test evidence.", sourceHash = hash(text);
  write(`pipeline/snapshots/${sourceHash}.json`, { redactedText: text });
  const schema = buildContract([id]).jsonSchema;
  const runtime = { version: guidance.version, byCheck: guidance.checks };
  for (const e of [...previousEntries, ...entries]) {
    write(`pipeline/manifests/${e.n}.json`, { hnId: e.hn_id, snapshotHashesInCollectionOrder: [sourceHash], codingCorrection: { version: "c1", checks: [id] } });
    const spans = projectSpans(dataDir, e.n), digest = spansDigest(spans);
    const prompt = jsonHash({ schema, guidance: runtime, messages: chunkSpans(spans).map(chunk => buildCodingMessages([id], codebook, schema, chunk, runtime)) });
    await db.insertInto("pipeline_project_results").values({ project_n: e.n, hn_id: e.hn_id, model_id: PINNED_MODEL, codebook_version: codebook.codebookVersion, completed_at: at, snapshot_hashes_json: JSON.stringify([sourceHash]), prompt_hash: prompt, coding_all_unknown: 0 }).execute();
    if (e.n <= 300) continue;
    const state = e.n <= 312 ? "pass" : "unknown", citations = state === "pass" ? '["p1-s001"]' : "[]";
    await db.insertInto("pipeline_check_states").values({ project_n: e.n, check_id: id, proposed_state: state, filtered_state: state, span_ids_json: citations }).execute();
    await db.insertInto("pipeline_gold_outcomes").values({ project_n: e.n, codebook_version: codebook.codebookVersion, labeller_id: "agent:ollama:glm-5.3-flash:cloud", input_digest: digest, outcome: "labelled", decided_at: at }).execute();
    await db.insertInto("pipeline_gold_labels").values({ project_n: e.n, check_id: id, codebook_version: codebook.codebookVersion, labeller_id: "agent:ollama:glm-5.3-flash:cloud", provider: "ollama", model_id: "glm-5.3-flash:cloud", reasoning: "low", filtered_state: state, span_ids_json: citations, input_digest: digest, labelled_at: at }).execute();
  }
  return { db, dataDir, codebook, checkIds: [id], sampleNs: previousEntries.map(e => e.n), freshNs: entries.map(e => e.n), cutoff: Date.parse("2026-10-23T00:00:00Z"),
    proof: { guidancePath: file("validation/guidance.json"), proposalPath: file("validation/proposal.json"), samplingSourcePath: file("validation/sampling-source.json"), signoffPath: file("decisions/release-signoff.jsonl") },
    write, file, approved };
}

function confirmationReleaseFixture(dataDir) {
  const cutoff = "2026-10-23T02:00:30.401Z";
  for (const dir of ["validation", "decisions"]) fs.mkdirSync(path.join(dataDir, dir), { recursive: true });
  const protocolPath = path.join(dataDir, "PROTOCOL.md");
  const protocol = "# Synthetic protocol\n\n## Addendum 2026-10-20 (A7)\n\nSynthetic rules.\n\n## Addendum 2026-10-21 (A9)\n\nSynthetic recovery rules.\n";
  fs.writeFileSync(protocolPath, protocol);
  const a7 = a7Section(protocol); const a9Digest = hash(a9Section(protocol));
  const a7Path = "decisions/a7.md"; fs.writeFileSync(path.join(dataDir, a7Path), a7);
  const logPath = "validation/approved-signoff.log";
  const log = A9_ITEMS.map(item => `SIGNOFF: ${JSON.stringify({ item, decision: "approved", digest: a9Digest })}`).join("\n") + '\nACCOUNTING: {"stage":"signoff","total":6,"success":6,"ok":true,"complete":true}\n';
  fs.writeFileSync(path.join(dataDir, logPath), log); fs.utimesSync(path.join(dataDir, logPath), new Date(cutoff), new Date(cutoff));
  const bulkPath = "validation/04-05b-final-verification.json";
  const bulk = { priorStages: [
    { stage: "signoff", total: 6, success: 6, ok: true, complete: true },
    { stage: "recode", total: 300, accounted: 300, success: 300, failed: 0, stopped: 0, ok: true, complete: true },
    { stage: "gold", total: 300, accounted: 300, success: 299, labelled: 299, noGold: 1, failed: 1, stopped: 0, ok: true, complete: true, allDecisionsValid: false },
  ], fullConfirmation: { total: 1700, accounted: 1700, valid: 1700, failed: 0, remaining: 0, stopped: 0, complete: true, verifiedLedger: true, verifiedPrintedLines: true, stageSpent: 6, stageCap: 7.5, stageReserved: 0, hostSpent: 10, hostCap: 13.25, hostReserved: 0 } };
  fs.writeFileSync(path.join(dataDir, bulkPath), JSON.stringify(bulk));
  const auditPath = "decisions/screening-audit-action.md"; const audit = "Synthetic retained selection-limitation action.\n"; fs.writeFileSync(path.join(dataDir, auditPath), audit);
  const proof = { version: 1, basis: "retained-completion-and-user-attestation", a7: { documentPath: a7Path, docDigest: hash(a7), attestedItem: "A7.10 Screening audit", decision: "approved", decidedAt: "2026-10-20T09:03:55.710Z" }, a9: { logPath, logDigest: hash(log), cutoffUpperBound: cutoff }, priorBulk: { filePath: bulkPath, fileDigest: hash(JSON.stringify(bulk)) }, screeningAudit: { documentPath: auditPath, docDigest: hash(audit), item: "Screening audit action (A7.10)", decision: "approved", decidedAt: "2026-10-21T01:16:15.407Z", source: "user-verified-signature" } };
  const proofPath = path.join(dataDir, "validation/release-proof.json");
  const save = () => fs.writeFileSync(proofPath, JSON.stringify(proof)); save();
  const updateLog = text => { fs.writeFileSync(path.join(dataDir, logPath), text); fs.utimesSync(path.join(dataDir, logPath), new Date(cutoff), new Date(cutoff)); proof.a9.logDigest = hash(text); save(); };
  const updateBulk = () => { const text = JSON.stringify(bulk); fs.writeFileSync(path.join(dataDir, bulkPath), text); proof.priorBulk.fileDigest = hash(text); save(); };
  return { dataDir, proofPath, protocolPath, proof, bulk, log, save, updateLog, updateBulk };
}

test("correction proof rejects invented configuration and sample substitutions before any request", async t => {
  const f = await fixture(); t.after(() => f.db.destroy());
  const proofPath = path.join(f.dataDir, "validation/revalidation-proof.json");
  fs.writeFileSync(proofPath, JSON.stringify({ appliedCheckIds: [ids[0]] }));
  await assert.rejects(verifiedConfirmationCorrections({ ...f, correctionProof: { priorApprovalProofPath: proofPath, protocolPath: "protocol/PROTOCOL.md", revalidationProofPath: proofPath } }), /invalid confirmation correction proof configuration/);
});

test("verified applied correction can replace a historical positive without rewriting the experiment", async t => {
  const f = await correctionFixture(t), release = confirmationReleaseFixture(f.dataDir);
  const previousEntries = JSON.parse(fs.readFileSync(f.proof.samplingSourcePath)).previousEntries;
  const selected = [], decisions = [];
  for (const e of previousEntries) {
    const spans = projectSpans(f.dataDir, e.n), state = e.n <= 30 ? "claimed" : "unknown";
    await f.db.insertInto("pipeline_check_states").values({ project_n: e.n, check_id: ids[0], proposed_state: state, filtered_state: state, span_ids_json: JSON.stringify(state === "unknown" ? [] : spans.map(s => s.id)) }).execute();
    await f.db.insertInto("pipeline_gold_outcomes").values({ project_n: e.n, codebook_version: f.codebook.codebookVersion, labeller_id: "fixture", input_digest: spansDigest(spans), outcome: "labelled" }).execute();
    if (e.n > 30) continue;
    const historical = { projectN: e.n, checkId: ids[0], state: "pass", spans, flaggedSpanIds: [] };
    selected.push({ projectN: e.n, checkId: ids[0], digest: inputDigest(f.codebook, historical) });
    for (const setting of [true, false]) decisions.push({ ...historical, setting, decision: "rejected", failed: false });
  }
  const spike = { model, completedExperiment: true, stopped: null, selected, decisions };
  const { text, review } = makeReview(spike); review.selectedSetting = true;
  fs.writeFileSync(path.join(f.dataDir, "validation/confirmation-spike.json"), text);
  fs.writeFileSync(path.join(f.dataDir, "validation/confirmation-spike-review.json"), JSON.stringify(review));
  const proofPath = path.join(f.dataDir, "validation/revalidation-proof.json");
  fs.writeFileSync(proofPath, JSON.stringify(f.proof));
  const correctionProof = { priorApprovalProofPath: release.proofPath, protocolPath: release.protocolPath, revalidationProofPath: proofPath };
  const options = { ...f, entries: previousEntries, model, reasoning: true, goldOrder: previousEntries.map(e => e.hn_id), concurrency: 1, log() {} };
  let calls = 0;
  const c = client(async () => { calls++; return reply({ decision: "rejected", reason: "p1-s001 does not support the claim." }); });
  const ordinary = await runApprovedConfirmation({ ...options, client: c });
  assert.equal(ordinary.reason, "reviewed-spike-inputs-stale"); assert.equal(calls, 0);
  const verified = await verifiedConfirmationCorrections({ ...options, correctionProof });
  assert.deepEqual([...verified.checkIds], [ids[0]]); assert.match(verified.evidence.configurationDigest, /^[a-f0-9]{64}$/);
  await assert.rejects(verifiedConfirmationCorrections({ ...options, entries: [...previousEntries.slice(0, 299), { ...previousEntries[299], hn_id: "substituted" }], correctionProof }), /sample identity/);
  const result = await runApprovedConfirmation({ ...options, correctionProof, client: c });
  assert.equal(result.ok, true); assert.equal(result.valid, 30); assert.equal(calls, 30);
  assert.equal(fs.readFileSync(path.join(f.dataDir, "validation/confirmation-spike.json"), "utf8"), text);
  await f.db.updateTable("pipeline_check_states").set({ proposed_state: "unknown", filtered_state: "unknown", span_ids_json: "[]" }).where("project_n", "=", 1).execute();
  const removed = await runApprovedConfirmation({ ...options, correctionProof, client: c });
  assert.equal(removed.ok, true); assert.equal(removed.cached, 29); assert.equal(calls, 30);
  await f.db.insertInto("pipeline_injection_flags").values({ project_n: 2, span_id: "p1-s001" }).execute();
  const flagged = await runApprovedConfirmation({ ...options, correctionProof, client: c });
  assert.equal(flagged.reason, "reviewed-spike-inputs-stale"); assert.equal(calls, 30);
  await f.db.deleteFrom("pipeline_injection_flags").execute();
  await f.db.updateTable("pipeline_project_results").set({ prompt_hash: "stale" }).where("project_n", "=", 300).execute();
  const stale = await runApprovedConfirmation({ ...options, correctionProof, client: c });
  assert.equal(stale.reason, "reviewed-spike-inputs-stale"); assert.equal(calls, 30);
});
