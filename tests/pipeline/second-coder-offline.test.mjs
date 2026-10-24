import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContract } from "../../src/pipeline/coding/contract.ts";
import { inspectReplies } from "../../src/pipeline/validate/second-coder-offline.ts";

test("offline inspection retains original records and separates only strict leading envelopes", () => {
  const schema = buildContract(["fixture"]).zodSchema;
  const valid = JSON.stringify({ checks: { fixture: { proposedState: "pass", spanIds: ["p1-s1"] } } });
  const contents = [`<think>reason</think>${valid}`, `<think>reason</think>${valid.replace("p1-s1", "missing")}`, `<think>reason</think>\`\`\`json\n${valid}\n\`\`\``, `<think>one</think><think>two</think>${valid}`, `<think>unfinished${valid}`, `${valid}<think>trailing</think>`];
  const lines = contents.map(content => JSON.stringify({ stage: "second-coder", projectN: 1, content }));
  const { report, audits } = inspectReplies(lines, () => [["p1-s1"]], schema);
  assert.equal(report.total, 6); assert.equal(report.envelopeCount, 3); assert.equal(report.envelopeJsonClean, 2);
  assert.equal(report.envelopeValid, 1); assert.equal(report.envelopeFailed, 2);
  assert.equal(report.valid, 1); assert.equal(report.failed, 5);
  assert.deepEqual(report.failureCounts, { json_parse: 4, zod: 0, span_resolve: 1 });
  assert.deepEqual(audits.map(a => a.rawContent), contents); assert.deepEqual(audits.map(a => a.rawRecordLine), lines);
  assert.deepEqual(audits[0].parsedResult, JSON.parse(valid));
});
