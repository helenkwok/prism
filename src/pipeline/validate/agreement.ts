// VAL-03 / D-54: agreement statistics the VAL-07 gate decides on.
// Formulas from protocol section 4; register rows R06 (AC1), R07 (Wilson +
// percentile bootstrap), R10 (not estimable under ~10 gold passes).
//
// AC1 = (pa - pe) / (1 - pe)
// binary pe = 2 pi (1 - pi), pi = mean of the two raters' pass proportions
// k-category pe = [1/(k-1)] sum_j pi_j (1 - pi_j)
// kappa pe = pA pB + (1-pA)(1-pB)
// pass precision = coder passes that gold also marks pass / coder passes
// pass recall = same / gold passes
// uniform i = parseInt(sha256(`${seed}:bootstrap:${i}`).slice(0,13), 16) / 2^52
//   with one running counter across all resamples (A7.9); percentile at 2.5%/97.5%
//
// Caller decides which rater is A (primary coder's filtered state, or published
// state for the secondary figure) and which is B (gold). Pure: no I/O.

import { createHash } from "node:crypto";

export const ESTIMABLE_MIN_GOLD_PASSES = 10;

export function estimable(goldPasses: number): boolean {
  return goldPasses >= ESTIMABLE_MIN_GOLD_PASSES;
}

function meanBool(xs: boolean[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) if (x) s++;
  return s / xs.length;
}

/** Binary pass vs not-pass agreement (R06 primary). */
export function binary(a: boolean[], b: boolean[]) {
  const n = a.length;
  if (n === 0 || b.length !== n) {
    return { n: 0, pa: 0, ac1: 0, kappa: null as number | null, precision: null as number | null, recall: null as number | null, goldPasses: 0, coderPasses: 0 };
  }
  let agree = 0;
  let tp = 0;
  let coderPasses = 0;
  let goldPasses = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree++;
    if (a[i]) coderPasses++;
    if (b[i]) goldPasses++;
    if (a[i] && b[i]) tp++;
  }
  const pa = agree / n;
  const pA = meanBool(a);
  const pB = meanBool(b);
  const pi = (pA + pB) / 2;
  const peG = 2 * pi * (1 - pi);
  const peK = pA * pB + (1 - pA) * (1 - pB);
  const ac1 = peG === 1 ? 0 : (pa - peG) / (1 - peG);
  const kappa = peK === 1 ? null : (pa - peK) / (1 - peK);
  const precision = coderPasses === 0 ? null : tp / coderPasses;
  const recall = goldPasses === 0 ? null : tp / goldPasses;
  return { n, pa, ac1, kappa, precision, recall, goldPasses, coderPasses };
}

export function uniform(seed: string, i: number): number {
  const hex = createHash("sha256").update(`${seed}:bootstrap:${i}`).digest("hex");
  return parseInt(hex.slice(0, 13), 16) / 2 ** 52;
}

/** Percentile bootstrap CI over projects; one running counter i (R07, A7.9). */
export function bootstrapCI(
  projects: string[],
  stat: (sample: string[]) => number | null,
  seed: string,
  B = 2000,
): [number, number] | null {
  const n = projects.length;
  if (n === 0) return null;
  const vals: number[] = [];
  let i = 0;
  for (let r = 0; r < B; r++) {
    const sample = Array.from({ length: n }, () => projects[Math.floor(uniform(seed, i++) * n)]!);
    const v = stat(sample);
    if (v !== null && Number.isFinite(v)) vals.push(v);
  }
  if (vals.length === 0) return null;
  vals.sort((x, y) => x - y);
  const lo = vals[Math.floor(0.025 * (vals.length - 1))]!;
  const hi = vals[Math.ceil(0.975 * (vals.length - 1))]!;
  return [lo, hi];
}

/** Wilson score interval for a proportion (R07). */
export function wilson(x: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 0];
  const p = x / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}

export type CheckState = "pass" | "fail" | "unknown" | "claimed";

const FOUR_STATES: CheckState[] = ["pass", "fail", "unknown", "claimed"];

function isPass(s: string): boolean {
  return s === "pass";
}

/** Four-state AC1 (R06 secondary). pe = [1/(k-1)] sum pi_j (1 - pi_j), k=4. */
export function fourState(a: string[], b: string[]) {
  const n = a.length;
  if (n === 0 || b.length !== n) return { n: 0, pa: 0, ac1: 0 };
  let agree = 0;
  const countA: Record<string, number> = Object.fromEntries(FOUR_STATES.map((s) => [s, 0]));
  const countB: Record<string, number> = Object.fromEntries(FOUR_STATES.map((s) => [s, 0]));
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree++;
    if (a[i]! in countA) countA[a[i]!]!++;
    if (b[i]! in countB) countB[b[i]!]!++;
  }
  const pa = agree / n;
  let sum = 0;
  for (const s of FOUR_STATES) {
    const pi = (countA[s]! / n + countB[s]! / n) / 2;
    sum += pi * (1 - pi);
  }
  const pe = sum / (FOUR_STATES.length - 1);
  const ac1 = pe === 1 ? 0 : (pa - pe) / (1 - pe);
  return { n, pa, ac1 };
}

export type AgreementRow = { projectN: number; checkId: string; a: string; b: string };

type Ci = [number, number] | null;

function emptyCheckEntry(checkId: string) {
  return {
    checkId,
    n: 0,
    pa: 0,
    ac1: 0,
    kappa: null as number | null,
    precision: null as number | null,
    recall: null as number | null,
    goldPasses: 0,
    coderPasses: 0,
    fourStateAc1: 0,
    estimable: false,
    ac1CI: null as Ci,
    precisionCI: null as Ci,
    recallCI: null as Ci,
    kappaCI: null as Ci,
    paCI: null as Ci,
  };
}

function statsForRows(rows: AgreementRow[]) {
  if (rows.length === 0) {
    return {
      ...emptyCheckEntry(""),
      fourStateAc1: 0,
    };
  }
  const bin = binary(
    rows.map((r) => isPass(r.a)),
    rows.map((r) => isPass(r.b)),
  );
  const fs = fourState(
    rows.map((r) => r.a),
    rows.map((r) => r.b),
  );
  return {
    ...bin,
    fourStateAc1: fs.ac1,
    estimable: estimable(bin.goldPasses),
  };
}

/**
 * Per-check and pooled agreement. Bootstrap resamples projects (draws project
 * numbers and takes all their rows). Pure: no database, no file access.
 */
export function agreementByCheck(rows: AgreementRow[], checkIds: string[], seed: string, B = 2000) {
  const byCheck = new Map<string, AgreementRow[]>();
  for (const id of checkIds) byCheck.set(id, []);
  for (const row of rows) {
    const list = byCheck.get(row.checkId);
    if (list) list.push(row);
  }

  const projectSet = new Set<number>();
  for (const row of rows) projectSet.add(row.projectN);
  const projectIds = [...projectSet].map(String);

  function withCIs(checkId: string, checkRows: AgreementRow[]) {
    const base = statsForRows(checkRows);
    const entry = { ...emptyCheckEntry(checkId), ...base, checkId };
    if (checkRows.length === 0 || projectIds.length === 0) return entry;

    const rowsOf = (projSample: string[]) => {
      const want = new Set(projSample.map(Number));
      return checkRows.filter((r) => want.has(r.projectN));
    };

    entry.ac1CI = bootstrapCI(projectIds, (s) => statsForRows(rowsOf(s)).ac1, seed, B);
    entry.paCI = bootstrapCI(projectIds, (s) => statsForRows(rowsOf(s)).pa, seed, B);
    entry.precisionCI = bootstrapCI(projectIds, (s) => statsForRows(rowsOf(s)).precision, seed, B);
    entry.recallCI = bootstrapCI(projectIds, (s) => statsForRows(rowsOf(s)).recall, seed, B);
    entry.kappaCI = bootstrapCI(projectIds, (s) => statsForRows(rowsOf(s)).kappa, seed, B);
    return entry;
  }

  const checks = checkIds.map((id) => withCIs(id, byCheck.get(id) ?? []));

  // Pooled: all rows; bootstrap still over projects. Never mutates checks.
  const pooledBase = statsForRows(rows);
  const pooled = {
    ...emptyCheckEntry("pooled"),
    ...pooledBase,
    checkId: "pooled",
  };
  if (rows.length > 0 && projectIds.length > 0) {
    const rowsOf = (projSample: string[]) => {
      const want = new Set(projSample.map(Number));
      return rows.filter((r) => want.has(r.projectN));
    };
    pooled.ac1CI = bootstrapCI(projectIds, (s) => statsForRows(rowsOf(s)).ac1, seed, B);
    pooled.paCI = bootstrapCI(projectIds, (s) => statsForRows(rowsOf(s)).pa, seed, B);
    pooled.precisionCI = bootstrapCI(projectIds, (s) => statsForRows(rowsOf(s)).precision, seed, B);
    pooled.recallCI = bootstrapCI(projectIds, (s) => statsForRows(rowsOf(s)).recall, seed, B);
    pooled.kappaCI = bootstrapCI(projectIds, (s) => statsForRows(rowsOf(s)).kappa, seed, B);
  }

  return { checks, pooled };
}
