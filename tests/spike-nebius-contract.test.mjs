// Offline tests for the Nebius matrix output contract (FND-05, D-15, COD-01,
// plan 01-10 Task 1). No network access.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildContract, isSchemaValid, loadGateFile, resolveGatesPath, resolveSpans } from "../scripts/spikes/lib/contract.mjs";
import { segmentPage } from "../scripts/spikes/lib/segment.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- an independent count of the ids in the gate file, computed here with
// its own walk (not by importing loadGateFile's own logic), so the test
// cannot pass merely because both counts share a bug. ----------------------
function independentIdCount(gatesPath) {
  const json = JSON.parse(fs.readFileSync(gatesPath, "utf8"));
  const ids = new Set();
  for (const key of Object.keys(json.decisions)) {
    for (const check of json.decisions[key].requiredChecks) ids.add(check.id);
  }
  return ids.size;
}

describe("contract: the 24 gate check ids", () => {
  test("loadGateFile extracts exactly the ids independently counted in the file", () => {
    const gatesPath = resolveGatesPath(undefined, REPO_ROOT);
    const { checkIds, sha256 } = loadGateFile(gatesPath);
    const expectedCount = independentIdCount(gatesPath);
    assert.equal(checkIds.length, expectedCount);
    assert.equal(new Set(checkIds).size, checkIds.length, "ids must be unique");
    assert.match(sha256, /^[0-9a-f]{64}$/);
    // recorded sha256 must match a fresh hash of the same bytes
    const raw = fs.readFileSync(gatesPath, "utf8");
    assert.equal(crypto.createHash("sha256").update(raw).digest("hex"), sha256);
  });

  test("resolveGatesPath falls back to the sibling checkout when no vendored file and no --gates", () => {
    const missingRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prism-no-vendor-"));
    try {
      const p = resolveGatesPath(undefined, missingRepoRoot);
      assert.ok(p.endsWith("decision-gates.json"));
      assert.ok(!p.startsWith(missingRepoRoot));
    } finally {
      fs.rmSync(missingRepoRoot, { recursive: true, force: true });
    }
  });

  test("resolveGatesPath honors an explicit --gates path over both defaults", () => {
    const explicit = "/tmp/some/explicit/path/decision-gates.json";
    assert.equal(resolveGatesPath(explicit, REPO_ROOT), path.resolve(explicit));
  });
});

describe("contract: generated schema and zod contract", () => {
  const gatesPath = resolveGatesPath(undefined, REPO_ROOT);
  const { checkIds } = loadGateFile(gatesPath);
  const { zodSchema, jsonSchema } = buildContract(checkIds);

  test("the JSON Schema requires exactly 24 entries and lists exactly the 24 ids as the checkId enum", () => {
    const checksSchema = jsonSchema.properties.checks;
    assert.equal(checksSchema.minItems, 24);
    assert.equal(checksSchema.maxItems, 24);
    const enumIds = checksSchema.items.properties.checkId.enum;
    assert.deepEqual([...enumIds].sort(), [...checkIds].sort());
  });

  test("a valid 24-entry reply parses", () => {
    const checks = checkIds.map((checkId, i) => ({
      checkId,
      proposedState: "unknown",
      spanIds: i === 0 ? ["s001"] : [],
    }));
    const result = zodSchema.safeParse({ checks });
    assert.equal(result.success, true);
  });

  test("zod rejects an extra field", () => {
    const checks = checkIds.map((checkId) => ({ checkId, proposedState: "unknown", spanIds: [] }));
    const result = zodSchema.safeParse({ checks, extra: "nope" });
    assert.equal(result.success, false);
  });

  test("zod rejects a wrong proposedState", () => {
    const checks = checkIds.map((checkId) => ({ checkId, proposedState: "unknown", spanIds: [] }));
    checks[0] = { ...checks[0], proposedState: "maybe" };
    const result = zodSchema.safeParse({ checks });
    assert.equal(result.success, false);
  });

  test("zod rejects a duplicate checkId (even at 24 entries)", () => {
    const checks = checkIds.map((checkId) => ({ checkId, proposedState: "unknown", spanIds: [] }));
    checks[1] = { ...checks[1], checkId: checks[0].checkId };
    const result = zodSchema.safeParse({ checks });
    assert.equal(result.success, false);
  });

  test("zod rejects fewer than 24 entries", () => {
    const checks = checkIds.slice(0, 23).map((checkId) => ({ checkId, proposedState: "unknown", spanIds: [] }));
    const result = zodSchema.safeParse({ checks });
    assert.equal(result.success, false);
  });
});

describe("contract: resolveSpans", () => {
  test("accepts spanIds that are all in the page's span list", () => {
    const reply = { checks: [{ checkId: "x", proposedState: "unknown", spanIds: ["s001", "s002"] }] };
    assert.equal(resolveSpans(reply, ["s001", "s002", "s003"]), true);
  });

  test("rejects an invented span id not in the page's span list", () => {
    const reply = { checks: [{ checkId: "x", proposedState: "unknown", spanIds: ["s099"] }] };
    assert.equal(resolveSpans(reply, ["s001", "s002"]), false);
  });

  test("rejects a malformed shape", () => {
    assert.equal(resolveSpans(null, ["s001"]), false);
    assert.equal(resolveSpans({}, ["s001"]), false);
    assert.equal(resolveSpans({ checks: [{ spanIds: "not-an-array" }] }, ["s001"]), false);
  });
});

describe("contract: isSchemaValid (the single definition)", () => {
  const gatesPath = resolveGatesPath(undefined, REPO_ROOT);
  const { checkIds } = loadGateFile(gatesPath);
  const { zodSchema } = buildContract(checkIds);
  const spanIds = ["s001", "s002"];
  const validChecks = checkIds.map((checkId, i) => ({
    checkId,
    proposedState: "unknown",
    spanIds: i === 0 ? ["s001"] : [],
  }));

  test("classifies a fully valid reply", () => {
    const r = isSchemaValid(JSON.stringify({ checks: validChecks }), spanIds, zodSchema);
    assert.equal(r.valid, true);
    assert.equal(r.stage, "ok");
  });

  test("classifies unparsable text", () => {
    const r = isSchemaValid("{not json", spanIds, zodSchema);
    assert.equal(r.valid, false);
    assert.equal(r.stage, "json_parse");
  });

  test("classifies zod-invalid JSON (valid JSON, contract violated)", () => {
    const r = isSchemaValid(JSON.stringify({ checks: [] }), spanIds, zodSchema);
    assert.equal(r.valid, false);
    assert.equal(r.stage, "zod");
  });

  test("classifies span-invalid JSON (contract holds, span id not on the page)", () => {
    const badChecks = validChecks.map((c, i) => (i === 0 ? { ...c, spanIds: ["s999"] } : c));
    const r = isSchemaValid(JSON.stringify({ checks: badChecks }), spanIds, zodSchema);
    assert.equal(r.valid, false);
    assert.equal(r.stage, "span_resolve");
  });
});

describe("segmentPage: determinism", () => {
  test("same input always yields the same ids and text", () => {
    const text = "Para one.\n\nPara two spans\ntwo lines.\n\n\nPara three.";
    const a = segmentPage(text);
    const b = segmentPage(text);
    assert.deepEqual(a, b);
    assert.deepEqual(
      a.map((s) => s.id),
      ["s001", "s002", "s003"],
    );
  });

  test("blank input yields no spans", () => {
    assert.deepEqual(segmentPage(""), []);
    assert.deepEqual(segmentPage("   \n\n  "), []);
  });

  test("ids are stable and zero-padded to three digits", () => {
    const text = Array.from({ length: 12 }, (_, i) => `paragraph ${i}`).join("\n\n");
    const spans = segmentPage(text);
    assert.equal(spans.length, 12);
    assert.equal(spans[9].id, "s010");
  });
});
