// Closure helper for the export (protocol 6.5). The per-cell test is the one in
// protocol/disclosure/audit.mjs (its prepare and buildLp, copied here because the reference
// does not export them), with two changes that cannot alter a cell's pass or fail:
//   - it stops counting a cell's feasible values once it has the required number;
//   - it can test a subset of cells.
// Suppressing one more published tuple only widens what the reader can complete, so a cell
// that passed keeps passing; closure therefore re-tests only the failing cells and the new one.
// This module only chooses closure steps. Every part's final pass, under both priors, is decided
// by the reference auditRelease.

import highsLoader from "highs";

import { FLOOR, MIN_VALUES } from "../../protocol/disclosure/audit.mjs";
import type { Release } from "./release-model.ts";

interface Cell {
  id: string;
  n: number;
  kind: "primary" | "complementary";
  prior: number[];
}
interface Model {
  cells: Cell[];
  rows: { coef: [number, number][]; sense: string; rhs: number }[];
}

let highsPromise: Promise<any> | undefined;
const solver = () => (highsPromise ??= (highsLoader as unknown as () => Promise<any>)());

function prepare(release: Release, complementaryPrior: "all" | "interior"): Model {
  const byId = new Map(release.tuples.map((t) => [t.id, t]));
  const unknowns = release.tuples.filter((t) => t.c === null);
  const index = new Map(unknowns.map((t, i) => [t.id, i]));
  const rows: Model["rows"] = [];
  for (const row of [...(release.constraints ?? []), ...(release.previous ?? []).flat()]) {
    if ((row.requires ?? []).some((id) => byId.get(id)?.c === null)) continue;
    const coef = new Map<number, number>();
    let rhs = row.rhs;
    for (const { id, coef: k } of row.terms) {
      const t = byId.get(id);
      if (!t) throw new Error(`constraint names unknown tuple ${id}`);
      if (t.c === null) coef.set(index.get(id)!, (coef.get(index.get(id)!) ?? 0) + k);
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
    let prior: number[];
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

function linear(terms: [number, number][]): string {
  let s = "";
  for (const [i, coef] of terms) {
    const sign = coef < 0 ? "-" : "+";
    s += `${s === "" ? (coef < 0 ? "- " : "") : ` ${sign} `}${Math.abs(coef)} v${i}`;
  }
  return s;
}

function buildLp({ cells, rows }: Model, objective: { cell: number; sense: "min" | "max" } | null, fixed: { cell: number; value: number } | null) {
  const lines = ["Minimize"];
  if (objective) lines.push(` obj: ${objective.sense === "max" ? "- " : ""}v${objective.cell}`);
  else lines.push(" obj: 0 v0");
  lines.push("Subject To");
  let r = 0;
  for (const row of rows) lines.push(` r${r++}: ${linear(row.coef)} ${row.sense} ${row.rhs}`);
  const binaries: string[] = [];
  cells.forEach((cell, i) => {
    if (cell.kind === "primary" && cell.n >= FLOOR) {
      lines.push(` p${i}a: v${i} - ${cell.n - (FLOOR - 1)} z${i} <= ${FLOOR - 1}`);
      lines.push(` p${i}b: v${i} - ${cell.n - (FLOOR - 1)} z${i} >= 0`);
      binaries.push(`z${i}`);
    }
  });
  lines.push("Bounds");
  cells.forEach((cell, i) => {
    if (fixed && fixed.cell === i) lines.push(` v${i} = ${fixed.value}`);
    else if (cell.kind === "complementary" && cell.prior.length && cell.prior.length !== cell.n + 1) {
      lines.push(` ${cell.prior[0]} <= v${i} <= ${cell.prior[cell.prior.length - 1]}`);
    } else lines.push(` 0 <= v${i} <= ${cell.n}`);
  });
  lines.push("General", ` ${cells.map((_, i) => `v${i}`).join(" ")}`);
  if (binaries.length) lines.push("Binary", ` ${binaries.join(" ")}`);
  lines.push("End");
  return lines.join("\n");
}

async function feasible(model: Model, fixed: { cell: number; value: number } | null): Promise<boolean> {
  const res = (await solver()).solve(buildLp(model, null, fixed));
  if (res.Status === "Optimal") return true;
  if (res.Status === "Infeasible") return false;
  throw new Error(`unexpected solver status ${res.Status}`);
}

async function extreme(model: Model, cell: number, sense: "min" | "max"): Promise<number | null> {
  const res = (await solver()).solve(buildLp(model, { cell, sense }, null));
  if (res.Status === "Infeasible") return null;
  if (res.Status !== "Optimal") throw new Error(`unexpected solver status ${res.Status}`);
  return Math.round(res.Columns[`v${cell}`].Primal);
}

/** Suppressed cells (or the named subset) with fewer than min(MIN_VALUES, prior size) feasible values. */
export async function failingCells(release: Release, { complementaryPrior = "all" as "all" | "interior", ids }: { complementaryPrior?: "all" | "interior"; ids?: string[] } = {}) {
  const model = prepare(release, complementaryPrior);
  if (model.cells.length > 0 && !(await feasible(model, null))) {
    throw new Error("release is infeasible: the published values and rows contradict the suppression priors");
  }
  const want = ids ? new Set(ids) : null;
  const failing: string[] = [];
  for (let i = 0; i < model.cells.length; i++) {
    const cell = model.cells[i]!;
    if (want && !want.has(cell.id)) continue;
    const required = Math.min(MIN_VALUES, cell.prior.length);
    const lo = await extreme(model, i, "min");
    const hi = lo === null ? null : await extreme(model, i, "max");
    let count = 0;
    for (const v of cell.prior) {
      if (count >= required) break;
      if (lo === null || v < lo || v > hi!) continue;
      if (await feasible(model, { cell: i, value: v })) count++;
    }
    if (count < required) failing.push(cell.id);
  }
  return failing;
}
