// VAL-03 / D-54: agreement statistics (protocol §4, R06, R07, R10).

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ESTIMABLE_MIN_GOLD_PASSES,
  agreementByCheck,
  binary,
  bootstrapCI,
  estimable,
  fourState,
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

describe("four-state AC1 (R06 secondary)", () => {
  test("hand-computed k=4 example: AC1 = 91/163 ≈ 0.5583", () => {
    // A: pass,pass,fail,unknown,claimed,claimed
    // B: pass,fail,fail,unknown,claimed,pass  → pa=4/6; pe=53/216; AC1=91/163
    const a = ["pass", "pass", "fail", "unknown", "claimed", "claimed"];
    const b = ["pass", "fail", "fail", "unknown", "claimed", "pass"];
    const r = fourState(a, b);
    assert.equal(r.n, 6);
    assert.equal(r.pa, 4 / 6);
    assert.equal(Number(r.ac1.toFixed(4)), 0.5583);
    assert.equal(r.kappa, (4 / 6 - 1 / 4) / (1 - 1 / 4));
  });
  test("constant four-state agreement leaves kappa undefined rather than inventing a value", () => {
    const result = fourState(["claimed", "claimed"], ["claimed", "claimed"]);
    assert.equal(result.pa, 1); assert.equal(result.ac1, 1); assert.equal(result.kappa, null);
  });
});

describe("agreementByCheck and pooled", () => {
  test("bootstrap preserves every replacement occurrence of each project and its whole cluster", () => {
    const rows = Array.from({ length: 20 }, (_, i) => [
      { projectN: i + 1, checkId: "c1", a: i < 10 ? "pass" : "unknown", b: i < 5 ? "pass" : "unknown" },
      { projectN: i + 1, checkId: "c2", a: i % 3 === 0 ? "pass" : "claimed", b: i % 4 === 0 ? "pass" : "fail" },
    ]).flat();
    const seed = "audit-fixture";
    const out = agreementByCheck(rows, ["c1", "c2"], seed);
    for (const entry of [...out.checks, out.pooled]) {
      const selectedRows = entry.checkId === "pooled" ? rows : rows.filter(row => row.checkId === entry.checkId);
      const expected = bootstrapCI(Array.from({ length: 20 }, (_, i) => String(i + 1)), sample => {
        const drawn = sample.flatMap(id => selectedRows.filter(row => row.projectN === Number(id)));
        return binary(drawn.map(row => row.a === "pass"), drawn.map(row => row.b === "pass")).precision;
      }, seed, 2000);
      assert.deepEqual(entry.precisionCI, expected, entry.checkId);
    }
  });
  test("binary and four-state intervals use the same replacement-preserving reference stream", () => {
    const rows = [
      { projectN: 1, checkId: "c1", a: "pass", b: "pass" },
      { projectN: 1, checkId: "c2", a: "claimed", b: "fail" },
      { projectN: 2, checkId: "c1", a: "fail", b: "claimed" },
      { projectN: 2, checkId: "c2", a: "pass", b: "pass" },
      { projectN: 3, checkId: "c1", a: "unknown", b: "unknown" },
      { projectN: 3, checkId: "c2", a: "claimed", b: "claimed" },
      { projectN: 4, checkId: "c1", a: "pass", b: "fail" },
      { projectN: 4, checkId: "c2", a: "unknown", b: "pass" },
    ];
    const seed = "four-state-fixture"; const B = 200;
    const out = agreementByCheck(rows, ["c1", "c2"], seed, B);
    for (const entry of [...out.checks, out.pooled]) {
      const cluster = entry.checkId === "pooled" ? rows : rows.filter(row => row.checkId === entry.checkId);
      const four = fourState(cluster.map(row => row.a), cluster.map(row => row.b));
      assert.equal(entry.fourStatePa, four.pa); assert.equal(entry.fourStateKappa, four.kappa); assert.equal(entry.fourStateAc1, four.ac1);
      for (const [key, state, metric] of [["paCI", "binary", "pa"], ["ac1CI", "binary", "ac1"], ["kappaCI", "binary", "kappa"], ["recallCI", "binary", "recall"], ["fourStatePaCI", "four", "pa"], ["fourStateKappaCI", "four", "kappa"], ["fourStateAc1CI", "four", "ac1"]]) {
        const expected = bootstrapCI(["1", "2", "3", "4"], sample => {
          const drawn = sample.flatMap(id => cluster.filter(row => row.projectN === Number(id)));
          const value = state === "binary" ? binary(drawn.map(row => row.a === "pass"), drawn.map(row => row.b === "pass")) : fourState(drawn.map(row => row.a), drawn.map(row => row.b));
          return value[metric];
        }, seed, B);
        assert.deepEqual(entry[key], expected, `${entry.checkId}/${key}`);
      }
    }
  });
  test("per-check order, binary+fourState, estimable, bootstrap CIs; pooled separate; empty check safe", () => {
    const rows = [
      { projectN: 1, checkId: "c1", a: "pass", b: "pass" },
      { projectN: 1, checkId: "c2", a: "fail", b: "fail" },
      { projectN: 2, checkId: "c1", a: "pass", b: "claimed" },
      { projectN: 2, checkId: "c2", a: "pass", b: "pass" },
      { projectN: 3, checkId: "c1", a: "unknown", b: "unknown" },
      { projectN: 3, checkId: "c2", a: "claimed", b: "pass" },
    ];
    const checkIds = ["c1", "c2", "c-missing"];
    const out = agreementByCheck(rows, checkIds, "d1481ad50ed309ea", 100);
    assert.equal(out.checks.length, 3);
    assert.deepEqual(
      out.checks.map((c) => c.checkId),
      checkIds,
    );

    const c1 = out.checks[0];
    assert.equal(c1.n, 3);
    assert.ok(typeof c1.ac1 === "number");
    assert.ok(typeof c1.fourStateAc1 === "number");
    assert.equal(c1.estimable, false); // goldPasses < 10
    assert.ok(c1.ac1CI === null || (Array.isArray(c1.ac1CI) && c1.ac1CI.length === 2));
    assert.ok("precisionCI" in c1 && "recallCI" in c1 && "kappaCI" in c1 && "paCI" in c1);

    const missing = out.checks[2];
    assert.equal(missing.n, 0);
    assert.equal(missing.estimable, false);
    assert.equal(missing.fourStateKappa, null); assert.equal(missing.fourStatePaCI, null); assert.equal(missing.fourStateKappaCI, null); assert.equal(missing.fourStateAc1CI, null);

    const pooledBefore = JSON.stringify(out.checks);
    assert.ok(out.pooled);
    assert.equal(out.pooled.n, 6);
    assert.ok(typeof out.pooled.ac1 === "number");
    assert.equal(JSON.stringify(out.checks), pooledBefore);
  });
});
