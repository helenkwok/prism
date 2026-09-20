import assert from "node:assert/strict";
import test from "node:test";
import {
  FLOOR,
  MIN_VALUES,
  auditRelease,
  buildRelease,
  closeRelease,
  evaluateFixture,
  loadFixtures,
  primarySuppressed,
  ranges,
} from "../protocol/disclosure/audit.mjs";

const fixtures = loadFixtures();

const tuple = (id, n, c, suppression) => (c === null ? { id, n, c, suppression: suppression ?? "primary" } : { id, n, c });
const row = (terms, sense, rhs, extra = {}) => ({ terms: terms.map(([id, coef]) => ({ id, coef })), sense, rhs, ...extra });

test("the exported constants are the ones the protocol quotes", () => {
  assert.equal(FLOOR, 10);
  assert.equal(MIN_VALUES, 5);
});

test("primary rule: count, complement and cohort size each trigger suppression", () => {
  assert.equal(primarySuppressed({ c: 70, n: 75 }), true); // complement 5
  assert.equal(primarySuppressed({ c: 5, n: 75 }), true); // count 5
  assert.equal(primarySuppressed({ c: 12, n: 75 }), false);
  assert.equal(primarySuppressed({ c: 40, n: 8 }), true); // cohort under the floor
  assert.equal(primarySuppressed({ c: 10, n: 20 }), false); // both sides exactly at the floor
  assert.equal(primarySuppressed({ c: 9, n: 75 }), true);
  assert.equal(primarySuppressed({ c: 66, n: 75 }), true); // complement 9
  assert.equal(primarySuppressed({ c: 65, n: 75 }), false); // complement 10
});

// Every stored expected value must equal a fresh solver run, so a solver or version change is caught.
for (const name of Object.keys(fixtures.fixtures)) {
  test(`fixture ${name}: stored expected values equal a fresh solver run`, async () => {
    const fresh = await evaluateFixture(name, fixtures);
    assert.deepEqual(fresh, fixtures.fixtures[name].expected);
  });
}

test("safe: unlinked suppressed tuples pass", () => {
  const e = fixtures.fixtures.safe.expected;
  assert.equal(e.verdict, "PASS");
  assert.deepEqual(e.primarySuppressed, ["x-q1", "y-q2"]);
});

test("differencing-fail: the planted differencing release FAILS with 4 feasible values per cell", () => {
  const e = fixtures.fixtures["differencing-fail"].expected;
  assert.equal(e.verdict, "FAIL");
  assert.deepEqual(e.failing, ["q3", "q4"]);
  assert.equal(e.cells.q3.count, 4);
  assert.equal(e.cells.q4.count, 4);
  assert.equal(e.cells.q3.feasible, "0-3");
});

test("closure: exactly one further tuple is suppressed and the audit then passes", () => {
  const e = fixtures.fixtures.closure.expected;
  assert.equal(e.added.length, 1);
  assert.equal(e.verdict, "PASS");
  assert.equal(e.suppression[e.added[0]], "complementary");
  // the smallest published count in the failing row is q1 (12), so it is the one chosen
  assert.deepEqual(e.added, ["q1"]);
});

test("complement-floor: 70 of 75 is suppressed by the complement clause; a count-only rule would publish it", () => {
  const e = fixtures.fixtures["complement-floor"].expected;
  assert.deepEqual(e.primarySuppressed, ["a-q1"]);
  assert.deepEqual(e.countOnlySuppressed, []);
});

test("soundness: the true value of every suppressed tuple is among its feasible values", async () => {
  for (const [name, fx] of Object.entries(fixtures.fixtures)) {
    if (!fx.data) continue;
    const release = buildRelease(fx.data);
    const audit = await auditRelease(release);
    const truth = new Map(fx.data.tuples.map((t) => [t.id, t.c]));
    for (const [id, cell] of Object.entries(audit.cells)) {
      assert.ok(cell.feasible.includes(truth.get(id)), `${name}: true value of ${id} was excluded by the audit`);
    }
  }
});

test("closeRelease terminates on every fixture and its result passes the audit", async () => {
  for (const [name, fx] of Object.entries(fixtures.fixtures)) {
    if (!fx.data) continue;
    const closed = await closeRelease(buildRelease(fx.data));
    const again = await auditRelease(closed.release);
    assert.equal(again.pass, true, `${name} did not pass after closure`);
  }
});

test("the closure step never reduces a passing release", async () => {
  const release = buildRelease(fixtures.fixtures.safe.data);
  const closed = await closeRelease(release);
  assert.deepEqual(closed.added, []);
});

test("a percentage row published for a tuple is unavailable once that tuple is suppressed", async () => {
  // q1 published 12 of 75 (16%, so 15.5 <= 100 q1/75 < 16.5) alongside the pinned total row
  const percent = (id, n, pct) => [
    row([[id, 100]], ">=", (pct - 0.5) * n, { requires: [id] }),
    row([[id, 100]], "<=", (pct + 0.5) * n - 1e-9, { requires: [id] }),
  ];
  const withPct = {
    tuples: [tuple("p", 75, null), tuple("s", 75, 20), tuple("t", 150, 26)],
    constraints: [row([["p", 1], ["s", 1], ["t", -1]], "=", 0), ...percent("s", 75, 27)],
  };
  // p + 20 = 26 pins p = 6: recoverable, so the audit fails
  assert.equal((await auditRelease(withPct)).pass, false);
  // once s is suppressed as well, its percentage rows drop out and the release is no longer pinned by them
  const both = structuredClone(withPct);
  both.tuples[1] = tuple("s", 75, null, "complementary");
  const a = await auditRelease(both);
  assert.equal(ranges(a.cells.p.feasible), "0-9");
  assert.equal(a.pass, true);
});

test("a previous release version is unioned in and can turn a passing release into a failing one", async () => {
  const now = {
    tuples: [tuple("a", 75, null), tuple("b", 75, 20), tuple("tot", 150, null, "complementary")],
    constraints: [row([["a", 1], ["b", 1], ["tot", -1]], "=", 0)],
  };
  assert.equal((await auditRelease(now)).pass, true);
  // an earlier version published the total: a + 20 = 26 now pins a
  const withHistory = { ...now, previous: [[row([["tot", 1]], "=", 26)]] };
  const audit = await auditRelease(withHistory);
  assert.equal(audit.pass, false);
  assert.deepEqual(audit.cells.a.feasible, [6]);
});

test("the audit counts feasible values, not the width between minimum and maximum", async () => {
  // q + r = 70 with both primary-suppressed: q is in {0..4} or {66..70}, ten values, width 71
  const release = {
    tuples: [tuple("q", 75, null), tuple("r", 75, null)],
    constraints: [row([["q", 1], ["r", 1]], "=", 70)],
  };
  const audit = await auditRelease(release);
  assert.equal(audit.cells.q.feasible.length, 10);
  assert.equal(ranges(audit.cells.q.feasible), "0-4,66-70");
  assert.equal(audit.pass, true);
});

test("a cell with a tiny cohort cannot make the audit unsatisfiable", async () => {
  const release = { tuples: [tuple("t", 3, null)], constraints: [] };
  const audit = await auditRelease(release);
  assert.equal(audit.pass, true);
  assert.equal(audit.cells.t.required, 4);
});

test("interior prior for complementary cells is stricter and is reported, not silent", async () => {
  const closed = await closeRelease(buildRelease(fixtures.fixtures["differencing-fail"].data));
  const interior = await auditRelease(closed.release, { complementaryPrior: "interior" });
  // q1 is complementary, so the reader knows 10 <= q1 <= 65; with q1 + q3 + q4 = 15 it lies in 10..15
  assert.equal(ranges(interior.cells.q1.feasible), "10-15");
  assert.ok(interior.cells.q1.feasible.length >= MIN_VALUES);
  await assert.rejects(() => auditRelease(closed.release, { complementaryPrior: "nope" }), /complementaryPrior/);
});

test("a contradictory release is rejected rather than reported safe", async () => {
  const bad = {
    tuples: [tuple("a", 75, 12), tuple("b", 75, 15), tuple("t", 150, 99)],
    constraints: [row([["a", 1], ["b", 1], ["t", -1]], "=", 0)],
  };
  await assert.rejects(() => auditRelease(bad), /contradict/);
  const impossible = {
    tuples: [tuple("q", 75, null), tuple("r", 75, null)],
    constraints: [row([["q", 1], ["r", 1]], "=", 30)], // no pair from the priors sums to 30
  };
  await assert.rejects(() => auditRelease(impossible), /infeasible/);
});

test("closure terminates with a clear error when nothing published can help", async () => {
  // q is pinned by a row over suppressed cells only; no published tuple exists to suppress
  const release = {
    tuples: [tuple("q", 75, null), tuple("r", 75, null, "complementary")],
    constraints: [row([["q", 1], ["r", 1]], "=", 3)],
  };
  await assert.rejects(() => closeRelease(release), /cannot close release/);
});

test("ranges formats runs", () => {
  assert.equal(ranges([0, 1, 2, 3, 66, 67]), "0-3,66-67");
  assert.equal(ranges([5]), "5");
  assert.equal(ranges([]), "");
});
