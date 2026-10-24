// Plan 08-01: the submission video's script. Checks the timing budget, the
// required content (SC1 items, SUB-04), placeholder declarations, the speaking
// rate and the review's wording rules.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const script = JSON.parse(fs.readFileSync(new URL("../../scripts/video/script.json", import.meta.url), "utf8"));
const beats = script.beats;
const CRITERIA = new Set(["Technological Implementation", "Design", "Potential Impact", "Quality of the Idea"]);
const SC1 = ["headline", "evidence-gathering", "gate-first-report", "injection", "agreement", "pdf"];
const METHODS = new Set(["cdp", "obs", "card", "pdf"]);
const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
const used = (s) => [...s.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]);

test("beats sum to at most 175 seconds, under the three-minute rule", () => {
  const total = beats.reduce((t, b) => t + b.seconds, 0);
  assert.ok(total <= 175, `total ${total}`);
  assert.equal(script.maxSeconds, 175);
});

test("every beat is well formed and serves a judging criterion", () => {
  const ids = new Set();
  for (const b of beats) {
    assert.ok(!ids.has(b.id), `duplicate ${b.id}`);
    ids.add(b.id);
    assert.ok(Array.isArray(b.criterion) && b.criterion.length > 0, b.id);
    for (const c of b.criterion) assert.ok(CRITERIA.has(c), `${b.id}: ${c}`);
    assert.ok(b.sc1Item === null || SC1.includes(b.sc1Item), b.id);
    assert.ok([null, "nemotron", "tavily"].includes(b.sub04), b.id);
    assert.ok(METHODS.has(b.method), `${b.id}: ${b.method}`);
    assert.ok(b.narration && b.onScreen && b.source, b.id);
    assert.ok(words(b.onScreen) <= 12, `${b.id} onScreen has ${words(b.onScreen)} words`);
  }
});

test("each of the six SC1 items has a beat", () => {
  for (const item of SC1) assert.ok(beats.some((b) => b.sc1Item === item), item);
});

test("SUB-04: one beat names Nemotron on Nebius Token Factory, one names Tavily", () => {
  assert.ok(beats.some((b) => b.sub04 === "nemotron" && /Nemotron/.test(b.onScreen) && /Nebius Token Factory/.test(b.onScreen)));
  assert.ok(beats.some((b) => b.sub04 === "tavily" && /Tavily/.test(b.onScreen)));
});

test("placeholders: every one used is declared with a source, and every declared one is used", () => {
  for (const b of beats) {
    const inText = new Set([...used(b.narration), ...used(b.onScreen)]);
    const declared = Object.keys(b.placeholders ?? {});
    for (const name of inText) {
      const p = b.placeholders?.[name];
      assert.ok(p, `${b.id}: {{${name}}} not declared`);
      assert.ok(typeof p.file === "string" && p.file && typeof p.jsonPath === "string" && p.jsonPath, `${b.id}: ${name} source`);
    }
    for (const name of declared) assert.ok(inText.has(name), `${b.id}: ${name} declared but unused`);
  }
});

test("narration fits its slot at 2.6 words per second or fewer", () => {
  for (const b of beats) assert.ok(words(b.narration) <= 2.6 * b.seconds, `${b.id}: ${words(b.narration)} words in ${b.seconds} s`);
});

test("wording rules: no deficit, certification, score or priority words", () => {
  const banned = /\b(lacks?|lacking|missing|fail(s|ed|ing)?|compliant|compliance|certified|score[sd]?|first|only)\b/i;
  for (const b of beats) {
    assert.ok(!banned.test(b.narration), `${b.id} narration`);
    assert.ok(!banned.test(b.onScreen), `${b.id} onScreen`);
  }
});

// 08-FRAMING.md wording guards (Helen, 2026-10-24) and 08-DECISIONS-HELEN.md (t4, i2).
test("framing guards: no runtime-Tavily or every-positive claims; injection labelled synthetic; framing close line", () => {
  const all = (b) => `${b.narration} ${b.onScreen}`;
  for (const b of beats) {
    assert.ok(!/confirms? (each|every) positive/i.test(all(b)), `${b.id}: every-positive claim`);
    assert.ok(!/Nemotron (codes|coded) (all|every)/i.test(all(b)), `${b.id}: Nemotron-does-all-coding claim`);
    if (/91\.5/.test(all(b))) assert.ok(/exploratory/i.test(b.narration) && /exploratory/i.test(b.onScreen), `${b.id}: 91.5% unlabelled`);
  }
  // t4: Tavily appears only in prototype/close beats, never in an app (cdp) beat.
  for (const b of beats.filter((x) => x.method === "cdp")) assert.ok(!/Tavily/.test(all(b)), `${b.id}: app beat names Tavily`);
  const inj = beats.find((b) => b.sc1Item === "injection");
  assert.match(inj.onScreen, /synthetic fixture/i);
  assert.match(inj.narration, /synthetic fixture/i);
  assert.match(beats.at(-1).narration, /Built and proven on Nebius Token Factory and Tavily, and designed to scale by plugging in other providers/);
});

// J3 (judges' review): the video opens on the outcome. A finished gate-first report is on
// screen before t = 30 s, counting each earlier beat at the longer of its slot and its
// narration at 2.6 words per second plus build.sh's 0.6 s tail.
test("J3: the gate-first report beat starts before 30 seconds", () => {
  const i = beats.findIndex((b) => b.sc1Item === "gate-first-report");
  assert.ok(i >= 0, "no gate-first-report beat");
  const start = beats.slice(0, i).reduce((t, b) => t + Math.max(b.seconds, words(b.narration) / 2.6 + 0.6), 0);
  assert.ok(start < 30, `report beat starts at ${start.toFixed(1)} s`);
  assert.equal(beats[i].method, "cdp", "the report beat shows the app, not a card");
});

// Job A (Helen, 2026-10-24): a beat whose frames show synthetic fixture data says so on every frame.
test("fixture beats carry a visible Synthetic fixture caption; other beats do not", async () => {
  const { captionHtml, cardHtml, FIXTURE_CAPTION } = await import("../../scripts/video/capture.mjs");
  assert.equal(FIXTURE_CAPTION, "Synthetic fixture");
  for (const b of beats) {
    assert.equal(typeof b.fixtureData, "boolean", `${b.id}: fixtureData`);
    if (/fixture/i.test(b.source)) assert.equal(b.fixtureData, true, `${b.id}: its source is a fixture`);
    const shown = `${captionHtml(b)}\n${cardHtml(b)}`;
    if (b.fixtureData) {
      assert.notEqual(b.method, "card", `${b.id}: a fixture beat needs the caption strip`);
      assert.ok(captionHtml(b).includes(`>${FIXTURE_CAPTION}</div>`), `${b.id}: caption lacks the label`);
      assert.ok(cardHtml(b).includes(`>${FIXTURE_CAPTION}</div>`), `${b.id}: card lacks the label`);
      assert.match(b.onScreen, /synthetic fixture/i, b.id);
    } else assert.ok(!shown.includes(`>${FIXTURE_CAPTION}</div>`), `${b.id}: labelled but not fixture`);
  }
  assert.ok(beats.some((b) => b.fixtureData), "at least the injection beat is fixture data");
});
