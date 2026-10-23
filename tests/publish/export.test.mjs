// PUB-03 / PUB-01: the export boundary on the synthetic store (plan 06-01).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { auditRelease, buildRelease, closeRelease, loadFixtures } from "../../protocol/disclosure/audit.mjs";
import { wilson } from "../../src/pipeline/validate/agreement.ts";
import { PARTITIONS, STATES, checkShares, expandFixture, tupleId } from "../../src/publish/aggregate.ts";
import { exportRelease, secure } from "../../src/publish/export.ts";
import { buildTables, toTruth } from "../../src/publish/release-model.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STORE = path.join(REPO, "tests/fixtures/publish/synthetic-store.json");
const COMMITTED = path.join(REPO, "tests/fixtures/publish/public-data-synthetic");
const raw = () => JSON.parse(fs.readFileSync(STORE, "utf8"));

const LOW = "acceptance-criteria-met"; // 6 passes of 300
const HIGH = "output-reproducible"; // 295 passes of 300
const MISSED = "deliverable-gate-passed";
const NOT_ESTIMABLE = "recovery-tested";
const PLANT = "fallback-defined";

/** A fresh, empty parent dir; the export writes <parent>/out and its temp sibling lives in <parent>. */
function outDir() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "prism-export-")), "out");
}
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");
const rowsOf = (release) => Object.values(release.figures).flatMap((f) => f.rows);
const row = (release, id) => rowsOf(release).find((r) => r.id === id);

/** Set the pass count of one check in one quarter to `count` by turning passes into unknowns. */
function plantQuarter(store, checkId, quarter, count) {
  const k = store.checkIds.indexOf(checkId);
  let keep = count;
  for (const p of store.projects) {
    if (p.quarter !== quarter || p.states[k] !== "p") continue;
    if (keep > 0) keep--;
    else p.states = p.states.slice(0, k) + "u" + p.states.slice(k + 1);
  }
  return store;
}

function cli(store, out = outDir()) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "prism-store-")), "store.json");
  fs.writeFileSync(file, JSON.stringify(store));
  const res = spawnSync(process.execPath, ["src/publish/export.ts", "--store", file, "--out", out], { cwd: REPO, encoding: "utf8" });
  return { stdout: res.stdout, stderr: res.stderr, out };
}

function assertNothingWritten(out) {
  assert.deepEqual(fs.readdirSync(path.dirname(out)), [], "no out dir and no temp sibling after a refusal");
}

const base = await exportRelease({ input: expandFixture(raw()), outDir: outDir() });

describe("task 1: synthetic store to an audited release", () => {
  test("base export: fixture kind, every publishable tuple, both priors pass", () => {
    assert.equal(base.line.kind, "fixture");
    assert.equal(base.line.audit, "pass(all,interior)");
    // 23 publishable checks (one is missed) x 2 states x 7 partitions with launches
    assert.equal(base.line.tuples, 23 * 2 * 7);
    assert.equal(base.release.kind, "fixture");
    assert.equal(base.release.date, "2026-10-30");
    assert.equal(base.release.n, 300);
  });

  test("6 of 300 renders lt10 with no number; 295 of 300 renders suppressed", () => {
    assert.deepEqual(Object.keys(row(base.release, tupleId(LOW, "pass", "all"))).sort(), ["id", "label", "state"]);
    assert.equal(row(base.release, tupleId(LOW, "pass", "all")).state, "lt10");
    const high = row(base.release, tupleId(HIGH, "pass", "all"));
    assert.equal(high.state, "suppressed");
    for (const k of ["c", "n", "pct", "ci"]) assert.equal(high[k], undefined);
  });

  test("released rows carry c, n, pct and the rounded Wilson interval; no other row carries a number", () => {
    let released = 0;
    for (const r of rowsOf(base.release)) {
      if (r.state !== "released") {
        for (const k of ["c", "n", "pct", "ci"]) assert.equal(r[k], undefined, `${r.id} ${k}`);
        continue;
      }
      released++;
      const [lo, hi] = wilson(r.c, r.n);
      assert.equal(r.pct, Math.round((100 * r.c) / r.n));
      assert.deepEqual(r.ci, [Math.round(100 * lo), Math.round(100 * hi)]);
    }
    assert.ok(released > 0);
  });

  test("manifest digest matches the file, and two runs are byte-identical", async () => {
    const a = outDir();
    const b = outDir();
    await exportRelease({ input: expandFixture(raw()), outDir: a });
    await exportRelease({ input: expandFixture(raw()), outDir: b });
    const manifest = JSON.parse(read(a, "v1/manifest.json"));
    assert.equal(manifest.files["release.json"], crypto.createHash("sha256").update(read(a, "v1/release.json")).digest("hex"));
    for (const f of ["v1/release.json", "v1/manifest.json", "ledger.json"]) assert.equal(read(a, f), read(b, f), f);
    assert.deepEqual(fs.readdirSync(path.dirname(a)), ["out"], "no temp sibling left");
  });
});

describe("task 2: partitions, display rows, ledger, planted cells", () => {
  test("partition-sums: quarters and sources each sum to the pooled count; pass + claimed <= n", () => {
    const input = expandFixture(raw());
    for (const state of STATES) {
      const by = Object.fromEntries(PARTITIONS.map((p) => [p, checkShares(input, p, state)]));
      input.checkIds.forEach((_, k) => {
        const sum = (ps) => ps.reduce((s, p) => s + by[p][k].c, 0);
        assert.equal(sum(["q1", "q2", "q3", "q4"]), by.all[k].c);
        assert.equal(sum(["src:show-hn", "src:reddit", "src:github-only"]), by.all[k].c);
      });
    }
    for (const p of PARTITIONS) {
      const pass = checkShares(input, p, "pass");
      const claimed = checkShares(input, p, "claimed");
      pass.forEach((s, k) => assert.ok(s.c + claimed[k].c <= s.n));
    }
  });

  test("GitHub-only has no launches: absent rows with the fixed reason, no tuple", () => {
    const r = row(base.release, tupleId(PLANT, "pass", "src:github-only"));
    assert.deepEqual(r.state, "absent");
    assert.equal(r.reason, "no GitHub-only launches met the inclusion criteria");
  });

  test("the Reddit group (n 6) is suppressed in every cell and the export still succeeds", () => {
    const reddit = rowsOf(base.release).filter((r) => r.id.endsWith("|src:reddit") && !r.id.includes(MISSED));
    assert.equal(reddit.length, 23 * 2);
    assert.ok(reddit.every((r) => r.state === "lt10"));
  });

  test("display-rows: every <10 tuple carries c <= 9 and every suppressed tuple c >= 10", async () => {
    const s = await secure(toTruth(buildTables(expandFixture(raw()))));
    const rows = new Map(s.release.constraints.filter((c) => c.terms.length === 1).map((c) => [c.terms[0].id, c]));
    for (const t of s.release.tuples.filter((t) => t.c === null)) {
      const r = rows.get(t.id);
      assert.ok(r, t.id);
      assert.deepEqual([r.sense, r.rhs], s.display.get(t.id) === "lt10" ? ["<=", 9] : [">=", 10]);
    }
  });

  test("display-rows: two <10 cells summing to a published total pass without the rows and need closure with them", async () => {
    const truth = {
      tuples: [
        { id: "a", n: 20, c: 8 },
        { id: "b", n: 20, c: 9 },
        { id: "c", n: 40, c: 20 },
        { id: "t", n: 80, c: 37 },
      ],
      constraints: [{ terms: [{ id: "a", coef: 1 }, { id: "b", coef: 1 }, { id: "c", coef: 1 }, { id: "t", coef: -1 }], sense: "=", rhs: 0 }],
    };
    const without = await secure(truth, { display: false });
    assert.deepEqual(without.added, []);
    const shown = structuredClone(without.release);
    shown.constraints.push(...["a", "b"].map((id) => ({ terms: [{ id, coef: 1 }], sense: "<=", rhs: 9 })));
    assert.equal((await auditRelease(shown, { complementaryPrior: "interior" })).pass, false);
    const withRows = await secure(truth);
    assert.ok(withRows.added.length > 0);
  });

  test("plant-closable: a quarter cell recoverable by differencing is closed, not refused", async () => {
    const res = await exportRelease({ input: expandFixture(plantQuarter(raw(), PLANT, 3, 5)), outDir: outDir() });
    assert.equal(res.line.audit, "pass(all,interior)");
    assert.equal(row(res.release, tupleId(PLANT, "pass", "q3")).state, "lt10");
    const quarterSide = ["all", "q1", "q2", "q4"].map((p) => tupleId(PLANT, "pass", p));
    assert.ok(res.manifest.audit.added.some((id) => quarterSide.includes(id)), "closure suppressed a tuple of the quarter row");
  });

  test("plant-ledger-pinned: a cell published before that the new release would suppress refuses", () => {
    const store = plantQuarter(raw(), PLANT, 3, 5);
    store.ledger = [{ id: tupleId(PLANT, "pass", "q3"), n: 75, c: 12, version: "v0" }];
    const { stdout, out } = cli(store);
    assert.match(stdout, /^EXPORT REFUSED: ledger-pinned /m);
    assertNothingWritten(out);
  });

  test("ledger: the first export lists every published tuple; a later version unions it in and appends only new ones", async () => {
    const out = outDir();
    const v1 = await exportRelease({ input: expandFixture(raw()), outDir: out });
    const published = rowsOf(v1.release).filter((r) => r.state === "released");
    assert.equal(v1.ledger.length, published.length);
    assert.ok(v1.ledger.every((e) => e.version === "v1"));
    const next = raw();
    next.release.version = "v2";
    const v2 = await exportRelease({ input: expandFixture(next), outDir: out });
    assert.equal(v2.ledger.length, v1.ledger.length);
    assert.ok(fs.existsSync(path.join(out, "v1/release.json")) && fs.existsSync(path.join(out, "v2/release.json")));
  });

  test("component split gives the same suppressions as the whole model on the reference fixtures", async () => {
    const fx = loadFixtures();
    for (const [name, f] of Object.entries(fx.fixtures)) {
      if (!f.data) continue;
      const pick = (s) => s.release.tuples.map((t) => [t.id, t.c, t.suppression ?? null]);
      const whole = await secure(f.data, { display: false, split: false });
      const split = await secure(f.data, { display: false, split: true });
      assert.deepEqual(pick(split), pick(whole), name);
      assert.deepEqual([...split.added].sort(), [...whole.added].sort(), name);
    }
    // the reference closure on differencing-fail adds the same tuple
    const ref = await closeRelease(buildRelease(fx.fixtures["differencing-fail"].data), { complementaryPrior: "interior" });
    assert.deepEqual((await secure(fx.fixtures["differencing-fail"].data, { display: false })).added, ref.added);
  });
});

describe("task 3: input refusals, withheld rows, committed release", () => {
  test("context-record: a record tagged context refuses with nothing written", () => {
    const store = raw();
    store.projects[0].tag = "context";
    const { stdout, out } = cli(store);
    assert.match(stdout, /^EXPORT REFUSED: context-record /m);
    assertNothingWritten(out);
    const picks = raw();
    picks.picks = [{ url: "https://synthetic-pick.example/", tag: "context" }];
    assert.match(cli(picks).stdout, /^EXPORT REFUSED: context-record /m);
  });

  for (const basis of ["unconfirmed", "stale"]) {
    test(`unconfirmed-positive: one positive with basis ${basis} refuses with nothing written`, () => {
      const store = raw();
      store.unconfirmed = [{ projectN: 1, checkId: PLANT, basis }];
      const { stdout, out } = cli(store);
      assert.match(stdout, /^EXPORT REFUSED: unconfirmed-positive /m);
      assertNothingWritten(out);
    });
  }

  test("withheld rows: no tuple, fixed reason per status, never the gate's own text", async () => {
    const store = raw();
    store.gate.checks.find((g) => g.checkId === MISSED).reason = "AC1 0.41 under 0.60";
    store.gate.checks.find((g) => g.checkId === PLANT).status = "withheld";
    const res = await exportRelease({ input: expandFixture(store), outDir: outDir() });
    const missed = rowsOf(res.release).filter((r) => r.id.includes(`|${MISSED}|`));
    assert.equal(missed.length, 2 * 8);
    assert.ok(missed.every((r) => r.state === "withheld" && r.reason === "agreement below the pre-registered threshold"));
    const withheld = rowsOf(res.release).filter((r) => r.id.includes(`|${PLANT}|`));
    assert.ok(withheld.every((r) => r.state === "withheld" && r.reason === "withheld under the pre-registered shortfall rule"));
    assert.equal(res.line.tuples, 22 * 2 * 7);
    for (const r of rowsOf(res.release)) {
      for (const k of ["reason", "note"]) if (r[k]) assert.doesNotMatch(r[k], /\d/, `${r.id} ${k}`);
    }
  });

  test("released-not-estimable rows stay released with their numbers and carry the R10 note", () => {
    const rows = rowsOf(base.release).filter((r) => r.id.includes(`|${NOT_ESTIMABLE}|`) && r.state === "released");
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => Number.isInteger(r.c) && r.note === "agreement not estimable: fewer than ten gold passes"));
  });

  test("fixture-into-public-data: a synthetic store never writes under the repo's public-data/", () => {
    const pd = path.join(REPO, "public-data");
    const existed = fs.existsSync(pd);
    const { stdout } = cli(raw(), path.join(pd, "synthetic-test"));
    assert.match(stdout, /^EXPORT REFUSED: fixture-into-public-data /m);
    assert.equal(fs.existsSync(pd), existed);
    assert.equal(fs.existsSync(path.join(pd, "synthetic-test")), false);
  });

  test("the committed synthetic release equals a fresh export", async () => {
    const fresh = await exportRelease({ input: expandFixture(raw()), outDir: outDir(), ledger: [] });
    const committed = JSON.parse(fs.readFileSync(path.join(COMMITTED, "v1/manifest.json"), "utf8"));
    assert.equal(committed.kind, "fixture");
    assert.deepEqual(committed.files, fresh.manifest.files);
    assert.deepEqual(committed, fresh.manifest);
  });
});
