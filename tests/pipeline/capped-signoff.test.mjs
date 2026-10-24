import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cappedSignoff, projectSignoff } from "../../src/pipeline/signoff/capped.ts";

test("oversized review preserves evidence and refuses before any request", async () => {
  assert.throws(() => projectSignoff("x".repeat(100000), "rules", "final"), /preserve the full evidence/);
});
test("review spends once, retains raw response and binds cached decision to exact text", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-review-"));
  let calls = 0;
  const raw = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: "approved", narrowsWhatPasses: false, reason: "Fixture evidence supports it." }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  const options = { dataDir, doc: "Evidence", context: "Rules", item: "final", apiKey: "fixture", fetchImpl: async () => { calls++; return new Response(raw); } };
  try {
    const record = await cappedSignoff(options);
    assert.equal(record.decision, "approved");
    assert.deepEqual(await cappedSignoff(options), record); assert.equal(calls, 1);
    const file = path.join(dataDir, "decisions", "capped", record.inputDigest + ".json");
    const evidence = JSON.parse(fs.readFileSync(file));
    assert.equal(evidence.raw, raw); assert.equal(evidence.budget.cap, .5);
    assert.ok(evidence.budget.spent > 0 && evidence.budget.spent < .5);
    await cappedSignoff({ ...options, doc: "Different evidence" }); assert.equal(calls, 2);
  } finally { fs.rmSync(dataDir, { recursive: true }); }
});
test("quota failure stops without retry and restart cannot rebuy it", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-review-")); let calls = 0;
  const options = { dataDir, doc: "Evidence", context: "Rules", item: "final", apiKey: "fixture", fetchImpl: async () => { calls++; return new Response("insufficient credit", { status: 402 }); } };
  try {
    await assert.rejects(cappedSignoff(options)); assert.equal(calls, 1);
    const file = path.join(dataDir, "decisions", "capped", projectSignoff(options.doc, options.context, options.item).inputDigest + ".json");
    assert.equal(JSON.parse(fs.readFileSync(file)).raw, "insufficient credit");
    await assert.rejects(cappedSignoff(options), /requires inspection/); assert.equal(calls, 1);
  } finally { fs.rmSync(dataDir, { recursive: true }); }
});
