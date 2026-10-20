// VAL-03 / D-54: agreement statistics (protocol §4, R06, R07, R10).

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ESTIMABLE_MIN_GOLD_PASSES,
  binary,
  bootstrapCI,
  estimable,
  uniform,
  wilson,
} from "../../src/pipeline/validate/agreement.ts";

/** n=20, 11 coder passes, 11 gold passes, 16 agreements → pa 0.8, pi 0.55, AC1 0.6040. */
function toyBinary() {
  const a = [];
  const b = [];
  for (let i = 0; i < 9; i++) {
    a.push(true);
    b.push(true);
  }
  for (let i = 0; i < 2; i++) {
    a.push(true);
    b.push(false);
  }
  for (let i = 0; i < 2; i++) {
    a.push(false);
    b.push(true);
  }
  for (let i = 0; i < 7; i++) {
    a.push(false);
    b.push(false);
  }
  return { a, b };
}

describe("binary agreement (VAL-03 / R06)", () => {
  test("toy example: pa 0.8, AC1 0.6040 to 4 dp", () => {
    const { a, b } = toyBinary();
    const r = binary(a, b);
    assert.equal(r.n, 20);
    assert.equal(r.coderPasses, 11);
    assert.equal(r.goldPasses, 11);
    assert.equal(r.pa, 0.8);
    assert.equal(Number(r.ac1.toFixed(4)), 0.604);
  });

  test("constant not-pass: kappa null, AC1 defined, precision and recall null", () => {
    const a = Array(10).fill(false);
    const b = Array(10).fill(false);
    const r = binary(a, b);
    assert.equal(r.pa, 1);
    assert.equal(r.ac1, 1);
    assert.equal(r.kappa, null);
    assert.equal(r.precision, null);
    assert.equal(r.recall, null);
  });

  test("precision null when coder proposes no pass; recall null when gold has no pass", () => {
    const noCoder = binary([false, false, false, false], [true, true, true, false]);
    assert.equal(noCoder.precision, null);
    assert.ok(typeof noCoder.recall === "number");

    const noGold = binary([true, true, false, false], [false, false, false, false]);
    assert.equal(noGold.recall, null);
    assert.ok(typeof noGold.precision === "number");
  });
});

describe("wilson and estimable (R07 / R10)", () => {
  test("wilson(0, 50) upper approx 0.0713; wilson(7, 10) matches closed form to 4 dp", () => {
    const [, u0] = wilson(0, 50);
    assert.ok(Math.abs(u0 - 0.0713) < 0.0002, `wilson(0,50) upper=${u0}`);

    const z = 1.96;
    const x = 7;
    const n = 10;
    const p = x / n;
    const d = 1 + (z * z) / n;
    const c = p + (z * z) / (2 * n);
    const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    const expected = [(c - h) / d, (c + h) / d];
    const got = wilson(7, 10);
    assert.equal(Number(got[0].toFixed(4)), Number(expected[0].toFixed(4)));
    assert.equal(Number(got[1].toFixed(4)), Number(expected[1].toFixed(4)));
  });

  test("ESTIMABLE_MIN_GOLD_PASSES is 10; estimable(9) false, estimable(10) true", () => {
    assert.equal(ESTIMABLE_MIN_GOLD_PASSES, 10);
    assert.equal(estimable(9), false);
    assert.equal(estimable(10), true);
  });
});

describe("bootstrap stream (R07)", () => {
  test("uniform(seed, i) is in [0, 1)", () => {
    for (let i = 0; i < 20; i++) {
      const u = uniform("seed-a", i);
      assert.ok(u >= 0 && u < 1, `uniform out of range at i=${i}: ${u}`);
    }
  });

  test("bootstrapCI identical under same seed, different under another", () => {
    const projects = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
    const lengths = Object.fromEntries(projects.map((id, i) => [id, i + 1]));
    const stat = (sample) => sample.reduce((s, id) => s + lengths[id], 0) / sample.length;
    const a = bootstrapCI(projects, stat, "d1481ad50ed309ea", 500);
    const b = bootstrapCI(projects, stat, "d1481ad50ed309ea", 500);
    const c = bootstrapCI(projects, stat, "1a8a5e2c0f6afdcb", 500);
    assert.ok(a !== null && b !== null && c !== null);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
  });
});
