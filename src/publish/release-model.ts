// PUB-03: aggregate tables -> disclosure release model (tuples and rows), and
// the closed release -> display rows of release.json. The renderer never sees a
// true count for a suppressed tuple: it gets the closed release plus a display
// state (lt10 / suppressed) decided before closure.

import { wilson } from "../pipeline/validate/agreement.ts";
import {
  PARTITIONS,
  PUBLISHABLE,
  STATES,
  checkShares,
  inPartition,
  tupleId,
  type AggregateInput,
  type GateCheck,
  type Partition,
  type Share,
} from "./aggregate.ts";

export interface Tuple {
  id: string;
  n: number;
  c: number | null;
  suppression?: "primary" | "complementary";
}
export interface Term {
  id: string;
  coef: number;
}
export interface Constraint {
  terms: Term[];
  sense: "=" | "<=" | ">=";
  rhs: number;
  requires?: string[];
}
export interface Truth {
  tuples: { id: string; n: number; c: number }[];
  constraints: Constraint[];
}
export interface Release {
  tuples: Tuple[];
  constraints: Constraint[];
  previous: Constraint[][];
}

export type RowState = "released" | "lt10" | "suppressed" | "withheld" | "absent" | "not-estimable";
export interface Row {
  id: string;
  label: string;
  state: RowState;
  c?: number;
  n?: number;
  pct?: number;
  ci?: [number, number];
  reason?: string;
  note?: string;
}
export interface Figure {
  id: string;
  title: string;
  measure: string;
  rows: Row[];
}

export interface Tables {
  checkIds: string[];
  publishable: Set<string>;
  gate: Map<string, GateCheck>;
  partitions: Partition[]; // partitions with at least one included project
  absent: Partition[];
  shares: Share[]; // publishable checks only
}

// Fixed phrases: never the gate's free text, which can hold numbers.
export const WITHHELD_REASON: Record<string, string> = {
  missed: "agreement below the pre-registered threshold",
  withheld: "withheld under the pre-registered shortfall rule",
};
export const NOT_ESTIMABLE_NOTE = "agreement not estimable: fewer than ten gold passes";
const SUPPRESSED_REASON = "suppressed so that small counts cannot be worked out";
const ABSENT_REASON: Record<string, string> = {
  "src:github-only": "no GitHub-only launches met the inclusion criteria",
  "src:reddit": "no Reddit launches met the inclusion criteria",
  "src:show-hn": "no Show HN launches met the inclusion criteria",
};
const PARTITION_LABEL: Record<Partition, string> = {
  all: "all launches",
  q1: "quarter 1",
  q2: "quarter 2",
  q3: "quarter 3",
  q4: "quarter 4",
  "src:show-hn": "Show HN",
  "src:reddit": "Reddit",
  "src:github-only": "GitHub-only",
};
const FIGURES: Record<string, { title: string; measure: string }> = {
  pass: { title: "Checks evidenced with a confirmed pass", measure: "share of included launches with a confirmed pass" },
  claimed: { title: "Checks claimed without a linked artefact", measure: "share of included launches that claim the check" },
};

export function buildTables(input: AggregateInput): Tables {
  const gate = new Map(input.gate.checks.map((g) => [g.checkId, g]));
  const publishable = new Set(input.checkIds.filter((id) => (PUBLISHABLE as readonly string[]).includes(gate.get(id)!.status)));
  const partitions: Partition[] = [];
  const absent: Partition[] = [];
  const shares: Share[] = [];
  const ids = input.checkIds.filter((id) => publishable.has(id));
  for (const partition of PARTITIONS) {
    if (!input.projects.some((p) => p.tag === "sample" && inPartition(p, partition))) {
      absent.push(partition);
      continue;
    }
    partitions.push(partition);
    for (const state of STATES) shares.push(...checkShares(input, partition, state, ids));
  }
  return { checkIds: input.checkIds, publishable, gate, partitions, absent, shares };
}

/** Tuples with true counts plus the rows a reader can write down from the published tables. */
export function toTruth(tables: Tables): Truth {
  const tuples = tables.shares.map((s) => ({ id: tupleId(s.checkId, s.state, s.partition), n: s.n, c: s.c }));
  const nOf = new Map(tables.shares.map((s) => [s.partition, s.n]));
  const has = (p: Partition) => tables.partitions.includes(p);
  const constraints: Constraint[] = [];
  const quarters = (["q1", "q2", "q3", "q4"] as Partition[]).filter(has);
  const sources = (["src:show-hn", "src:reddit", "src:github-only"] as Partition[]).filter(has);
  for (const checkId of tables.checkIds.filter((id) => tables.publishable.has(id))) {
    for (const state of STATES) {
      for (const group of [quarters, sources]) {
        constraints.push({
          terms: [...group.map((p) => ({ id: tupleId(checkId, state, p), coef: 1 })), { id: tupleId(checkId, state, "all"), coef: -1 }],
          sense: "=",
          rhs: 0,
        });
      }
    }
    for (const p of tables.partitions) {
      constraints.push({ terms: STATES.map((s) => ({ id: tupleId(checkId, s, p), coef: 1 })), sense: "<=", rhs: nOf.get(p)! });
    }
  }
  return { tuples, constraints };
}

const pct = (x: number) => Math.round(100 * x);

/** Closed release + display states -> figures of release.json. */
export function renderFigures(
  release: Release,
  display: Map<string, "lt10" | "suppressed">,
  tables: Tables,
  labels: Record<string, string>,
): Record<string, Figure> {
  const byId = new Map(release.tuples.map((t) => [t.id, t]));
  const figures: Record<string, Figure> = {};
  for (const state of STATES) {
    const rows: Row[] = [];
    for (const checkId of tables.checkIds) {
      const g = tables.gate.get(checkId)!;
      for (const partition of PARTITIONS) {
        const id = tupleId(checkId, state, partition);
        const label = partition === "all" ? labels[checkId] : `${labels[checkId]} (${PARTITION_LABEL[partition]})`;
        if (!tables.publishable.has(checkId)) {
          rows.push({ id, label, state: "withheld", reason: WITHHELD_REASON[g.status] ?? WITHHELD_REASON.withheld });
          continue;
        }
        if (tables.absent.includes(partition)) {
          rows.push({ id, label, state: "absent", reason: ABSENT_REASON[partition] ?? "no launches in this group met the inclusion criteria" });
          continue;
        }
        const t = byId.get(id)!;
        if (t.c === null) {
          const shown = display.get(id) ?? "suppressed";
          rows.push(shown === "lt10" ? { id, label, state: "lt10" } : { id, label, state: "suppressed", reason: SUPPRESSED_REASON });
          continue;
        }
        const [lo, hi] = wilson(t.c, t.n);
        const row: Row = { id, label, state: "released", c: t.c, n: t.n, pct: pct(t.c / t.n), ci: [pct(lo), pct(hi)] };
        if (g.status === "released-not-estimable") row.note = NOT_ESTIMABLE_NOTE;
        rows.push(row);
      }
    }
    figures[`checks-${state}`] = { id: `checks-${state}`, ...FIGURES[state], rows };
  }
  return figures;
}
