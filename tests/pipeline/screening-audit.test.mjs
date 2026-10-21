// VAL-05 / A7.10: screening exclusion audit (blind Kimi-K3 auditor).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { wilson } from "../../src/pipeline/validate/agreement.ts";
import {
  auditExclusions,
  auditFigure,
  operationalExcludedCounts,
} from "../../src/pipeline/validate/screening-audit.ts";
import { ROLE_CONFIG } from "../../src/pipeline/validate/providers.ts";
import { screenMessages, SCREENER_MODEL } from "../../src/pipeline/select/screen-model.ts";

function tmpCache() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prism-audit-"));
}

function fakeClient(replies) {
  const seen = [];
  let i = 0;
  return {
    seen,
    request: async (_p, init) => {
      seen.push(init.body);
      const content = typeof replies === "function" ? replies(i++, init.body) : replies[i++] ?? replies[replies.length - 1];
      return { ok: true, status: 200, json: { choices: [{ message: { content } }] } };
    },
  };
}

function stubScreeners({ text = "x".repeat(600), finalUrl = "https://example.com/p", renderText } = {}) {
  return {
    preflight: async (p) => ({
      entry_url: p.url,
      final_url: finalUrl,
      boundary: {},
      type_class: "site",
      page_text: text,
      preflight: { robots_blocked: false, boundary_ok: true },
    }),
    render: async () => renderText ?? text,
    screen1: async () => assert.fail("auditor must not call screen1"),
    screen2: async () => assert.fail("auditor must not call screen2"),
  };
}

const posts = [
  { id: "a1", title: "Show HN: Alpha", url: "https://alpha.example/", created_at: "2025-01-01T00:00:00.000Z" },
  { id: "a2", title: "Show HN: Beta", url: "https://beta.example/", created_at: "2025-01-02T00:00:00.000Z" },
  { id: "a3", title: "Show HN: Gamma", url: "https://gamma.example/", created_at: "2025-01-03T00:00:00.000Z" },
];

const log = [
  { id: "a1", rank: 1, outcome: { kind: "excluded", stage: 2, reasonCode: "not-ai" } },
  { id: "a2", rank: 2, outcome: { kind: "excluded", stage: 1, reasonCode: "model-or-paper" } },
  { id: "a3", rank: 3, outcome: { kind: "excluded", stage: 2, reasonCode: "ai-adjacent" } },
  { id: "op1", rank: 4, outcome: { kind: "excluded", stage: 1, reasonCode: "duplicate" } },
  { id: "op2", rank: 5, outcome: { kind: "excluded", stage: 2, reasonCode: "unreachable-at-screening" } },
];

describe("auditExclusions", () => {
  test("audited set equals subsets.audit in seed order; operational codes never appear", async () => {
    const client = fakeClient([
      JSON.stringify({ include: false, reasonCode: "not-ai" }),
      JSON.stringify({ include: true, reasonCode: null }),
      JSON.stringify({ include: false, reasonCode: "ai-adjacent" }),
    ]);
    const { records, figure } = await auditExclusions({
      subsets: { audit: ["a1", "a2", "a3"] },
      log,
      posts,
      screeners: stubScreeners(),
      client,
      role: ROLE_CONFIG.auditor,
      cacheDir: tmpCache(),
    });
    assert.deepEqual(
      records.map((r) => r.id),
      ["a1", "a2", "a3"],
    );
    assert.equal(figure.n, 3);
    assert.deepEqual(figure.operationalExcluded, { duplicate: 1, "unreachable-at-screening": 1 });
    assert.ok(!records.some((r) => r.originalReasonCode === "duplicate"));
  });

  test("auditor messages deep-equal screenMessages(2, ...) — blind to screener decision", async () => {
    let captured;
    const client = fakeClient((_i, body) => {
      captured = body.messages;
      return JSON.stringify({ include: false, reasonCode: "not-ai" });
    });
    const text = "Own page text about a product. ".repeat(40);
    const finalUrl = "https://alpha.example/final";
    await auditExclusions({
      subsets: { audit: ["a1"] },
      log,
      posts,
      screeners: stubScreeners({ text, finalUrl }),
      client,
      role: ROLE_CONFIG.auditor,
      cacheDir: tmpCache(),
    });
    const expected = screenMessages(2, {
      title: "Show HN: Alpha",
      url: finalUrl,
      text: text.slice(0, 12000),
    });
    assert.deepEqual(captured, expected);
    assert.ok(!JSON.stringify(captured).includes("screener"));
    assert.ok(!JSON.stringify(captured).includes("excluded"));
  });

  test("under 500 characters after render is not-assessable and out of the error denominator", async () => {
    const client = fakeClient([]);
    const { records, figure } = await auditExclusions({
      subsets: { audit: ["a1"] },
      log,
      posts,
      screeners: stubScreeners({ text: "thin", renderText: "still thin" }),
      client,
      role: ROLE_CONFIG.auditor,
      cacheDir: tmpCache(),
    });
    assert.equal(client.seen.length, 0);
    assert.equal(records[0].assessable, false);
    assert.equal(records[0].auditorInclude, null);
    assert.equal(figure.assessable, 0);
    assert.equal(figure.notAssessable, 1);
    assert.equal(figure.errors, 0);
    assert.equal(figure.errorRate, 0);
  });

  test("errors = auditor include true; errorRate and wilson; withinThreshold vs 10%", async () => {
    const client = fakeClient([
      JSON.stringify({ include: true, reasonCode: null }),
      JSON.stringify({ include: false, reasonCode: "not-ai" }),
      JSON.stringify({ include: true, reasonCode: null }),
    ]);
    const { figure } = await auditExclusions({
      subsets: { audit: ["a1", "a2", "a3"] },
      log,
      posts,
      screeners: stubScreeners(),
      client,
      role: ROLE_CONFIG.auditor,
      cacheDir: tmpCache(),
    });
    assert.equal(figure.errors, 2);
    assert.equal(figure.assessable, 3);
    assert.equal(figure.errorRate, 2 / 3);
    assert.deepEqual(figure.wilson95, wilson(2, 3));
    assert.equal(figure.bar, 0.1);
    assert.equal(figure.withinThreshold, false);

    const ok = auditFigure([
      { assessable: true, auditorInclude: false },
      { assessable: true, auditorInclude: false },
      { assessable: true, auditorInclude: false },
      { assessable: true, auditorInclude: false },
      { assessable: true, auditorInclude: false },
      { assessable: true, auditorInclude: false },
      { assessable: true, auditorInclude: false },
      { assessable: true, auditorInclude: false },
      { assessable: true, auditorInclude: false },
      { assessable: true, auditorInclude: false },
    ]);
    assert.equal(ok.errorRate, 0);
    assert.equal(ok.withinThreshold, true);
  });

  test("refuses screener model family and gold labeller family before any call", async () => {
    const client = fakeClient([JSON.stringify({ include: false, reasonCode: "not-ai" })]);
    await assert.rejects(
      () =>
        auditExclusions({
          subsets: { audit: ["a1"] },
          log,
          posts,
          screeners: stubScreeners(),
          client,
          role: { provider: "token-factory", model: SCREENER_MODEL, reasoning: true },
          cacheDir: tmpCache(),
        }),
      /A6/,
    );
    await assert.rejects(
      () =>
        auditExclusions({
          subsets: { audit: ["a1"] },
          log,
          posts,
          screeners: stubScreeners(),
          client,
          role: { provider: "token-factory", model: "zai-org/GLM-5.3-Flash", reasoning: "low" },
          cacheDir: tmpCache(),
        }),
      /A6/,
    );
    assert.equal(client.seen.length, 0);
  });

  test("each record stores id, original stage/reason, auditor decision, provider, model, text source, auditedAt", async () => {
    const client = fakeClient([JSON.stringify({ include: true, reasonCode: null })]);
    const { records } = await auditExclusions({
      subsets: { audit: ["a2"] },
      log,
      posts,
      screeners: stubScreeners({ text: "y".repeat(700), finalUrl: "https://beta.example/f" }),
      client,
      role: ROLE_CONFIG.auditor,
      cacheDir: tmpCache(),
    });
    const r = records[0];
    assert.equal(r.id, "a2");
    assert.equal(r.originalStage, 1);
    assert.equal(r.originalReasonCode, "model-or-paper");
    assert.equal(r.auditorInclude, true);
    assert.equal(r.auditorReasonCode, null);
    assert.equal(r.provider, ROLE_CONFIG.auditor.provider);
    assert.equal(r.model, ROLE_CONFIG.auditor.model);
    assert.equal(r.textSource, "html");
    assert.ok(r.auditedAt);
    assert.match(r.auditedAt, /^\d{4}-/);
  });

  test("stage-1 exclusion still gets a preflight (v2) before audit", async () => {
    let preflighted = 0;
    const screeners = {
      ...stubScreeners(),
      preflight: async (p) => {
        preflighted += 1;
        return stubScreeners().preflight(p);
      },
    };
    const client = fakeClient([JSON.stringify({ include: false, reasonCode: "model-or-paper" })]);
    await auditExclusions({
      subsets: { audit: ["a2"] },
      log,
      posts,
      screeners,
      client,
      role: ROLE_CONFIG.auditor,
      cacheDir: tmpCache(),
    });
    assert.equal(preflighted, 1);
  });

  test("cache stage is audit2 (own key, not the screener's)", async () => {
    const cacheDir = tmpCache();
    const client = fakeClient([JSON.stringify({ include: false, reasonCode: "not-ai" })]);
    await auditExclusions({
      subsets: { audit: ["a1"] },
      log,
      posts,
      screeners: stubScreeners(),
      client,
      role: ROLE_CONFIG.auditor,
      cacheDir,
    });
    const files = fs.readdirSync(cacheDir);
    assert.ok(files.length >= 1);
    // Re-run: no new client calls
    await auditExclusions({
      subsets: { audit: ["a1"] },
      log,
      posts,
      screeners: stubScreeners(),
      client,
      role: ROLE_CONFIG.auditor,
      cacheDir,
    });
    assert.equal(client.seen.length, 1);
  });
});

describe("operationalExcludedCounts", () => {
  test("counts duplicate and unreachable separately from content codes", () => {
    assert.deepEqual(operationalExcludedCounts(log), {
      duplicate: 1,
      "unreachable-at-screening": 1,
    });
  });
});

describe("source contract", () => {
  test("assertIndependent auditor and audit2 stage appear in source", () => {
    const src = fs.readFileSync(
      path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../src/pipeline/validate/screening-audit.ts"),
      "utf8",
    );
    assert.match(src, /assertIndependent\("auditor"/);
    assert.match(src, /"audit2"/);
  });
});
