import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openReleaseBudget } from "../../src/pipeline/validate/release-budget.ts";
import { DollarBudget } from "../../src/pipeline/coding/spend-guards.ts";
import { createClient } from "../../src/pipeline/coding/nebius-client.ts";
import { SCREENER_MODEL } from "../../src/pipeline/select/screen-model.ts";
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "prism-release-budget-"));
const snapshot = () => { const observedAt = new Date().toISOString(); return { tokenFactory: { remainingUsd: 4, reserveUsd: 1, observedAt, source: "verified-console" }, ollama: { remainingIncludedUsd: 2.5, reserveUsd: .5, observedAt, source: "verified-api" } }; };

test("new balance snapshots start with no historical pipeline charges", () => {
  const opened = openReleaseBudget(dir(), snapshot()); const s = opened.summary();
  assert.equal(s.hosts["token-factory"].cap, 3); assert.equal(s.hosts.ollama.cap, 2);
  assert.equal(s.hosts["token-factory"].spent, 0); assert.equal(s.hosts.ollama.spent, 0);
  assert.match(opened.budgetLine(), /^BUDGET: /); opened.release();
});

test("same stage id is idempotent and distinct stages share one reservable host allowance", () => {
  const opened = openReleaseBudget(dir(), snapshot()); const a = opened.stageBudget("ollama", 1.5, "fresh-gold");
  assert.ok(a instanceof DollarBudget); assert.equal(opened.stageBudget("ollama", 1.5, "fresh-gold"), a);
  const b = opened.stageBudget("ollama", 1.5, "changed-confirm"); a.reserve(1.2);
  assert.throws(() => b.reserve(.9), /budget exceeded/); a.settle(1.2, 1);
  b.reserve(.9); b.settle(.9); assert.ok(Math.abs(opened.summary().hosts.ollama.spent - 1.9) < 1e-12); opened.release();
});

test("request reservations reach disk before the caller can use them", () => {
  const opened = openReleaseBudget(dir(), snapshot()); const b = opened.stageBudget("token-factory", 1, "screening"); b.reserve(.3);
  const stored = JSON.parse(fs.readFileSync(opened.file, "utf8")); assert.equal(stored.stages.screening.reserved, .3);
  b.settle(.3, .1); assert.equal(JSON.parse(fs.readFileSync(opened.file, "utf8")).stages.screening.spent, .1); opened.release();
});

test("unmeasured reservations remain charged across release and resume without double counting", () => {
  const dataDir = dir(), s = snapshot(); let opened = openReleaseBudget(dataDir, s);
  opened.stageBudget("ollama", 1.1, "fresh-gold").reserve(.4); opened.release();
  opened = openReleaseBudget(dataDir, s); assert.equal(opened.summary().hosts.ollama.spent, .4); assert.equal(opened.summary().hosts.ollama.reserved, 0); opened.release();
  opened = openReleaseBudget(dataDir, s); assert.equal(opened.summary().hosts.ollama.spent, .4); opened.release();
});

test("stage caps may only decrease and must remain inside current host funding", () => {
  const opened = openReleaseBudget(dir(), snapshot()); const a = opened.stageBudget("ollama", 1.1, "fresh-gold");
  assert.throws(() => opened.stageBudget("ollama", 1.2, "fresh-gold"), /increase/);
  assert.equal(opened.stageBudget("ollama", .9, "fresh-gold"), a); assert.equal(a.cap, .9);
  assert.throws(() => opened.stageBudget("ollama", 2.1, "changed-confirm"), /funding|budget/);
  assert.throws(() => opened.stageBudget("token-factory", .9, "fresh-gold"), /host/); opened.release();
});

test("negative, nonfinite and reserve-eroding snapshots are refused before a stage exists", () => {
  for (const balance of [-1, Infinity, NaN, .99]) { const s = snapshot(); s.tokenFactory.remainingUsd = balance; assert.throws(() => openReleaseBudget(dir(), s), /balance|reserve/); }
  const s = snapshot(); s.ollama.reserveUsd = .49; assert.throws(() => openReleaseBudget(dir(), s), /reserve/);
});

test("verification source, freshness and both host observations are mandatory", () => {
  for (const change of [s => { s.tokenFactory.source = "estimated"; }, s => { s.ollama.observedAt = new Date(Date.now() - 25 * 3600000).toISOString(); }, s => { s.ollama.observedAt = new Date(Date.now() + 120000).toISOString(); }, s => { delete s.tokenFactory; }]) {
    const s = snapshot(); change(s); assert.throws(() => openReleaseBudget(dir(), s), /snapshot|source|observation/);
  }
});

test("frozen snapshots cannot be replaced to reset or expand the shared allowance", () => {
  const dataDir = dir(), s = snapshot(); let opened = openReleaseBudget(dataDir, s); const a = opened.stageBudget("token-factory", 1, "screening"); a.reserve(.2); a.settle(.2); opened.release();
  const changed = structuredClone(s); changed.tokenFactory.remainingUsd = 10; assert.throws(() => openReleaseBudget(dataDir, changed), /frozen/);
  opened = openReleaseBudget(dataDir, s); assert.equal(opened.summary().hosts["token-factory"].spent, .2); opened.release();
});

test("concurrent release jobs cannot acquire the same ledger", () => {
  const dataDir = dir(), s = snapshot(); const opened = openReleaseBudget(dataDir, s);
  assert.throws(() => openReleaseBudget(dataDir, s), /active|EEXIST/); opened.release();
});

test("closed clients cannot write over a later release job", () => {
  const dataDir = dir(), s = snapshot(); let opened = openReleaseBudget(dataDir, s); const old = opened.stageBudget("ollama", 1, "fresh-gold"); old.reserve(.4); opened.release();
  opened = openReleaseBudget(dataDir, s); assert.throws(() => old.settle(.4, .1), /closed/);
  assert.equal(JSON.parse(fs.readFileSync(opened.file, "utf8")).stages["fresh-gold"].spent, .4); opened.release();
});

test("no host spending is available when its exact protected reserve remains", () => {
  const s = snapshot(); s.ollama.remainingIncludedUsd = .5; const opened = openReleaseBudget(dir(), s);
  assert.equal(opened.summary().hosts.ollama.available, 0); assert.throws(() => opened.stageBudget("ollama", .01, "fresh-gold"), /funding|budget/); opened.release();
});

test("the real client persists before fake HTTP and charges both measured and lost responses", async () => {
  for (const measured of [true, false]) {
    const opened = openReleaseBudget(dir(), snapshot()); const budget = opened.stageBudget("token-factory", .1, "screening"); let calls = 0;
    const client = createClient({ baseUrl: "https://example.invalid", apiKey: "synthetic", budget, maxRetries: 0, concurrency: 1, fetchImpl: async () => {
      calls++; assert.ok(JSON.parse(fs.readFileSync(opened.file, "utf8")).stages.screening.reserved > 0);
      if (!measured) throw new Error("synthetic lost response");
      return new Response('{"usage":{"prompt_tokens":10,"completion_tokens":5}}', { status: 200 });
    } });
    const request = client.request("/chat/completions", { method: "POST", body: { model: SCREENER_MODEL, messages: [{ role: "user", content: "Synthetic fixture" }], max_tokens: 256 } });
    if (measured) await request; else await assert.rejects(request, /network failure/);
    assert.equal(calls, 1); const saved = JSON.parse(fs.readFileSync(opened.file, "utf8")).stages.screening;
    assert.ok(saved.spent > 0); assert.equal(saved.reserved, 0); assert.equal(opened.summary().hosts["token-factory"].spent, saved.spent); opened.release();
  }
});

test("dead leases recover without resetting persisted host spending", () => {
  const dataDir = dir(), s = snapshot(); let opened = openReleaseBudget(dataDir, s); const budget = opened.stageBudget("ollama", .8, "fresh-gold"); budget.reserve(.3); const file = opened.file; opened.release();
  fs.writeFileSync(file + ".lock", "2147483647"); opened = openReleaseBudget(dataDir, s); assert.equal(opened.summary().hosts.ollama.spent, .3); opened.release();
});
