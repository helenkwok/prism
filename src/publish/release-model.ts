// PUB-03: aggregate tables -> one disclosure release model (tuples and rows), and
// the closed release -> the display rows of release.json. The renderer never sees a
// true count for a suppressed tuple: it gets the closed release plus a display
// state (lt10 / suppressed) decided before closure.
//
// Tuple families (all audited together, T-06-11):
//   chk|<check>|<pass|claimed>|<partition>   check shares
//   dec|<decision>|PASS|<partition>          decision shares (the deterministic gate's PASS)
//   h1|all, h3|all                           hypothesis counts; <id>|sens excludes collection failures
//   st|<type>|all                            launches with a confirmed positive from a source type
//   prisma|<key>                             PRISMA boxes and merged exclusion reasons (n = screened)
//   prec|<check>                             pass precision against the independent labeller
//   conf|rejected, conf|downgraded, conf|chk|<check>   changes at confirmation (total is a D-83 process figure)
//   vis|provider-only                        launches whose evidence came only from provider-extracted text
//   comm|<key>|all                           A4 community layer (exploratory)

import { wilson } from "../pipeline/validate/agreement.ts";
import {
  GATE_OVERRIDES,
  PARTITIONS,
  PUBLISHABLE,
  STATES,
  anyState,
  checkShares,
  decisionShares,
  inPartition,
  includedProjects,
  notFailed,
  tupleId,
  type AggregateInput,
  type GateCheck,
  type Partition,
  type Share,
} from "./aggregate.ts";
import { mergeSmallReasons } from "./prisma.ts";
import { FLOOR, MIN_VALUES } from "../../protocol/disclosure/audit.mjs";

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

/**
 * Minimum included launches per source before the source partition is published at all.
 * 10 (Helen's decision B, 2026-10-24): the source split is published only when every non-empty source
 * has at least 10 launches.
 */
export const SOURCE_SPLIT_MIN_GROUP = 10;

export interface Tables {
  checkIds: string[];
  publishable: Set<string>;
  gate: Map<string, GateCheck>;
  partitions: Partition[]; // partitions published (at least one included project)
  absent: Map<Partition, string>; // partition -> fixed reason
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
const SOURCE_SPLIT_REASON = "the source split is published only when every source has at least ten included launches";
export const PARTITION_LABEL: Record<Partition, string> = {
  all: "all launches",
  q1: "quarter 1",
  q2: "quarter 2",
  q3: "quarter 3",
  q4: "quarter 4",
  "src:show-hn": "Show HN",
  "src:reddit": "Reddit",
  "src:github-only": "GitHub-only",
};
export const QUARTERS: Partition[] = ["q1", "q2", "q3", "q4"];
export const SOURCES: Partition[] = ["src:show-hn", "src:reddit", "src:github-only"];

export function buildTables(input: AggregateInput, { sourceMinGroup = SOURCE_SPLIT_MIN_GROUP } = {}): Tables {
  const gate = new Map(input.gate.checks.map((g) => [g.checkId, g]));
  const publishable = new Set(input.checkIds.filter((id) => (PUBLISHABLE as readonly string[]).includes(gate.get(id)!.status)));
  const size = (p: Partition) => input.projects.filter((x) => x.tag === "sample" && inPartition(x, p)).length;
  const sourceSplit = SOURCES.every((p) => size(p) === 0 || size(p) >= sourceMinGroup);
  const partitions: Partition[] = [];
  const absent = new Map<Partition, string>();
  const shares: Share[] = [];
  const ids = input.checkIds.filter((id) => publishable.has(id));
  for (const partition of PARTITIONS) {
    if (size(partition) === 0) {
      absent.set(partition, ABSENT_REASON[partition] ?? "no launches in this group met the inclusion criteria");
      continue;
    }
    if (partition.startsWith("src:") && !sourceSplit) {
      absent.set(partition, SOURCE_SPLIT_REASON);
      continue;
    }
    partitions.push(partition);
    for (const state of STATES) shares.push(...checkShares(input, partition, state, ids));
  }
  return { checkIds: input.checkIds, publishable, gate, partitions, absent, shares };
}

/** Check tuples with true counts plus the rows a reader can write down from the published tables. */
export function toTruth(tables: Tables): Truth {
  const tuples = tables.shares.map((s) => ({ id: tupleId(s.checkId, s.state, s.partition), n: s.n, c: s.c }));
  const nOf = new Map(tables.shares.map((s) => [s.partition, s.n]));
  const constraints: Constraint[] = [];
  for (const checkId of tables.checkIds.filter((id) => tables.publishable.has(id))) {
    for (const state of STATES) constraints.push(...partitionSums(tables, (p) => tupleId(checkId, state, p)));
    for (const p of tables.partitions) {
      constraints.push({ terms: STATES.map((s) => ({ id: tupleId(checkId, s, p), coef: 1 })), sense: "<=", rhs: nOf.get(p)! });
    }
  }
  return { tuples, constraints };
}

/** Quarters and sources each sum to the pooled tuple. */
function partitionSums(tables: Tables, id: (p: Partition) => string): Constraint[] {
  const out: Constraint[] = [];
  for (const group of [QUARTERS, SOURCES]) {
    const have = group.filter((p) => tables.partitions.includes(p));
    if (!have.length) continue;
    out.push({ terms: [...have.map((p) => ({ id: id(p), coef: 1 })), { id: id("all"), coef: -1 }], sense: "=", rhs: 0 });
  }
  return out;
}

const le = (a: string, b: string): Constraint => ({ terms: [{ id: a, coef: 1 }, { id: b, coef: -1 }], sense: "<=", rhs: 0 });
const sum = (ids: string[], sense: Constraint["sense"], rhs: number, extra: Term[] = []): Constraint => ({
  terms: [...ids.map((id) => ({ id, coef: 1 })), ...extra],
  sense,
  rhs,
});

export const decTuple = (d: string, p: string) => `dec|${d}|PASS|${p}`;
export const SENS = (id: string) => `${id}|sens`;
export const OTHER_TYPE = "other";
export const TOP_SOURCE_TYPES = 8;

/** Everything beyond the check tables that the release needs, besides the true model. */
export interface Model {
  truth: Truth;
  tables: Tables;
  decisionIds: string[];
  rules: Map<string, string[]>;
  n: number;
  excluded: number;
  sensIds: string[];
  /** H1 and H3 true counts (for the tests; the release publishes them only through their tuples). */
  h1: { c: number; n: number };
  h3: { c: number; n: number };
  /** Required checks each decision row bounds (publishable, not overridden). */
  decisionRows: Record<string, string[]>;
  sourceTypes: string[]; // top 8 in rank order, then "other" when anything is folded
  prisma: { identified: number; screened: number; merged: Record<string, number>; boxes: string[]; exclusions: string[] };
  confirmation: { proposed: number; changed: number; rejected: number; downgraded: number; perCheck: Record<string, { proposed: number; changed: number }> };
  precision: string[]; // checks with a prec tuple
  /** Checks whose precision cell, standing alone, could not keep MIN_VALUES feasible values once suppressed: no tuple. */
  precisionWithheld: string[];
  community: string[] | null;
}

const PRISMA_BOXES = ["assessed", "included", "included-insufficient-text"] as const;

/** Families of each merged exclusion key ("stage1", "stage2"; a key absorbing several is mixed). Protocol 6.7. */
function families(counts: Record<string, number>, merged: Record<string, number>, floor = 10): Map<string, Set<string>> {
  const isExcl = (k: string) => /^stage\d+:/.test(k) || k === "other";
  const fam = (k: string) => (k === "other" ? ["stage1", "stage2"] : [k.split(":")[0]!]);
  const small = Object.keys(counts).filter((k) => isExcl(k) && (counts[k]! < floor || k === "other"));
  const out = new Map<string, Set<string>>();
  for (const k of Object.keys(merged).filter(isExcl)) {
    if (k === "other") out.set(k, new Set(small.flatMap(fam)));
    else if (merged[k] !== counts[k]) out.set(k, new Set([...fam(k), ...small.flatMap(fam)]));
    else out.set(k, new Set(fam(k)));
  }
  return out;
}

export function buildModel(input: AggregateInput, tables: Tables, rules: Map<string, string[]>): Model {
  const truth = toTruth(tables);
  const T = (id: string, n: number, c: number) => truth.tuples.push({ id, n, c });
  const R = (c: Constraint) => truth.constraints.push(c);
  const pub = (id: string) => tables.publishable.has(id);
  const decisionIds = [...rules.keys()];
  const projects = includedProjects(input);
  const n = projects.length;

  // decisions by partition
  for (const p of tables.partitions) {
    for (const s of decisionShares(input, p, decisionIds)) T(decTuple(s.decisionId, p), s.n, s.c);
  }
  const decisionRows: Record<string, string[]> = {};
  for (const d of decisionIds) {
    for (const c of partitionSums(tables, (p) => decTuple(d, p))) R(c);
    const o = GATE_OVERRIDES[d];
    decisionRows[d] = rules.get(d)!.filter((c) => pub(c) && o?.checkId !== c);
    for (const p of tables.partitions) {
      for (const c of decisionRows[d]) R(le(decTuple(d, p), tupleId(c, "pass", p)));
      if (o) R(le(decTuple(d, p), decTuple(o.fromDecision, p)));
    }
  }

  // H1 (any claimed) and H3 (any rely check evidenced), over publishable checks
  const claimedIds = input.checkIds.filter(pub);
  const relyIds = (rules.get("rely") ?? []).filter(pub);
  const h1 = anyState(input, claimedIds, "claimed");
  const h3 = anyState(input, relyIds, "pass");
  T("h1|all", h1.n, h1.c);
  T("h3|all", h3.n, h3.c);
  for (const [h, ids, state] of [["h1|all", claimedIds, "claimed"], ["h3|all", relyIds, "pass"]] as const) {
    if (!ids.length) continue;
    for (const c of ids) R(le(tupleId(c, state, "all"), h));
    R(sum(ids.map((c) => tupleId(c, state, "all")), ">=", 0, [{ id: h, coef: -1 }]));
  }
  if (relyIds.length) R(le(decTuple("rely", "all"), "h3|all"));

  // protocol section 3 sensitivity: exclude launches whose collection failed
  const excluded = projects.filter((p) => !notFailed(p)).length;
  const sensIds: string[] = [];
  const sens = (id: string, c: number, nn: number) => {
    T(SENS(id), nn, c);
    sensIds.push(SENS(id));
    const diff = [{ id, coef: 1 }, { id: SENS(id), coef: -1 }];
    R({ terms: diff, sense: ">=", rhs: 0 });
    R({ terms: diff, sense: "<=", rhs: excluded });
  };
  const h1s = anyState(input, claimedIds, "claimed", notFailed);
  const h3s = anyState(input, relyIds, "pass", notFailed);
  sens("h1|all", h1s.c, h1s.n);
  sens("h3|all", h3s.c, h3s.n);
  for (const s of decisionShares(input, "all", decisionIds, notFailed)) sens(decTuple(s.decisionId, "all"), s.c, s.n);

  // source types: launches with >= 1 confirmed positive quoted from that type; top 8, rest folded
  const typeCount = new Map<string, number>();
  for (const p of projects) for (const t of new Set(p.sourceTypes ?? [])) typeCount.set(t, (typeCount.get(t) ?? 0) + 1);
  const ranked = [...typeCount.keys()].filter((t) => t !== OTHER_TYPE).sort((a, b) => typeCount.get(b)! - typeCount.get(a)! || (a < b ? -1 : 1));
  const top = ranked.slice(0, TOP_SOURCE_TYPES);
  const folded = new Set([...ranked.slice(TOP_SOURCE_TYPES), OTHER_TYPE]);
  const sourceTypes = [...top];
  for (const t of top) T(`st|${t}|all`, n, typeCount.get(t)!);
  const otherC = projects.filter((p) => (p.sourceTypes ?? []).some((t) => folded.has(t))).length;
  if (otherC > 0) {
    sourceTypes.push(OTHER_TYPE);
    T(`st|${OTHER_TYPE}|all`, n, otherC);
  }

  // PRISMA: small reasons merged (6.7) before they become tuples
  const counts = input.screening?.counts ?? {};
  const screened = counts.screened ?? 0;
  const merged = mergeSmallReasons(counts);
  const exclusions = Object.keys(merged).filter((k) => /^stage\d+:|^other$|^not-collectable:/.test(k));
  const s1 = Object.entries(counts).filter(([k]) => k.startsWith("stage1:")).reduce((a, [, v]) => a + v, 0);
  const boxes: string[] = [];
  if (input.screening) {
    const boxC: Record<string, number> = { assessed: screened - s1, included: counts.included ?? 0, "included-insufficient-text": counts["included-insufficient-text"] ?? 0 };
    for (const b of PRISMA_BOXES) {
      T(`prisma|${b}`, screened, boxC[b]!);
      boxes.push(b);
    }
    for (const k of exclusions) T(`prisma|${k}`, screened, merged[k]!);
    R(sum(["prisma|included", "prisma|included-insufficient-text", ...exclusions.map((k) => `prisma|${k}`)], "=", screened));
    R(sum(["prisma|included", "prisma|included-insufficient-text"], "=", n));
    const fam = families(counts, merged);
    const pure1 = [...fam].filter(([, f]) => f.size === 1 && f.has("stage1")).map(([k]) => `prisma|${k}`);
    const mixed1 = [...fam].filter(([, f]) => f.size > 1 && f.has("stage1")).map(([k]) => `prisma|${k}`);
    R(sum(["prisma|assessed", ...pure1], "<=", screened));
    R(sum(["prisma|assessed", ...pure1, ...mixed1], ">=", screened));
  }

  // pass precision against the independent labeller (c = gold-confirmed passes, n = coder passes)
  const precision: string[] = [];
  const precisionWithheld: string[] = [];
  for (const g of input.gate.checks) {
    const pr = (g as GateCheck & { precision?: { c: number; m: number } }).precision;
    if (!pr) continue;
    if (loneCellValues(pr.c, pr.m) < MIN_VALUES) {
      precisionWithheld.push(g.checkId);
      continue;
    }
    T(`prec|${g.checkId}`, pr.m, pr.c);
    precision.push(g.checkId);
  }

  // changes at confirmation: the total is a D-83 process figure, so the split is pinned to it
  const inSample = new Set(projects.map((p) => p.n));
  const perCheck: Record<string, { proposed: number; changed: number }> = Object.fromEntries(input.checkIds.map((c) => [c, { proposed: 0, changed: 0 }]));
  let rejected = 0;
  let downgraded = 0;
  for (const s of input.published) {
    if (!inSample.has(s.projectN) || !perCheck[s.checkId]) continue;
    if (s.basis === "confirmed" || s.basis === "downgraded" || s.basis === "rejected") perCheck[s.checkId]!.proposed++;
    if (s.basis === "downgraded" || s.basis === "rejected") perCheck[s.checkId]!.changed++;
    if (s.basis === "rejected") rejected++;
    if (s.basis === "downgraded") downgraded++;
  }
  const proposed = Object.values(perCheck).reduce((a, x) => a + x.proposed, 0);
  const changed = rejected + downgraded;
  T("conf|rejected", proposed, rejected);
  T("conf|downgraded", proposed, downgraded);
  R(sum(["conf|rejected", "conf|downgraded"], "=", changed));
  for (const c of input.checkIds) T(`conf|chk|${c}`, perCheck[c]!.proposed, perCheck[c]!.changed);
  R(sum(input.checkIds.map((c) => `conf|chk|${c}`), "=", changed));

  // provider-extracted visibility (PUB-05)
  T("vis|provider-only", n, projects.filter((p) => p.providerOnly).length);

  // A4 community layer: exploratory aggregate counts only
  const community = input.community ? Object.keys(input.community).sort() : null;
  for (const k of community ?? []) T(`comm|${k}|all`, n, input.community![k]!);

  return {
    truth,
    tables,
    decisionIds,
    rules,
    n,
    excluded,
    sensIds,
    h1,
    h3,
    decisionRows,
    sourceTypes,
    prisma: { identified: input.screening?.identified ?? 0, screened, merged, boxes, exclusions },
    confirmation: { proposed, changed, rejected, downgraded, perCheck },
    precision,
    precisionWithheld,
    community,
  };
}

/**
 * Feasible values of a cell that no row links to anything: all n + 1 when published, else the values its
 * display state allows ("<10": c <= 9; "suppressed": c >= 10 with n - c < 10).
 */
export function loneCellValues(c: number, n: number): number {
  if (c >= FLOOR && n - c >= FLOOR) return n + 1;
  return c < FLOOR ? Math.min(FLOOR - 1, n) + 1 : n - Math.max(FLOOR, n - FLOOR + 1) + 1;
}

const pct = (x: number) => Math.round(100 * x);

/** Resolves a tuple id to its display row from the closed release. */
export function rowResolver(release: Release, display: Map<string, "lt10" | "suppressed">) {
  const byId = new Map(release.tuples.map((t) => [t.id, t]));
  return (id: string, label: string, opts: { withheld?: string; absent?: string; note?: string } = {}): Row => {
    if (opts.withheld) return { id, label, state: "withheld", reason: opts.withheld };
    if (opts.absent) return { id, label, state: "absent", reason: opts.absent };
    const t = byId.get(id);
    if (!t) throw new Error(`no tuple ${id}`);
    if (t.c === null) {
      // a not-estimable check keeps its label note whatever the count's display state (never shown as validated)
      const r: Row = display.get(id) === "lt10" ? { id, label, state: "lt10" } : { id, label, state: "suppressed", reason: SUPPRESSED_REASON };
      if (opts.note) r.note = opts.note;
      return r;
    }
    const [lo, hi] = wilson(t.c, t.n);
    const row: Row = { id, label, state: "released", c: t.c, n: t.n, pct: t.n ? pct(t.c / t.n) : 0, ci: [pct(lo), pct(hi)] };
    if (opts.note) row.note = opts.note;
    return row;
  };
}

export type RowOf = ReturnType<typeof rowResolver>;

/** Closed release + display states -> figures of release.json. */
export function renderFigures(
  model: Model,
  row: RowOf,
  labels: Record<string, string>,
  checkDecision: Record<string, string>,
  decisionLabels: Record<string, string>,
): Record<string, Figure> {
  const { tables } = model;
  const chk = (checkId: string, state: string, partition: Partition, label: string) => {
    const g = tables.gate.get(checkId)!;
    const id = tupleId(checkId, state, partition);
    if (!tables.publishable.has(checkId)) return row(id, label, { withheld: WITHHELD_REASON[g.status] ?? WITHHELD_REASON.withheld });
    const absent = tables.absent.get(partition);
    if (absent) return row(id, label, { absent });
    return row(id, label, { note: g.status === "released-not-estimable" ? NOT_ESTIMABLE_NOTE : undefined });
  };
  const dec = (d: string, partition: Partition, label: string) => {
    const absent = tables.absent.get(partition);
    return absent ? row(decTuple(d, partition), label, { absent }) : row(decTuple(d, partition), label);
  };
  const plabel = (base: string, p: Partition) => (p === "all" ? base : `${base} (${PARTITION_LABEL[p]})`);
  const figures: Record<string, Figure> = {};
  const fig = (id: string, title: string, measure: string, rows: Row[]) => (figures[id] = { id, title, measure, rows });

  for (const d of model.decisionIds) {
    fig(
      `checks:${d}`,
      `Checks for the decision: ${decisionLabels[d]}`,
      "share of included launches that publicly evidence the check (confirmed pass)",
      tables.checkIds.filter((c) => checkDecision[c] === d).map((c) => chk(c, "pass", "all", labels[c]!)),
    );
  }
  fig(
    "decisions",
    "Evidence by decision",
    "share of included launches whose confirmed check states let the deterministic gate support the decision",
    model.decisionIds.map((d) => dec(d, "all", decisionLabels[d]!)),
  );
  for (const d of model.decisionIds) {
    fig(`cohorts:${d}`, `Launch cohorts: ${decisionLabels[d]}`, "share of the quarter's included launches, as evidenced today", QUARTERS.map((p) => dec(d, p, PARTITION_LABEL[p])));
    fig(`sources:${d}`, `Discovery sources: ${decisionLabels[d]}`, "share of the source's included launches", SOURCES.map((p) => dec(d, p, PARTITION_LABEL[p])));
  }
  fig(
    "claims",
    "Claims and evidence",
    "per check: share that claim it without linking an artefact, then share that publicly evidence it",
    tables.checkIds.flatMap((c) => [chk(c, "claimed", "all", `${labels[c]} (claimed, no artefact linked)`), chk(c, "pass", "all", `${labels[c]} (publicly evidenced)`)]),
  );
  fig(
    "sourceTypes",
    "Where launches put their evidence",
    "share of included launches with at least one confirmed positive quoted from the source type; one launch can count under several types",
    model.sourceTypes.map((t) => row(`st|${t}|all`, t === OTHER_TYPE ? "other source types" : t)),
  );
  for (const [id, title, parts] of [
    ["checksByCohort", "Checks by launch cohort", QUARTERS],
    ["checksBySource", "Checks by discovery source", SOURCES],
  ] as const) {
    fig(
      id,
      title,
      "share of the group's included launches, per check and state",
      tables.checkIds.flatMap((c) => STATES.flatMap((s) => parts.map((p) => chk(c, s, p, plabel(`${labels[c]} (${s === "pass" ? "publicly evidenced" : "claimed, no artefact linked"})`, p))))),
    );
  }
  return figures;
}
