import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ollamaClient, splitLeadingThinkingBlock, thinkingEnvelopeEnabled } from "../../src/pipeline/validate/providers.ts";
import { buildChatBody } from "../../src/pipeline/coding/nebius-client.ts";
import { estimateCostUsd } from "../../src/pipeline/coding/spend-guards.ts";
import { buildContract, isSchemaValid } from "../../src/pipeline/coding/contract.ts";
import { runApproved, validateSecondCoderEnvelopeReport } from "../../src/pipeline/validate/approved-run.ts";

test("only one complete leading thinking block can be separated", () => {
  assert.deepEqual(splitLeadingThinkingBlock('<think>fixture reasoning</think>\n{"checks":{}}'), { reasoning: "fixture reasoning", content: '\n{"checks":{}}' });
  for (const raw of [
    '<think>unmatched {"checks":{}}',
    '</think>{"checks":{}}',
    '<think>outer <think>nested</think></think>{"checks":{}}',
    '<think>one</think><think>two</think>{"checks":{}}',
    '<think>one</think>{"checks":{}}</think>',
    'prose <think>reasoning</think>{"checks":{}}',
    '```<think>reasoning</think>{"checks":{}}```',
    '{"checks":{}}',
  ]) assert.equal(splitLeadingThinkingBlock(raw), null);
});

async function response(raw, options = {}, model = "nemotron-3-super:cloud") {
  const usage = []; const audits = [];
  const client = ollamaClient({ budget: 1, stage: "second-coder", onUsage: row => usage.push(row), onThinkingEnvelope: row => audits.push(row), ...options,
    fetchImpl: async () => new Response(JSON.stringify({ message: { content: raw }, done: true, prompt_eval_count: 1000, eval_count: 2000 }), { status: 200 }),
  });
  const body = buildChatBody({ model, messages: [{ role: "system", content: "Fixture" }], mode: "json_object", thinking: false, maxTokens: 4096 });
  const result = await client.request("/chat/completions", { method: "POST", body });
  return { client, result, usage, audits, message: result.json.choices[0].message };
}

test("normalization is limited to explicit second coding with the exact approved model", async () => {
  const raw = '<think>fixture reasoning</think>{"checks":{}}';
  const disabled = await response(raw);
  assert.equal(disabled.message.content, raw); assert.equal(disabled.audits.length, 0);
  const other = await response(raw, { splitNemotronThinking: true }, "glm-5.3-flash");
  assert.equal(other.message.content, raw); assert.equal(other.audits.length, 0);
  for (const stage of [undefined, "gold", "spike", "full-confirm"]) {
    const blocked = await response(raw, { splitNemotronThinking: true, stage });
    assert.equal(blocked.message.content, raw); assert.equal(blocked.audits.length, 0);
  }
  for (const model of ["nemotron-3-ultra:cloud", "nvidia/nemotron-3-super", "nemotron-3-super-extra"]) assert.equal(thinkingEnvelopeEnabled("second-coder", model, true), false);
  assert.equal(thinkingEnvelopeEnabled("second-coder", "nemotron-3-super", true), true);
  const ordinary = await response('{"checks":{}}', { splitNemotronThinking: true });
  assert.equal(ordinary.message.content, '{"checks":{}}'); assert.equal(ordinary.message.raw_content, '{"checks":{}}'); assert.equal(ordinary.audits[0].split, false);
});

test("separation retains full raw response and reasoning while charging full output usage", async () => {
  const raw = '<think>fixture reasoning</think>\n{"checks":{}}';
  const { message, result, client, usage, audits } = await response(raw, { splitNemotronThinking: true });
  assert.equal(message.content, '\n{"checks":{}}'); assert.equal(message.raw_content, raw); assert.equal(message.reasoning_content, "fixture reasoning");
  assert.deepEqual(audits[0], { model: "nemotron-3-super:cloud", nativeResponse: result.text, status: 200, rawContent: raw, reasoningContent: "fixture reasoning", content: '\n{"checks":{}}', split: true });
  assert.equal(result.json.usage.completion_tokens, 2000); assert.equal(usage[0].outputTokens, 2000);
  assert.equal(client.dollarBudget.snapshot().spent, estimateCostUsd("nemotron-3-super", 1000, 2000));
});

test("enabled separation requires its audit before HTTP and retains failed native responses unchanged", async () => {
  const body = buildChatBody({ model: "nemotron-3-super:cloud", messages: [{ role: "system", content: "Fixture" }], mode: "json_object", thinking: false, maxTokens: 4096 });
  let calls = 0;
  const refused = ollamaClient({ stage: "second-coder", splitNemotronThinking: true, fetchImpl: async () => { calls++; throw new Error("unexpected fetch"); } });
  await assert.rejects(refused.request("/chat/completions", { method: "POST", body }), /requires a private audit/); assert.equal(calls, 0);
  const native = ' { "error": "quota" }\n'; const audits = [];
  const client = ollamaClient({ stage: "second-coder", splitNemotronThinking: true, budget: 1, onThinkingEnvelope: audit => audits.push(audit), fetchImpl: async () => new Response(native, { status: 402 }) });
  await assert.rejects(client.request("/chat/completions", { method: "POST", body }), { name: "QuotaStop" });
  assert.equal(audits.length, 1); assert.equal(audits[0].nativeResponse, native); assert.equal(audits[0].status, 402); assert.equal(audits[0].split, false);
});

test("offline gate requires complete strict counts but retains failed non-envelope cases", () => {
  const report = { version: 1, stage: "second-coder", model: "nemotron-3-super:cloud", strictValidation: true, complete: true, validationScope: "current per-project citations and required checks", total: 12, valid: 9, failed: 3, envelopeCount: 9, envelopeValid: 9, envelopeFailed: 0 };
  assert.equal(validateSecondCoderEnvelopeReport(report), true);
  assert.equal(validateSecondCoderEnvelopeReport({ ...report, total: 16, valid: 0, failed: 16, envelopeCount: 0, envelopeValid: 0, envelopeFailed: 0 }), true);
  for (const patch of [{ complete: false }, { strictValidation: false }, { model: "nemotron-3-ultra:cloud" }, { envelopeCount: 0 }, { valid: 10 }, { envelopeValid: 10 }, { validationScope: "" }, { total: 0 }, { failed: -1 }]) assert.equal(validateSecondCoderEnvelopeReport({ ...report, ...patch }), false);
});

test("malformed tags, final prose and fences remain invalid under the unchanged strict validator", async () => {
  const contract = buildContract(["fixture-check"]);
  const final = JSON.stringify({ checks: { "fixture-check": { proposedState: "unknown", spanIds: [] } } });
  for (const raw of [`<think>nested <think>reason</think></think>${final}`, `<think>reason</think>Here is JSON: ${final}`, `<think>reason</think>\`\`\`json\n${final}\n\`\`\``]) {
    const { message } = await response(raw, { splitNemotronThinking: true });
    assert.equal(message.raw_content, raw);
    assert.equal(isSchemaValid(message.content, [], contract.zodSchema).valid, false);
  }
  const { message } = await response(`<think>reason</think>${final}`, { splitNemotronThinking: true });
  assert.equal(isSchemaValid(message.content, [], contract.zodSchema).valid, true);
});

test("invalid stages and held full confirmation cannot reach HTTP even with separation requested", async () => {
  const original = globalThis.fetch; let calls = 0;
  const previousDataDir = process.env.PRISM_DATA_DIR;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-envelope-approval-"));
  process.env.PRISM_DATA_DIR = dataDir;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected HTTP"); };
  try {
    await assert.rejects(runApproved("unapproved", { splitNemotronThinking: true }), /explicit approved stage/);
    await assert.rejects(runApproved("full-confirm", { splitNemotronThinking: true }), /held until/);
    await assert.rejects(runApproved("second-coder", { splitNemotronThinking: true }), /A8/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
    if (previousDataDir === undefined) delete process.env.PRISM_DATA_DIR;
    else process.env.PRISM_DATA_DIR = previousDataDir;
  }
});
