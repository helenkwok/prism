import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createScreeningClient, openScreeningBudget, prewarmSample, runSampleCli } from "../../src/pipeline/select/draw-sample.ts";
import { DollarBudget, estimateCostUsd } from "../../src/pipeline/coding/spend-guards.ts";
import { SCREENER_MODEL } from "../../src/pipeline/select/screen-model.ts";
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "prism-screening-budget-"));
const body = (content = "Synthetic candidate") => ({ model: SCREENER_MODEL, messages: [{ role: "user", content }], max_tokens: 256 });

test("the fixed screening model has explicit input and output prices", () => {
  assert.ok(Math.abs(estimateCostUsd(SCREENER_MODEL, 1e6, 1e6) - .30) < 1e-12);
});

test("screening spend and unresolved reservations survive resume without changing the cap", () => {
  const dataDir = dir(); const scope = "a".repeat(64);
  let opened = openScreeningBudget({ dataDir, scope, cap: .01 });
  opened.budget.reserve(.004); opened.budget.settle(.004, .002); opened.budget.reserve(.001); opened.release();
  opened = openScreeningBudget({ dataDir, scope, cap: .01 });
  assert.ok(Math.abs(opened.budget.spent - .003) < 1e-12); assert.equal(opened.budget.reserved, 0);
  assert.throws(() => opened.budget.reserve(.008), /budget exceeded/); opened.release();
  assert.throws(() => openScreeningBudget({ dataDir, scope, cap: .02 }), /retained cap/);
});

test("reservations are saved before fake HTTP and a live owner prevents a second run", async () => {
  const dataDir = dir(); const scope = "b".repeat(64); const opened = openScreeningBudget({ dataDir, scope, cap: .1 });
  assert.throws(() => openScreeningBudget({ dataDir, scope, cap: .1 }), /active|EEXIST/);
  let calls = 0;
  const client = createScreeningClient({ budget: opened.budget, apiKey: "fixture", fetchImpl: async () => {
    calls++; assert.ok(JSON.parse(fs.readFileSync(opened.file, "utf8")).reserved > 0);
    return new Response(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [{ message: { content: '{"include":true,"reasonCode":null}' } }] }), { status: 200 });
  } });
  await client.request("/chat/completions", { method: "POST", body: body() });
  assert.equal(calls, 1); assert.ok(opened.budget.spent > 0); opened.release();
});

test("cap, input size and unpinned models refuse before HTTP", async () => {
  let calls = 0; const fetchImpl = async () => { calls++; throw new Error("unexpected HTTP"); };
  const client = createScreeningClient({ budget: new DollarBudget(.000001), apiKey: "fixture", fetchImpl });
  await assert.rejects(client.request("/chat/completions", { method: "POST", body: body() }), /budget exceeded/);
  const large = createScreeningClient({ budget: new DollarBudget(1), apiKey: "fixture", fetchImpl });
  await assert.rejects(large.request("/chat/completions", { method: "POST", body: body("x".repeat(100000)) }), e => e.name === "TooLargeError");
  await assert.rejects(large.request("/chat/completions", { method: "POST", body: { ...body(), model: "unknown-fixture" } }), /pinned/);
  assert.equal(calls, 0);
});

test("quota responses stop after exactly one fake HTTP attempt", async () => {
  let calls = 0;
  const client = createScreeningClient({ budget: new DollarBudget(1), apiKey: "fixture", fetchImpl: async () => { calls++; return new Response('{"error":"quota"}', { status: 429 }); } });
  await assert.rejects(client.request("/chat/completions", { method: "POST", body: body() }), e => e.name === "QuotaStop");
  assert.equal(calls, 1);
  assert.throws(() => createScreeningClient({ budget: new DollarBudget(1), apiKey: "fixture", concurrency: 3 }), /one or two/);
});

test("prewarming stops scheduling after a budget stop instead of swallowing it", async () => {
  let calls = 0;
  const posts = Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: "Synthetic", url: `https://synthetic-${i}.test`, created_at: "2025-10-01T00:00:00Z" }));
  const error = new Error("fixture cap"); error.name = "BudgetExceededError";
  await assert.rejects(prewarmSample({ posts, concurrency: 1, screeners: { screen1: async () => { calls++; throw error; }, preflight: async () => null, screen2: async () => ({ include: true, reasonCode: null }) } }), e => e.name === "BudgetExceededError");
  assert.equal(calls, 1);
});

test("initial and extension CLIs need explicit budgets and print unsuccessful accounting", async () => {
  for (const argv of [[], ["--extend", "19"]]) {
    const lines = []; const out = await runSampleCli(argv, { dataDir: dir(), apiKey: "fixture", log: line => lines.push(line) });
    assert.equal(out.ok, false); assert.match(out.reason, /budget/i);
    const accounting = lines.filter(line => line.startsWith("ACCOUNTING:")).map(line => JSON.parse(line.slice(12))).at(-1);
    assert.equal(accounting.ok, false); assert.equal(accounting.complete, false); assert.equal(accounting.httpCalls, 0);
  }
});

test("extension quota stop writes budget/accounting but never a partial fresh sample", async () => {
  const dataDir = dir(); fs.mkdirSync(path.join(dataDir, "pipeline"));
  const posts = [{ id: "new", title: "Synthetic", url: "https://synthetic-new.test", created_at: "2025-10-01T00:00:00Z" }];
  fs.writeFileSync(path.join(dataDir, "pipeline/frame.json"), JSON.stringify({ posts }));
  fs.writeFileSync(path.join(dataDir, "pipeline/sample-projects.json"), "[]");
  fs.writeFileSync(path.join(dataDir, "pipeline/sample-screening-log.json"), '{"log":[]}');
  const lines = []; let calls = 0;
  const out = await runSampleCli(["--extend", "19", "--screening-budget", ".1"], { dataDir, apiKey: "fixture", log: line => lines.push(line), fetchImpl: async () => { calls++; return new Response('{"error":"quota"}', { status: 402 }); } });
  assert.equal(out.ok, false); assert.equal(out.reason, "QuotaStop"); assert.equal(calls, 1);
  assert.equal(fs.existsSync(path.join(dataDir, "pipeline/fresh-projects.json")), false);
  assert.ok(lines.some(line => line.startsWith("BUDGET:")));
  const accounting = JSON.parse(lines.filter(line => line.startsWith("ACCOUNTING:")).at(-1).slice(12));
  assert.equal(accounting.complete, false); assert.equal(accounting.httpCalls, 1);
});

test("missing extension and concurrency values cannot fall back to a different paid draw", async () => {
  for (const argv of [["--screening-budget", ".1", "--extend"], ["--screening-budget", ".1", "--per-quarter"], ["--screening-budget", ".1", "--screening-concurrency"]]) {
    const lines = []; let calls = 0;
    const out = await runSampleCli(argv, { dataDir: dir(), apiKey: "fixture", log: line => lines.push(line), fetchImpl: async () => { calls++; throw new Error("unexpected"); } });
    assert.equal(out.ok, false); assert.equal(out.httpCalls, 0); assert.equal(calls, 0); assert.ok(lines.some(line => line.startsWith("ACCOUNTING:")));
  }
});

test("HTTP concurrency is bounded at two while waiting work remains unscheduled", async () => {
  let active = 0, max = 0, calls = 0; const pending = [];
  const client = createScreeningClient({ budget: new DollarBudget(1), apiKey: "fixture", concurrency: 2, fetchImpl: async () => {
    active++; calls++; max = Math.max(max, active);
    await new Promise(resolve => pending.push(resolve)); active--;
    return new Response(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
  } });
  const jobs = Array.from({ length: 3 }, () => client.request("/chat/completions", { method: "POST", body: body() }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 2);
  pending.splice(0).forEach(resolve => resolve()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 3); pending.splice(0).forEach(resolve => resolve()); await Promise.all(jobs); assert.equal(max, 2);
});

test("a dead process lease is recovered without resetting its retained spend", () => {
  const dataDir = dir(); const scope = "c".repeat(64); let opened = openScreeningBudget({ dataDir, scope, cap: .1 });
  opened.budget.reserve(.02); const file = opened.file; opened.release();
  fs.writeFileSync(file + ".lock", "2147483647");
  opened = openScreeningBudget({ dataDir, scope, cap: .1 }); assert.ok(Math.abs(opened.budget.spent - .02) < 1e-12); opened.release();
});

test("a completed synthetic extension asserts PRISMA and complete accounting", async () => {
  const dataDir = dir(); fs.mkdirSync(path.join(dataDir, "pipeline"));
  const dates = ["2025-10-01", "2026-01-01", "2026-04-01", "2026-07-01"];
  const posts = dates.map((date, i) => ({ id: `synthetic-${i}`, title: "Synthetic", url: `https://synthetic-${i}-fixture.com/`, created_at: date + "T00:00:00Z" }));
  fs.writeFileSync(path.join(dataDir, "pipeline/frame.json"), JSON.stringify({ posts })); fs.writeFileSync(path.join(dataDir, "pipeline/sample-projects.json"), "[]"); fs.writeFileSync(path.join(dataDir, "pipeline/sample-screening-log.json"), '{"log":[]}');
  const lines = [];
  const out = await runSampleCli(["--extend", "1", "--screening-budget", ".1"], { dataDir, apiKey: "fixture", log: line => lines.push(line), fetchImpl: async () => new Response('{"usage":{"prompt_tokens":10,"completion_tokens":5}}', { status: 200 }), screenersFactory: client => ({
    screen1: async () => { await client.request("/chat/completions", { method: "POST", body: body() }); return { include: true, reasonCode: null }; },
    preflight: async p => ({ entry_url: p.url, final_url: p.url, boundary: {}, type_class: "own-domain", page_text: "Synthetic evidence ".repeat(40), preflight: { robots_blocked: false, boundary_ok: true } }),
    screen2: async () => { await client.request("/chat/completions", { method: "POST", body: body() }); return { include: true, reasonCode: null }; },
  }) });
  assert.equal(out.ok, true); assert.equal(out.included, 4); assert.equal(out.httpCalls, 8);
  assert.equal(JSON.parse(lines.find(line => line.startsWith("PRISMA:")).slice(8)).included, 4);
  const accounting = JSON.parse(lines.filter(line => line.startsWith("ACCOUNTING:")).at(-1).slice(12)); assert.equal(accounting.ok, true); assert.equal(accounting.complete, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "pipeline/fresh-projects.json"), "utf8")).length, 4);
});
