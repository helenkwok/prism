// DSC-03 + D-50/D-52/D-55a: stratified quarter draw, shared duplicates, extension, subsets.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MIN_STAGE2_CHARS } from "../../src/pipeline/select/draw.ts";
import {
  ARTCRAFT_HN_ID,
  GOLD_SEED,
  RECALL_SEED,
  SAMPLING_SEED,
  SCREENING_AUDIT_SEED,
  SECOND_MODEL_SEED,
  buildSubsets,
  drawSample,
  extendSample,
  quarterOf,
} from "../../src/pipeline/select/draw-sample.ts";
import { sortPilotCandidates } from "../../src/pipeline/select/pilot-draw.ts";

const longText = "an AI product page ".repeat(Math.ceil(MIN_STAGE2_CHARS / 19) + 1);
const post = (id, title, url, created_at) => ({ id, title, url, created_at });
const okPreflight = (text) => async (p) => ({
  entry_url: p.url,
  final_url: p.url,
  boundary: { kind: "host" },
  type_class: "own-domain",
  page_text: text(p),
  preflight: { robots_blocked: false, boundary_ok: true },
});
const includeAll = {
  screen1: async () => ({ include: true, reasonCode: null }),
  preflight: okPreflight(() => longText),
  screen2: async () => ({ include: true, reasonCode: null }),
};

/** Three posts per quarter, unique registrable domains, all included. */
function frame3PerQuarter() {
  const starts = ["2025-10-01", "2026-01-01", "2026-04-01", "2026-07-01"];
  const posts = [];
  for (let q = 0; q < 4; q++) {
    for (let i = 0; i < 3; i++) {
      const id = `q${q + 1}p${i}`;
      posts.push(post(id, "an AI agent", `https://${id}-site.com/`, `${starts[q]}T12:00:00Z`));
    }
  }
  return posts;
}

describe("quarterOf", () => {
  test("window-aligned quarter boundaries (DSC-03 / R03)", () => {
    assert.equal(quarterOf("2025-11-30T23:59:59Z"), 1);
    assert.equal(quarterOf("2025-12-01T00:00:00Z"), 2);
    assert.equal(quarterOf("2026-08-31T12:00:00Z"), 4);
    assert.equal(quarterOf("2025-08-31T23:59:59Z"), 0);
    assert.equal(quarterOf("2026-09-01T00:00:00Z"), 0);
  });
});

describe("drawSample", () => {
  test("each quarter's walk order equals sortPilotCandidates(quarterPosts, SAMPLING_SEED)", async () => {
    const posts = frame3PerQuarter();
    const walked = [];
    const { entries } = await drawSample({
      posts,
      perQuarter: 3,
      seed: SAMPLING_SEED,
      screeners: {
        ...includeAll,
        screen1: async (p) => {
          walked.push(p.id);
          return { include: true, reasonCode: null };
        },
      },
    });
    assert.equal(entries.length, 12);
    const byQ = { 1: [], 2: [], 3: [], 4: [] };
    for (const p of posts) byQ[quarterOf(p.created_at)].push(p);
    let offset = 0;
    for (const q of [1, 2, 3, 4]) {
      const expected = sortPilotCandidates(byQ[q], SAMPLING_SEED).map((p) => p.id);
      assert.deepEqual(walked.slice(offset, offset + 3), expected);
      offset += 3;
    }
  });

  test("a Q1 inclusion that reappears in Q2 is recorded duplicate (shared hosts)", async () => {
    const posts = [
      post("a", "x", "https://same-site.com/", "2025-10-01T00:00:00Z"),
      post("b", "x", "https://other-q1.com/", "2025-10-02T00:00:00Z"),
      post("c", "x", "https://same-site.com/blog", "2026-01-15T00:00:00Z"),
      post("d", "x", "https://fresh-q2.com/", "2026-01-16T00:00:00Z"),
    ];
    const { entries, log, counts } = await drawSample({
      posts,
      perQuarter: 2,
      screeners: includeAll,
    });
    assert.equal(entries.filter((e) => e.quarter === 1).length, 2);
    assert.equal(entries.filter((e) => e.quarter === 2).length, 1);
    const dup = log.find((r) => r.id === "c");
    assert.equal(dup?.outcome.kind, "excluded");
    assert.equal(dup?.outcome.reasonCode, "duplicate");
    assert.equal(dup?.quarter, 2);
    assert.equal(counts["stage1:duplicate"], 1);
  });

  test("perQuarter 3 yields n 1..12, quarter 1..4, three per quarter, chronological", async () => {
    const { entries } = await drawSample({
      posts: frame3PerQuarter(),
      perQuarter: 3,
      screeners: includeAll,
    });
    assert.deepEqual(
      entries.map((e) => e.n),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    );
    assert.deepEqual(
      entries.map((e) => e.quarter),
      [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4],
    );
    for (const q of [1, 2, 3, 4]) {
      assert.equal(entries.filter((e) => e.quarter === q).length, 3);
    }
  });
});

describe("extendSample", () => {
  test("extend(2) after perQuarter-3 leaves first 12 byte-identical and continues n 13..", async () => {
    const posts = [];
    const starts = ["2025-10-01", "2026-01-01", "2026-04-01", "2026-07-01"];
    for (let q = 0; q < 4; q++) {
      for (let i = 0; i < 6; i++) {
        const id = `q${q + 1}x${i}`;
        posts.push(post(id, "an AI agent", `https://${id}-site.com/`, `${starts[q]}T12:00:00Z`));
      }
    }
    const main = await drawSample({ posts, perQuarter: 3, screeners: includeAll });
    const before = structuredClone(main.entries);
    const ext = await extendSample({
      posts,
      previousLog: main.log,
      previousEntries: main.entries,
      perQuarter: 2,
      screeners: includeAll,
    });
    assert.deepEqual(main.entries, before, "main entries untouched");
    assert.equal(ext.entries.length, 8);
    assert.deepEqual(
      ext.entries.map((e) => e.n),
      [13, 14, 15, 16, 17, 18, 19, 20],
    );
    const walkedMain = new Set(main.log.map((r) => r.id));
    for (const e of ext.entries) {
      assert.equal(walkedMain.has(e.hn_id), false, "extension walks only unwalked posts");
    }
    for (const r of ext.log) {
      assert.equal(walkedMain.has(r.id), false);
    }
  });
});

describe("buildSubsets", () => {
  test("gold excludes ArtCraft; secondModel/recall/audit use protocol seeds", async () => {
    const posts = [];
    const starts = ["2025-10-01", "2026-01-01", "2026-04-01", "2026-07-01"];
    // Enough inclusions for subset sizes; inject ArtCraft into Q2.
    let n = 0;
    for (let q = 0; q < 4; q++) {
      for (let i = 0; i < 30; i++) {
        const id = q === 1 && i === 5 ? ARTCRAFT_HN_ID : `s${n++}`;
        posts.push(post(id, "an AI agent", `https://proj-${id}-site.com/`, `${starts[q]}T12:00:00Z`));
      }
    }
    // Sprinkle content-code exclusions for the audit pool (never ArtCraft — it must stay included).
    const excludeIds = new Set(
      posts.filter((p, i) => i % 7 === 0 && p.id !== ARTCRAFT_HN_ID).map((p) => p.id),
    );
    const { entries, log } = await drawSample({
      posts,
      perQuarter: 20,
      screeners: {
        screen1: async (p) =>
          excludeIds.has(p.id) ? { include: false, reasonCode: "not-ai" } : { include: true, reasonCode: null },
        preflight: okPreflight(() => longText),
        screen2: async () => ({ include: true, reasonCode: null }),
      },
    });
    assert.ok(entries.some((e) => e.hn_id === ARTCRAFT_HN_ID), "ArtCraft in sample when drawn");
    // Cap subset sizes to what the synthetic 80-inclusion sample can supply.
    const subsets = buildSubsets(entries, log, {
      secondModelN: Math.min(100, entries.length),
      recallN: 10,
      auditN: Math.min(50, log.filter((r) => r.outcome.kind === "excluded" && r.outcome.reasonCode === "not-ai").length),
    });
    assert.equal(subsets.goldOrder.includes(ARTCRAFT_HN_ID), false);
    assert.deepEqual(subsets.a3Excluded, [ARTCRAFT_HN_ID]);
    const sampleIds = entries.map((e) => ({ id: e.hn_id }));
    assert.deepEqual(
      subsets.secondModel,
      sortPilotCandidates(sampleIds, SECOND_MODEL_SEED).slice(0, subsets.secondModel.length).map((x) => x.id),
    );
    assert.deepEqual(
      subsets.recall,
      sortPilotCandidates(sampleIds, RECALL_SEED).slice(0, 10).map((x) => x.id),
    );
    assert.equal(subsets.recall.length, 10);
    assert.ok(subsets.secondModel.length >= 20);
    assert.ok(subsets.audit.length >= 10);
    assert.equal(subsets.goldOrder.length, entries.length - 1);
    assert.equal(subsets.seeds.gold, GOLD_SEED);
    assert.equal(subsets.seeds.screeningAudit, SCREENING_AUDIT_SEED);
    // Operational codes never enter the audit pool.
    for (const id of subsets.auditPool) {
      const rec = log.find((r) => r.id === id);
      assert.equal(rec.outcome.kind, "excluded");
      assert.notEqual(rec.outcome.reasonCode, "duplicate");
      assert.notEqual(rec.outcome.reasonCode, "unreachable-at-screening");
    }
  });
});
