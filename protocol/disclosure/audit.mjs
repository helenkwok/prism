// Reference disclosure-control audit (decision D-14, requirement PUB-03 groundwork).
//
// This is the rule the protocol commits to, written as running code so the rule
// has been seen to work before it is signed off. Phase 6's export boundary
// imports it.
//
//   node protocol/disclosure/audit.mjs --generate-expected   rewrite the expected sections from the solver
//   node protocol/disclosure/audit.mjs --check-expected      re-run the solver, exit 1 on any difference
//
// RELEASE MODEL (JSON)
//   tuples       [{ id, n, c, suppression? }]  n is always public (cohort sizes are counts in the
//                review's flow figures). c is a number when the tuple is published and null when it
//                is suppressed. A tuple is published in full or not at all: every figure derived
//                from it (share, interval, chart bar, tooltip) goes with it.
//                suppression is "primary" (the default for a null c) or "complementary".
//   constraints  [{ terms: [{ id, coef }], sense: "=" | "<=" | ">=", rhs, requires?: [id] }]
//                linear rows the reader can write down from what is published: published totals,
//                sums across overlapping tables, a rounded pooled percentage as two inequalities,
//                decision-level inequalities. requires lists tuples whose published value the row is
//                derived from; when one of them is suppressed the row is not available to the reader.
//   previous     [ constraints[] ] constraint sets of earlier released versions, unioned in.
//
// WHAT THE AUDIT COUNTS
//   For every suppressed tuple the audit counts the FEASIBLE VALUES, exactly, one candidate value at
//   a time through the HiGHS solver, not the width between a minimum and a maximum. The reader's prior
//   for a primary-suppressed cell is not an interval: the reader knows the cell was suppressed because
//   its count is under FLOOR or its complement is, so it lies in {0..9} or {n-9..n}. Width would
//   overstate the protection.
//
//   Refinements against the research note, deliberate and conservative (each gives the reader more
//   knowledge, so the audit can only get stricter):
//     - the non-convex prior of EVERY suppressed primary cell is applied inside every solve (with a
//       binary switch), not only for the cell being tested;
//     - a cell needs min(minValues, size of its own prior) feasible values, so a cohort with n < 4
//       (a prior of fewer than 5 values) cannot make the audit unsatisfiable;
//     - options.complementaryPrior = "interior" additionally gives the reader the knowledge that a
//       complementary cell was NOT primary (FLOOR <= c <= n - FLOOR). The default, "all", assumes the
//       published table does not reveal which suppressed cells are complementary. Whether the table
//       can hide that distinction is protocol register row R02.
//
// Statistical disclosure control here means: nothing recoverable, judged by an exact audit. It does
// not claim to model an attacker with external knowledge of the counts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import highsLoader from "highs";

export const FLOOR = 10;
export const MIN_VALUES = 5;

/** Primary suppression: the count, its complement, or the cohort size is under the floor. */
export function primarySuppressed({ c, n }, floor = FLOOR) {
  return n < floor || c < floor || n - c < floor;
}

let highsPromise;
function solver() {
  highsPromise ??= highsLoader();
  return highsPromise;
}

function fmt(x) {
  return String(x);
}

function linear(terms) {
  // terms: [{ name, coef }] with coef a non-zero number; LP text with explicit signs
  let s = "";
  for (const { name, coef } of terms) {
    const sign = coef < 0 ? "-" : "+";
    s += `${s === "" ? (coef < 0 ? "- " : "") : ` ${sign} `}${fmt(Math.abs(coef))} ${name}`;
  }
  return s;
}

/** Validate a release and reduce it to the unknown vector and folded rows. */
function prepare(release, options = {}) {
  const complementaryPrior = options.complementaryPrior ?? "all";
  if (complementaryPrior !== "all" && complementaryPrior !== "interior") {
    throw new Error(`complementaryPrior must be "all" or "interior", got ${complementaryPrior}`);
  }
  const byId = new Map();
  for (const t of release.tuples) {
    if (byId.has(t.id)) throw new Error(`duplicate tuple id ${t.id}`);
    if (!Number.isInteger(t.n) || t.n < 0) throw new Error(`tuple ${t.id}: n must be a non-negative integer`);
    if (t.c !== null && (!Number.isInteger(t.c) || t.c < 0 || t.c > t.n)) {
      throw new Error(`tuple ${t.id}: c must be null or an integer in 0..n`);
    }
    byId.set(t.id, t);
  }
  const unknowns = release.tuples.filter((t) => t.c === null);
  const index = new Map(unknowns.map((t, i) => [t.id, i]));

  const rows = [];
  const all = [...(release.constraints ?? []), ...(release.previous ?? []).flat()];
  for (const row of all) {
    if (!["=", "<=", ">="].includes(row.sense)) throw new Error(`bad constraint sense ${row.sense}`);
    if ((row.requires ?? []).some((id) => byId.get(id)?.c === null)) continue; // derived from a suppressed tuple
    const coef = new Map();
    let rhs = row.rhs;
    for (const { id, coef: k } of row.terms) {
      const t = byId.get(id);
      if (!t) throw new Error(`constraint names unknown tuple ${id}`);
      if (t.c === null) coef.set(index.get(id), (coef.get(index.get(id)) ?? 0) + k);
      else rhs -= k * t.c;
    }
    const live = [...coef].filter(([, k]) => k !== 0);
    if (live.length === 0) {
      const ok = row.sense === "=" ? rhs === 0 : row.sense === "<=" ? 0 <= rhs : 0 >= rhs;
      if (!ok) throw new Error(`published values contradict a constraint (${JSON.stringify(row)})`);
      continue;
    }
    rows.push({ coef: live, sense: row.sense, rhs });
  }

  const cells = unknowns.map((t) => {
    const kind = t.suppression ?? "primary";
    if (kind !== "primary" && kind !== "complementary") throw new Error(`tuple ${t.id}: bad suppression ${kind}`);
    let prior; // candidate values the reader considers before looking at any published figure
    if (kind === "primary") {
      prior = [];
      for (let v = 0; v <= t.n; v++) if (v < FLOOR || t.n - v < FLOOR) prior.push(v);
    } else if (complementaryPrior === "interior") {
      prior = [];
      for (let v = FLOOR; v <= t.n - FLOOR; v++) prior.push(v);
    } else {
      prior = Array.from({ length: t.n + 1 }, (_, v) => v);
    }
    return { id: t.id, n: t.n, kind, prior };
  });
  return { cells, rows };
}

function buildLp({ cells, rows }, objective, fixed) {
  const lines = ["Minimize"];
  if (objective) lines.push(` obj: ${objective.sense === "max" ? "- " : ""}v${objective.cell}`);
  else lines.push(" obj: 0 v0");
  lines.push("Subject To");
  let r = 0;
  for (const row of rows) {
    lines.push(` r${r++}: ${linear(row.coef.map(([i, k]) => ({ name: `v${i}`, coef: k })))} ${row.sense === "=" ? "=" : row.sense} ${fmt(row.rhs)}`);
  }
  const binaries = [];
  cells.forEach((cell, i) => {
    const nonConvex = cell.kind === "primary" && cell.n >= FLOOR;
    if (nonConvex) {
      // z = 0: c in 0..9 ; z = 1: c in n-9..n
      lines.push(` p${i}a: v${i} - ${cell.n - (FLOOR - 1)} z${i} <= ${FLOOR - 1}`);
      lines.push(` p${i}b: v${i} - ${cell.n - (FLOOR - 1)} z${i} >= 0`);
      binaries.push(`z${i}`);
    }
  });
  lines.push("Bounds");
  cells.forEach((cell, i) => {
    if (fixed && fixed.cell === i) {
      lines.push(` v${i} = ${fixed.value}`);
    } else if (cell.kind === "complementary" && cell.prior.length && cell.prior.length !== cell.n + 1) {
      lines.push(` ${cell.prior[0]} <= v${i} <= ${cell.prior[cell.prior.length - 1]}`);
    } else {
      lines.push(` 0 <= v${i} <= ${cell.n}`);
    }
  });
  lines.push("General", ` ${cells.map((_, i) => `v${i}`).join(" ")}`);
  if (binaries.length) lines.push("Binary", ` ${binaries.join(" ")}`);
  lines.push("End");
  return lines.join("\n");
}

async function feasible(model, fixed) {
  const highs = await solver();
  const res = highs.solve(buildLp(model, null, fixed));
  if (res.Status === "Optimal") return true;
  if (res.Status === "Infeasible") return false;
  throw new Error(`unexpected solver status ${res.Status}`);
}

async function extreme(model, cell, sense) {
  const highs = await solver();
  const res = highs.solve(buildLp(model, { cell, sense }, null));
  if (res.Status === "Infeasible") return null;
  if (res.Status !== "Optimal") throw new Error(`unexpected solver status ${res.Status}`);
  return Math.round(res.Columns[`v${cell}`].Primal);
}

/**
 * The differencing test. Returns { pass, minValues, cells: { id: { kind, prior, feasible, required, ok } }, failing }.
 * `feasible` is the list of values of the cell that some completion of the release allows.
 */
export async function auditRelease(release, { minValues = MIN_VALUES, complementaryPrior } = {}) {
  const model = prepare(release, { complementaryPrior });
  const out = {};
  const failing = [];
  // An empty unknown set (nothing suppressed) passes trivially. A release that is infeasible for the
  // reader (no completion at all) is an inconsistent release, not a safe one.
  if (model.cells.length > 0 && !(await feasible(model, null))) {
    throw new Error("release is infeasible: the published values and rows contradict the suppression priors");
  }
  for (let i = 0; i < model.cells.length; i++) {
    const cell = model.cells[i];
    // The min and max solves are a fast prefilter only: they bound the values to test.
    const lo = await extreme(model, i, "min");
    const hi = await extreme(model, i, "max");
    const values = [];
    for (const v of cell.prior) {
      if (lo === null || v < lo || v > hi) continue;
      if (await feasible(model, { cell: i, value: v })) values.push(v);
    }
    const required = Math.min(minValues, cell.prior.length);
    const ok = values.length >= required;
    out[cell.id] = { kind: cell.kind, prior: cell.prior.length, feasible: values, required, ok };
    if (!ok) failing.push(cell.id);
  }
  return { pass: failing.length === 0, minValues, cells: out, failing };
}

/**
 * The closure loop. While the audit fails, secondary-suppress the published tuple with the smallest
 * count among those in a row that involves a failing cell (ties by id order) and re-audit. Returns
 * { release, added, audit }. Terminates because every step suppresses one more tuple and suppressing
 * everything leaves no row to difference against.
 */
export async function closeRelease(release, options = {}) {
  let current = structuredClone(release);
  const added = [];
  for (;;) {
    const audit = await auditRelease(current, options);
    if (audit.pass) return { release: current, added, audit };
    const failing = new Set(audit.failing);
    const byId = new Map(current.tuples.map((t) => [t.id, t]));
    const rowsAll = [...(current.constraints ?? []), ...(current.previous ?? []).flat()];
    const candidates = new Set();
    for (const row of rowsAll) {
      if ((row.requires ?? []).some((id) => byId.get(id)?.c === null)) continue;
      if (!row.terms.some(({ id }) => failing.has(id))) continue;
      for (const { id } of row.terms) if (byId.get(id).c !== null) candidates.add(id);
    }
    if (candidates.size === 0) {
      throw new Error(`cannot close release: ${[...failing].join(", ")} fail with no published tuple to suppress`);
    }
    const pick = [...candidates].sort((a, b) => byId.get(a).c - byId.get(b).c || (a < b ? -1 : a > b ? 1 : 0))[0];
    const t = byId.get(pick);
    t.c = null;
    t.suppression = "complementary";
    added.push(pick);
  }
}

/** Apply the primary rule to true counts and return a release model ready for auditing. */
export function buildRelease(data, { floor = FLOOR, countOnly = false } = {}) {
  const truth = new Map(data.tuples.map((t) => [t.id, t.c]));
  for (const row of data.constraints ?? []) {
    const lhs = row.terms.reduce((s, { id, coef }) => s + coef * truth.get(id), 0);
    const ok = row.sense === "=" ? lhs === row.rhs : row.sense === "<=" ? lhs <= row.rhs : lhs >= row.rhs;
    if (!ok) throw new Error(`fixture data violates its own constraint ${JSON.stringify(row)}`);
  }
  const tuples = data.tuples.map((t) => {
    const suppress = countOnly ? t.c < floor : primarySuppressed(t, floor);
    return suppress ? { id: t.id, n: t.n, c: null, suppression: "primary" } : { id: t.id, n: t.n, c: t.c };
  });
  return { tuples, constraints: data.constraints ?? [], previous: data.previous ?? [] };
}

/** Compact run-length text for a sorted list of integers: "0-3,66-75". */
export function ranges(values) {
  const parts = [];
  let i = 0;
  while (i < values.length) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j] + 1) j++;
    parts.push(j === i ? String(values[i]) : `${values[i]}-${values[j]}`);
    i = j + 1;
  }
  return parts.join(",");
}

function summarise(audit) {
  const cells = {};
  for (const [id, c] of Object.entries(audit.cells)) {
    cells[id] = { kind: c.kind, prior: c.prior, feasible: ranges(c.feasible), count: c.feasible.length, ok: c.ok };
  }
  return { verdict: audit.pass ? "PASS" : "FAIL", failing: audit.failing, cells };
}

/** Compute the expected section of one fixture with the solver. */
export async function evaluateFixture(name, fixtures) {
  const fx = fixtures.fixtures[name];
  if (fx.from) {
    const base = buildRelease(fixtures.fixtures[fx.from].data);
    const closed = await closeRelease(base);
    return {
      added: closed.added,
      suppression: Object.fromEntries(closed.release.tuples.filter((t) => t.c === null).map((t) => [t.id, t.suppression])),
      ...summarise(closed.audit),
    };
  }
  const release = buildRelease(fx.data);
  const countOnly = buildRelease(fx.data, { countOnly: true });
  const audit = await auditRelease(release);
  return {
    primarySuppressed: release.tuples.filter((t) => t.c === null).map((t) => t.id),
    countOnlySuppressed: countOnly.tuples.filter((t) => t.c === null).map((t) => t.id),
    ...summarise(audit),
  };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_PATH = path.join(HERE, "fixtures.json");

export function loadFixtures(file = FIXTURES_PATH) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function solverVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "../../node_modules/highs/package.json"), "utf8"));
  return { package: "highs", version: pkg.version };
}

async function main(argv) {
  const mode = argv[0];
  if (mode !== "--generate-expected" && mode !== "--check-expected") {
    console.error("usage: audit.mjs --generate-expected | --check-expected");
    return 2;
  }
  const fixtures = loadFixtures();
  const names = Object.keys(fixtures.fixtures);
  // fixtures that derive from another are evaluated after their base; order in the file already does this
  const fresh = {};
  for (const name of names) fresh[name] = await evaluateFixture(name, fixtures);
  if (mode === "--generate-expected") {
    fixtures.solver = solverVersion();
    for (const name of names) fixtures.fixtures[name].expected = fresh[name];
    fs.writeFileSync(FIXTURES_PATH, `${JSON.stringify(fixtures, null, 2)}\n`);
    console.log(`expected sections regenerated for ${names.length} fixtures with highs ${fixtures.solver.version}`);
    return 0;
  }
  let bad = 0;
  for (const name of names) {
    const same = JSON.stringify(fresh[name]) === JSON.stringify(fixtures.fixtures[name].expected);
    if (!same) {
      bad++;
      console.error(`fixture ${name}: stored expected values differ from a fresh solver run`);
      console.error(`  stored: ${JSON.stringify(fixtures.fixtures[name].expected)}`);
      console.error(`  fresh:  ${JSON.stringify(fresh[name])}`);
    }
  }
  const v = solverVersion();
  if (JSON.stringify(v) !== JSON.stringify(fixtures.solver)) {
    console.error(`note: fixtures were generated with ${JSON.stringify(fixtures.solver)}, installed is ${JSON.stringify(v)}`);
  }
  if (bad) return 1;
  console.log(`expected values match a fresh solver run for ${names.length} fixtures`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));

if (invokedDirectly) main(process.argv.slice(2)).then((code) => process.exit(code));
