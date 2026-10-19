// Pilot regressions: replies keyed by check id (no duplicated or dropped checks), and a
// retry-exhausted coding fallback that is never cached.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildContract, isSchemaValid } from "../../src/pipeline/coding/contract.ts";
import { withStageCache } from "../../src/pipeline/cache/stage-cache.ts";

const ids = ["a-check", "b-check", "c-check"];
const contract = buildContract(ids);
const spanIds = ["p1-s001", "p1-s002"];

test("the JSON Schema sent to the model requires every check id, once, as a key", () => {
  const checks = contract.jsonSchema.properties.checks;
  assert.deepEqual([...checks.required].sort(), [...ids].sort());
  assert.equal(checks.additionalProperties, false);
});

test("a keyed reply validates and comes back as the array form, one entry per check", () => {
  const reply = { checks: { "a-check": { proposedState: "pass", spanIds: ["p1-s001"] }, "b-check": { proposedState: "unknown", spanIds: [] }, "c-check": { proposedState: "fail", spanIds: ["p1-s002"] } } };
  const r = isSchemaValid(JSON.stringify(reply), spanIds, contract.zodSchema);
  assert.equal(r.valid, true);
  assert.deepEqual(r.data.checks.map((c) => c.checkId), ids);
  assert.deepEqual(r.data.checks[0], { checkId: "a-check", proposedState: "pass", spanIds: ["p1-s001"] });
});

test("a keyed reply missing a check is rejected at the zod stage", () => {
  const reply = { checks: { "a-check": { proposedState: "pass", spanIds: [] }, "b-check": { proposedState: "pass", spanIds: [] } } };
  assert.equal(isSchemaValid(JSON.stringify(reply), spanIds, contract.zodSchema).stage, "zod");
});

test("an array reply with a duplicated check is still rejected (the failure the keyed schema prevents)", () => {
  const reply = { checks: [{ checkId: "a-check", proposedState: "pass", spanIds: [] }, { checkId: "a-check", proposedState: "pass", spanIds: [] }, { checkId: "b-check", proposedState: "pass", spanIds: [] }] };
  assert.equal(isSchemaValid(JSON.stringify(reply), spanIds, contract.zodSchema).valid, false);
});

test("withStageCache leaves a value uncached when shouldCache says no, so the next call recomputes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-cache-"));
  let calls = 0;
  const compute = async () => ({ allUnknown: true, attempts: 3, n: ++calls });
  const skip = (v) => !(v.allUnknown && v.attempts > 0);
  const first = await withStageCache(dir, "p", "code", { x: 1 }, compute, skip);
  const second = await withStageCache(dir, "p", "code", { x: 1 }, compute, skip);
  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, false);
  assert.equal(calls, 2);
  assert.equal(fs.readdirSync(dir).length, 0);
});
