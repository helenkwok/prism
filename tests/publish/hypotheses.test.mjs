// PUB-01: confirmatory hypotheses H1-H3 (protocol section 8, R08, R09).
// Expected values are hand-computed: C(10,8)+C(10,9)+C(10,10) = 45+10+1 = 56.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { binomialTail, h1, h3, holm, testHypotheses } from "../../src/publish/hypotheses.ts";

describe("exact binomial tail at p = 0.5", () => {
  test("binomial-exact: P(X >= 8 | n = 10) = 56/1024", () => {
    assert.ok(Math.abs(binomialTail(10, 8, "upper") - 0.0546875) < 1e-12);
  });

  test("binomial-symmetry: P(X <= 2 | n = 10) = 56/1024 too", () => {
    assert.ok(Math.abs(binomialTail(10, 2, "lower") - 0.0546875) < 1e-12);
  });

  test("binomial-complement: upper(300, 150) + lower(300, 149) = 1", () => {
    const s = binomialTail(300, 150, "upper") + binomialTail(300, 149, "lower");
    assert.ok(Math.abs(s - 1) < 1e-12, String(s));
  });

  test("binomial-edges: empty and full tails", () => {
    assert.equal(binomialTail(10, 0, "upper"), 1);
    assert.equal(binomialTail(10, 11, "upper"), 0);
    assert.equal(binomialTail(10, 10, "lower"), 1);
    assert.equal(binomialTail(10, -1, "lower"), 0);
  });
});

describe("Holm step-down (section 8)", () => {
  test("holm-step-down: 0.01 and 0.04 adjust to 0.02 and 0.04, both rejected", () => {
    const r = holm([{ id: "h1", p: 0.01 }, { id: "h3", p: 0.04 }], 0.05);
    assert.ok(Math.abs(r[0].pAdjusted - 0.02) < 1e-12);
    assert.ok(Math.abs(r[1].pAdjusted - 0.04) < 1e-12);
    assert.deepEqual(r.map((t) => t.rejected), [true, true]);
  });

  test("holm-step-down: 0.03 and 0.04 reject neither (0.06 stops the step-down)", () => {
    const r = holm([{ id: "h1", p: 0.03 }, { id: "h3", p: 0.04 }], 0.05);
    assert.ok(Math.abs(r[0].pAdjusted - 0.06) < 1e-12);
    assert.ok(Math.abs(r[1].pAdjusted - 0.06) < 1e-12, "adjusted p is made monotone");
    assert.deepEqual(r.map((t) => t.rejected), [false, false]);
  });

  test("holm keeps input order", () => {
    const r = holm([{ id: "a", p: 0.04 }, { id: "b", p: 0.01 }], 0.05);
    assert.deepEqual(r.map((t) => t.id), ["a", "b"]);
    assert.ok(Math.abs(r[1].pAdjusted - 0.02) < 1e-12);
  });
});

describe("R09 recall-bound sensitivity in the adverse direction", () => {
  test("r09-adverse: H1 uses P(X >= c) and floor(c x r) claimed launches", () => {
    const r = h1({ c: 170, n: 300, recall: 0.894 });
    assert.equal(r.p, binomialTail(300, 170, "upper"));
    assert.equal(r.sensitivity.c, 151);
    assert.equal(r.sensitivity.p, binomialTail(300, 151, "upper"));
    assert.ok(Math.abs(r.share - 170 / 300) < 1e-12);
  });

  test("r09-adverse: H3 uses P(X <= c) and min(n, ceil(c / r)) evidencing launches", () => {
    const r = h3({ c: 100, n: 300, recall: 0.894 });
    assert.equal(r.p, binomialTail(300, 100, "lower"));
    assert.equal(r.sensitivity.c, 112);
    assert.equal(r.sensitivity.p, binomialTail(300, 112, "lower"));
    assert.equal(h3({ c: 290, n: 300, recall: 0.5 }).sensitivity.c, 300, "capped at n");
  });

  test("r09-adverse: exact products are not pushed over an integer by rounding", () => {
    assert.equal(h1({ c: 100, n: 300, recall: 0.9 }).sensitivity.c, 90);
    assert.equal(h3({ c: 90, n: 300, recall: 0.9 }).sensitivity.c, 100);
  });

  test("r09-adverse: supported needs the primary AND the sensitivity analysis after Holm", () => {
    // H1 primary p ~ 0.012 rejects, but 151 of 300 does not; H3 holds in both.
    const out = testHypotheses({
      h1: { c: 170, n: 300 },
      h2: { id: "h2", tested: false, reason: "a group has fewer than 30 included launches", groups: {} },
      h3: { c: 100, n: 300 },
      recall: 0.894,
    });
    const byId = Object.fromEntries(out.tests.map((t) => [t.id, t]));
    assert.equal(byId.h1.rejected, true);
    assert.equal(byId.h1.sensitivity.rejected, false);
    assert.equal(byId.h1.supported, false);
    assert.equal(byId.h3.supported, true);
  });
});
