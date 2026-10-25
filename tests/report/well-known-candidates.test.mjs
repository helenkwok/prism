// Plan 07-14: the §11 candidate pass and the D-81 sponsor flags, on synthetic spans only.
import assert from "node:assert/strict";
import { test } from "node:test";

import { sponsorMentions, wellKnownCandidates } from "../../src/report/well-known-candidates.ts";

const span = (projectId, text, spanId = "p1-s001") => ({ projectId, spanId, text, url: `https://${projectId.toLowerCase()}.example/about` });

test("finds 120 employees, raised $12M and a NASDAQ ticker, each with its span, URL and quote", () => {
  const got = wellKnownCandidates([
    span("A", "We are a team of 120 employees across three offices."),
    span("B", "Last year we raised $12M in a Series A led by funds.", "p2-s004"),
    span("C", "Our parent company trades as NASDAQ: ABCD since 2019."),
  ]);
  assert.deepEqual(
    got.map((c) => [c.projectId, c.pattern, c.spanId]),
    [
      ["A", "employees", "p1-s001"],
      ["B", "funding", "p2-s004"],
      ["C", "listed", "p1-s001"],
    ],
  );
  assert.match(got[0].quote, /120 employees/);
  assert.equal(got[1].url, "https://b.example/about");
});

test("below the §11 thresholds is not a candidate", () => {
  assert.deepEqual(wellKnownCandidates([span("A", "A team of 12 employees."), span("B", "We raised $2M seed funding."), span("C", "Saves you $50M hours")]), []);
});

test("thousands and billions count", () => {
  const got = wellKnownCandidates([span("A", "2,500 employees worldwide"), span("B", "raised $1.2B to date")]);
  assert.deepEqual(got.map((c) => c.pattern), ["employees", "funding"]);
});

test("a span naming Nemotron flags its project for a sponsor hold; others are not flagged", () => {
  const got = sponsorMentions([span("A", "Runs on Nemotron via a hosted API."), span("B", "Runs on a local model."), span("C", "Search powered by Tavily.")]);
  assert.deepEqual(got.map((m) => [m.projectId, m.sponsor]), [
    ["A", "NVIDIA"],
    ["C", "Tavily"],
  ]);
});
