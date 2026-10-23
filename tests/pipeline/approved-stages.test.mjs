import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { runApprovedStage, spikeSample } from "../../src/pipeline/validate/approved-stages.ts";
import { confirmWithModel, projectSpans, spansDigest } from "../../src/pipeline/confirm/confirm.ts";
import { loadCodebook } from "../../src/pipeline/coding/codebook-prompt.ts";
import { buildContract, loadGateFile, resolveGatesPath } from "../../src/pipeline/coding/contract.ts";
import { A9_ITEMS, a9Section } from "../../src/pipeline/signoff/a9.ts";
import { ensurePipelineSchema } from "../../src/pipeline/store/results.ts";
import { ensureGoldSchema } from "../../src/pipeline/validate/gold.ts";
import { ARTCRAFT_HN_ID } from "../../src/pipeline/select/draw-sample.ts";

const codebook = loadCodebook("codebook.md");
const contract = buildContract(loadGateFile(resolveGatesPath()).checkIds);
function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-approved-"));
  const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
  fs.mkdirSync(path.join(dataDir, "pipeline", "manifests"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "pipeline", "snapshots"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "decisions"), { recursive: true });
  const docDigest = crypto.createHash("sha256").update(a9Section(fs.readFileSync("protocol/PROTOCOL.md", "utf8"))).digest("hex");
  fs.writeFileSync(path.join(dataDir, "decisions", "signoff.jsonl"), A9_ITEMS.map(item => JSON.stringify({ item, decision: "approved", docDigest })).join("\n"));
  for (const n of [1, 2]) {
    fs.writeFileSync(path.join(dataDir, "pipeline", "manifests", `${n}.json`), JSON.stringify({ hnId: String(n), snapshotHashesInCollectionOrder: [`s${n}`, `s${n}`], snapshots: [{ url: "https://example.test/one" }, { url: "https://example.test/two" }], preserved: "metadata" }));
    fs.writeFileSync(path.join(dataDir, "pipeline", "snapshots", `s${n}.json`), JSON.stringify({ redactedText: "Fixture offers a reproducible command." }));
  }
  return { dataDir, db, codebook, contract, entries: [{ n: 1, hn_id: "1" }, { n: 2, hn_id: "2" }], role: { provider: "ollama", model: "nemotron-3-super", reasoning: "low" } };
}
test("second coding deduplicates exact text, retries invalid replies, resumes successful chunks, preserves primary rows", async () => {
  const f = fixture(); let calls = 0; const lines = [];
  const client = { request: async (_p, { body }) => {
    calls++;
    assert.ok(!body.messages[1].content.includes("p2-"));
    return { ok: true, status: 200, json: { choices: [{ message: { content: calls === 1 ? "{}" : JSON.stringify({ checks: contract.checkIds.map(checkId => ({ checkId, proposedState: "unknown", spanIds: [] })) }) } }] } };
  }, dollarBudget: { budgetLine: () => 'BUDGET: {"spent":0,"cap":0.75}' } };
  const run = () => runApprovedStage({ ...f, stage: "second-coder", client, log: l => lines.push(l) });
  const first = await run(); assert.equal(first.ok, true); assert.equal(calls, 3);
  assert.equal((await f.db.selectFrom("pipeline_check_states").selectAll().execute()).length, 0);
  assert.equal((await f.db.selectFrom("pipeline_second_coder_states").selectAll().execute()).length, 48);
  assert.equal((await run()).ok, true); assert.equal(calls, 3);
  assert.ok(lines.some(l => l.startsWith("BUDGET:")));
  assert.equal(JSON.parse(lines.filter(l => l.startsWith("ACCOUNTING:")).at(-1).slice(12)).success, 2);
  await f.db.destroy();
});
test("budget refusal stops queue and cannot report success", async () => {
  const f = fixture(); let calls = 0; const lines = [];
  const client = { request: async () => { calls++; const e = new Error("approved cap reached"); e.name = "BudgetExceededError"; throw e; }, dollarBudget: { budgetLine: () => "BUDGET: {}" } };
  const result = await runApprovedStage({ ...f, stage: "second-coder", client, log: l => lines.push(l) });
  assert.equal(calls, 1); assert.equal(result.ok, false); assert.equal(result.success, 0); assert.equal(result.stopped, 2);
  assert.equal(result.total, result.accounted + result.stopped);
  assert.ok(lines.some(l => l.startsWith("ACCOUNTING:")));
  await f.db.destroy();
});
test("spike sample is stable and paired confirmation settings send only cited spans", async () => {
  const p = { projectN: 1, checkId: contract.checkIds[0], state: "pass", spans: [{ id: "p1-s1", text: "CITED FIXTURE" }] };
  const positives = Array.from({ length: 40 }, (_, i) => ({ ...p, projectN: i + 1 }));
  assert.deepEqual(spikeSample(positives), spikeSample([...positives].reverse()));
  assert.equal(spikeSample(positives).length, 30);
  const bodies = []; const client = { request: async (_p, { body }) => { bodies.push(body); return { ok: true, status: 200, json: { choices: [{ message: { content: '{"decision":"rejected","reason":"p1-s1 lacks evidence"}' } }] } }; } };
  await confirmWithModel(client, codebook, p, "nemotron-3-ultra", 3, true);
  await confirmWithModel(client, codebook, p, "nemotron-3-ultra", 3, false);
  assert.equal(bodies[0].chat_template_kwargs.enable_thinking, true);
  assert.equal(bodies[1].chat_template_kwargs.enable_thinking, false);
  assert.equal(bodies[1].reasoning_effort, undefined);
  assert.deepEqual(bodies[0].messages, bodies[1].messages);
  assert.ok(bodies[0].messages[1].content.includes("CITED FIXTURE"));
});
test("spike excludes A3 before checking gold locks", async () => {
  const f = fixture(); await ensurePipelineSchema(f.db); await ensureGoldSchema(f.db);
  for (const n of [1, 2]) await f.db.insertInto("pipeline_check_states").values({ project_n: n, check_id: contract.checkIds[0], filtered_state: "pass", proposed_state: "pass", span_ids_json: "[]" }).execute();
  await f.db.insertInto("pipeline_gold_outcomes").values({ project_n: 1, codebook_version: codebook.codebookVersion, labeller_id: "fixture", input_digest: spansDigest(projectSpans(f.dataDir, 1)), outcome: "labelled" }).execute();
  f.entries[1].hn_id = ARTCRAFT_HN_ID;
  const out = await runApprovedStage({ ...f, stage: "spike", role: { ...f.role, model: "nemotron-3-ultra" }, client: { request: async () => { throw new Error("must not request"); } }, log: () => {} });
  assert.match(out.reason, /spike needs 30 positives; available 1/);
  assert.equal(out.ok, false);
  await f.db.destroy();
});
test("two project slots overlap and await both completions", async () => {
  const f = fixture(); let active = 0; let maximum = 0; const ready = Promise.withResolvers();
  const release = Promise.withResolvers(); let calls = 0;
  const client = { request: async () => {
    calls++; active++; maximum = Math.max(maximum, active);
    if (calls === 2) ready.resolve();
    await release.promise; active--;
    return { ok: true, status: 200, json: { choices: [{ message: { content: JSON.stringify({ checks: contract.checkIds.map(checkId => ({ checkId, proposedState: "unknown", spanIds: [] })) }) } }] } };
  } };
  const running = runApprovedStage({ ...f, stage: "second-coder", concurrency: 2, client, log: () => {} });
  await ready.promise;
  assert.equal(active, 2); release.resolve();
  const out = await running;
  assert.equal(maximum, 2); assert.equal(active, 0); assert.equal(out.success, 2); assert.equal(out.ok, true);
  await f.db.destroy();
});
test("cap stop does not schedule queued projects and waits for the other in-flight request", async () => {
  const f = fixture(); f.entries.push({ n: 3, hn_id: "3" });
  const ready = Promise.withResolvers(); const fail = Promise.withResolvers(); const finish = Promise.withResolvers();
  let calls = 0; let returned = false; const lines = [];
  const client = { request: async () => {
    const call = ++calls; if (calls === 2) ready.resolve();
    if (call === 1) { await fail.promise; const error = new Error("cap reached"); error.name = "BudgetExceededError"; throw error; }
    await finish.promise;
    return { ok: true, status: 200, json: { choices: [{ message: { content: JSON.stringify({ checks: contract.checkIds.map(checkId => ({ checkId, proposedState: "unknown", spanIds: [] })) }) } }] } };
  } };
  const running = runApprovedStage({ ...f, stage: "second-coder", concurrency: 2, client, log: line => lines.push(line) }).then(out => { returned = true; return out; });
  await ready.promise; fail.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(returned, false); assert.equal(calls, 2);
  finish.resolve(); const out = await running;
  assert.equal(calls, 2); assert.equal(out.success, 1); assert.equal(out.stopped, 2); assert.equal(out.failed, 0); assert.equal(out.ok, false);
  const printed = JSON.parse(lines.at(-1).slice("ACCOUNTING: ".length));
  assert.equal(printed.accounted + printed.stopped, printed.total);
  await f.db.destroy();
});
