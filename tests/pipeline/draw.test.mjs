// DSC-02 + A5: the screened seeded draw, and the screener's reply contract.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { drawScreened, MIN_STAGE2_CHARS } from "../../src/pipeline/select/draw.ts";
import { parseScreenReply } from "../../src/pipeline/select/screen-model.ts";

const post = (id, title, url = `https://${id}.example.com/`) => ({ id, title, url, created_at: "2026-01-01T00:00:00Z" });
const okPreflight = (text) => async (p) => ({
  entry_url: p.url,
  final_url: p.url,
  boundary: { kind: "host" },
  type_class: "own-domain",
  page_text: text(p),
  preflight: { robots_blocked: false, boundary_ok: true },
});
const longText = "an AI product page ".repeat(Math.ceil(MIN_STAGE2_CHARS / 19) + 1);

describe("drawScreened", () => {
  test("every walked candidate gets exactly one outcome and the draw stops at targetN", async () => {
    const posts = Array.from({ length: 30 }, (_, i) => post(`p${i}`, i % 3 === 0 ? "a todo app" : "an AI agent"));
    const { entries, log, counts } = await drawScreened({
      posts,
      seed: "s",
      targetN: 5,
      screen1: async (p) => (p.title.includes("todo") ? { include: false, reasonCode: "not-ai" } : { include: true, reasonCode: null }),
      preflight: okPreflight(() => longText),
      screen2: async () => ({ include: true, reasonCode: null }),
    });
    assert.equal(entries.length, 5);
    assert.deepEqual(entries.map((e) => e.n), [1, 2, 3, 4, 5]);
    assert.equal(new Set(log.map((l) => l.id)).size, log.length, "one outcome per candidate");
    assert.equal(counts.screened, log.length);
    assert.equal(counts.included + counts["included-insufficient-text"] + (counts["stage1:not-ai"] ?? 0), log.length);
    assert.equal(entries.at(-1).draw_rank, log.length, "the last inclusion is the last walked record");
  });

  test("stage 2 never decides on too little text; the candidate is included and marked", async () => {
    let stage2Calls = 0;
    const { entries, counts } = await drawScreened({
      posts: [post("a", "x")],
      targetN: 1,
      screen1: async () => ({ include: true, reasonCode: null }),
      preflight: okPreflight(() => "Loading..."),
      screen2: async () => (stage2Calls++, { include: false, reasonCode: "not-ai" }),
    });
    assert.equal(stage2Calls, 0);
    assert.equal(entries[0].stage2, "insufficient-text");
    assert.equal(counts["included-insufficient-text"], 1);
  });

  test("stage 2 exclusions, unreachable, robots-blocked and duplicate hosts are each recorded", async () => {
    const posts = [post("a", "x", "https://same.example.com/a"), post("b", "x", "https://same.example.com/b"), post("c", "x"), post("d", "x"), post("e", "x")];
    const { log, counts } = await drawScreened({
      posts,
      targetN: 99,
      screen1: async () => ({ include: true, reasonCode: null }),
      preflight: async (p) =>
        p.id === "c" ? null
        : { entry_url: p.url, final_url: p.url, boundary: {}, type_class: "own-domain", page_text: longText, preflight: { robots_blocked: p.id === "d", boundary_ok: true } },
      screen2: async (p) => (p.id === "e" ? { include: false, reasonCode: "ai-adjacent" } : { include: true, reasonCode: null }),
    });
    assert.equal(log.length, 5);
    assert.equal(counts["stage2:unreachable-at-screening"], 1);
    assert.equal(counts["not-collectable:robots-blocked"], 1);
    assert.equal(counts["stage2:ai-adjacent"], 1);
    assert.equal(counts.included, 1);
    assert.equal(counts["stage1:duplicate"], 1);
  });
});

describe("parseScreenReply", () => {
  test("accepts an inclusion and a coded exclusion", () => {
    assert.deepEqual(parseScreenReply('{"include":true,"reasonCode":null}'), { include: true, reasonCode: null });
    assert.deepEqual(parseScreenReply('{"include":false,"reasonCode":"not-ai"}'), { include: false, reasonCode: "not-ai" });
  });
  test("rejects off-contract replies so the caller retries", () => {
    for (const raw of ['{"include":false,"reasonCode":null}', '{"include":false,"reasonCode":"duplicate"}', '{"include":true,"reasonCode":"not-ai"}', '{"include":"yes"}', "not json"]) {
      assert.throws(() => parseScreenReply(raw), undefined, raw);
    }
  });
});
