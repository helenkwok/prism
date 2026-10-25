// PUB-03 / PUB-01: the aggregate side of the export boundary. Turns per-project
// published states into check-level counts by partition. Pure apart from
// loadFixture(); nothing here writes.
//
// Count rule (protocol section 3, A7.8): N is every included project (tag
// "sample"); pass counts confirmed passes only; a rejected positive is not
// evidenced and stays in N; a downgraded pass counts as claimed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PublishedBasis, PublishedState } from "../pipeline/confirm/confirm.ts";
import { PUBLISHABLE as GATE_PUBLISHABLE } from "../pipeline/validate/gate.ts";

/** The 04-11 gate contract, from gate.ts (one source of truth). */
export const PUBLISHABLE: readonly string[] = [...GATE_PUBLISHABLE];
export type GateStatus = "released" | "released-not-estimable" | "corrected-revalidated" | "person-coded" | "missed" | "withheld";

export interface GateCheck {
  checkId: string;
  status: GateStatus;
  reason: string;
  goldPasses?: number;
}

export interface Project {
  n: number;
  quarter: number;
  source: string;
  tag: string;
  hnId: string;
  title: string;
  finalUrl: string;
  /** One letter per decision in decision-gates.json order: P (PASS), B (BLOCKED), I (INSUFFICIENT_EVIDENCE). */
  decisions?: string;
  /** Extraction failed or the site was blocked: excluded from the section 3 sensitivity lines. */
  collectionFailed?: boolean;
  /** Source types of this launch's confirmed positives (classified from cited span URLs in plan 08). */
  sourceTypes?: string[];
  /** Every confirmed positive came only from provider-extracted text. */
  providerOnly?: boolean;
}

export interface LedgerEntry {
  id: string;
  n: number;
  c: number;
  version: string;
}

export interface AggregateInput {
  synthetic: boolean;
  release: { version: string; date: string };
  checkIds: string[];
  projects: Project[];
  published: PublishedState[];
  gate: { checks: GateCheck[] };
  ledger: LedgerEntry[];
  picks?: { tag: string }[];
  /** Release seed label (H2 permutation). */
  seed?: string;
  method?: { frame: string; window: string };
  validation?: Validation;
  /** PRISMA: frame size and the draw.ts prismaCounts of the screening log. */
  screening?: { identified: number; counts: Record<string, number> };
  roles?: RoleRecord[];
  /** Label edits made by a person (effective states with a person actor). */
  edits?: { projectN: number; checkId: string }[];
  /** A4 community layer: aggregate counts over included launches, or null when not part of the release. */
  community?: Record<string, number> | null;
  /** Hand-written, kind-tagged statements from the private side; linted like every template. */
  notes?: { id: string; kind: string; text: string }[];
  /** Display label overrides by key (check id or "decision:<id>"). */
  labels?: Record<string, string>;
}

export interface RoleRecord {
  role: string;
  kind: string;
  modelId: string;
  host: string;
  manifest: { promptVersion: string; codebookVersion: string; seed: string; tokenCap: number };
}

export interface Validation {
  screeningAudit: { errors: number; audited: number; bar: number; remeasureErrors: number; sample: number };
  collectionRecall: {
    supportedFound: number;
    supported: number;
    contributed: number;
    projects: number;
    rawFound: number;
    raw: number;
    gathered: number;
    gatheredSupported: number;
    unsupported: number;
    boilerplate: number;
  };
  crossCheck: { projects: number; positiveAgreement: number; allStates: number };
}

export type CountState = "pass" | "claimed";
export const STATES: CountState[] = ["pass", "claimed"];

export const PARTITIONS = ["all", "q1", "q2", "q3", "q4", "src:show-hn", "src:reddit", "src:github-only"] as const;
export type Partition = (typeof PARTITIONS)[number];

export function inPartition(p: Project, partition: Partition): boolean {
  if (partition === "all") return true;
  if (partition.startsWith("q")) return p.quarter === Number(partition.slice(1));
  return p.source === partition.slice(4);
}

export interface Share {
  checkId: string;
  state: CountState;
  partition: Partition;
  c: number;
  n: number;
}

export const tupleId = (checkId: string, state: string, partition: string) => `chk|${checkId}|${state}|${partition}`;

/** Counts of one state per check over one partition. Callers decide publishability. */
export function checkShares(input: AggregateInput, partition: Partition, state: CountState = "pass", checkIds = input.checkIds): Share[] {
  const included = input.projects.filter((p) => p.tag === "sample" && inPartition(p, partition));
  const ns = new Set(included.map((p) => p.n));
  const counts = new Map<string, number>(checkIds.map((id) => [id, 0]));
  for (const s of input.published) {
    if (ns.has(s.projectN) && counts.has(s.checkId) && s.published === state) counts.set(s.checkId, counts.get(s.checkId)! + 1);
  }
  return checkIds.map((checkId) => ({ checkId, state, partition, c: counts.get(checkId)!, n: included.length }));
}

// Compact fixture letters -> published state and basis (protocol A7.8).
const LETTERS: Record<string, { published: string | null; basis: PublishedBasis }> = {
  p: { published: "pass", basis: "confirmed" },
  c: { published: "claimed", basis: "confirmed" },
  u: { published: "unknown", basis: "not-positive" },
  f: { published: "fail", basis: "not-positive" },
  x: { published: null, basis: "rejected" },
  d: { published: "claimed", basis: "downgraded" },
};

/** Read the compact synthetic store and expand it to an AggregateInput. */
export function loadFixture(file: string): AggregateInput {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return expandFixture(raw);
}

export function expandFixture(raw: any): AggregateInput {
  const overrides = new Map<string, PublishedBasis>();
  for (const u of raw.unconfirmed ?? []) overrides.set(`${u.projectN}|${u.checkId}`, u.basis);
  const published: PublishedState[] = [];
  const projects: Project[] = raw.projects.map((p: any) => {
    if (p.states.length !== raw.checkIds.length) throw new Error(`project ${p.n}: ${p.states.length} states for ${raw.checkIds.length} checks`);
    raw.checkIds.forEach((checkId: string, k: number) => {
      const letter = LETTERS[p.states[k]];
      if (!letter) throw new Error(`project ${p.n}: unknown state letter ${p.states[k]}`);
      const basis = overrides.get(`${p.n}|${checkId}`);
      published.push(basis ? { projectN: p.n, checkId, published: null, basis } : { projectN: p.n, checkId, ...letter });
    });
    const { states: _states, ...rest } = p;
    return rest;
  });
  return {
    synthetic: raw.synthetic === true,
    release: raw.release,
    checkIds: raw.checkIds,
    projects,
    published,
    gate: raw.gate,
    ledger: raw.ledger ?? [],
    picks: raw.picks,
    seed: raw.seed,
    method: raw.method,
    validation: raw.validation,
    screening: raw.screening,
    roles: raw.roles,
    edits: raw.edits ?? [],
    community: raw.community ?? null,
    notes: raw.notes ?? [],
    labels: raw.labels ?? {},
  };
}

// ---------- decisions (PUB-01; the deterministic gate decides, never a model) ----------

const GATES_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../vendor/ai-output-to-value/schemas/v1/decision-gates.json");

/** decision id -> required check ids, in decision-gates.json order (the order of Project.decisions). */
export function loadDecisionRules(file = GATES_PATH): Map<string, string[]> {
  const gates = JSON.parse(fs.readFileSync(file, "utf8")).decisions as Record<string, { requiredChecks: { id: string }[] }>;
  return new Map(Object.entries(gates).map(([id, d]) => [id, d.requiredChecks.map((c) => c.id)]));
}

/** decision id -> the gate file's label. */
export function loadDecisionLabels(file = GATES_PATH): Record<string, string> {
  const gates = JSON.parse(fs.readFileSync(file, "utf8")).decisions as Record<string, { label: string }>;
  return Object.fromEntries(Object.entries(gates).map(([id, d]) => [id, d.label]));
}

/** operate's deliverable-gate-passed comes from rely's gate result, never from its coded state (build-claims.ts). */
export const GATE_OVERRIDES: Record<string, { checkId: string; fromDecision: string }> = {
  operate: { checkId: "deliverable-gate-passed", fromDecision: "rely" },
};

export const includedProjects = (input: AggregateInput) => input.projects.filter((p) => p.tag === "sample");
export const notFailed = (p: Project) => !p.collectionFailed;

/** Projects whose decision string says PASS while a required check is not a published pass. */
export function inconsistentDecisions(input: AggregateInput, rules: Map<string, string[]>): string[] {
  const ids = [...rules.keys()];
  const pass = new Set(input.published.filter((s) => s.published === "pass").map((s) => `${s.projectN}|${s.checkId}`));
  const bad: string[] = [];
  for (const p of includedProjects(input)) {
    const ds = p.decisions;
    if (ds === undefined) continue;
    if (ds.length !== ids.length || /[^PBI]/.test(ds)) {
      bad.push(`project ${p.n}: decision string`);
      continue;
    }
    ids.forEach((d, k) => {
      if (ds[k] !== "P") return;
      const o = GATE_OVERRIDES[d];
      for (const c of rules.get(d)!) {
        const ok = o?.checkId === c ? ds[ids.indexOf(o.fromDecision)] === "P" : pass.has(`${p.n}|${c}`);
        if (!ok) bad.push(`project ${p.n}: ${d} PASS without ${c}`);
      }
    });
  }
  return bad;
}

export interface Counts {
  c: number;
  n: number;
}

/** Launches whose gate result for each decision is PASS, over one partition (optionally a subset). */
export function decisionShares(input: AggregateInput, partition: Partition, decisionIds: string[], subset?: (p: Project) => boolean) {
  const ps = includedProjects(input).filter((p) => inPartition(p, partition) && (!subset || subset(p)));
  return decisionIds.map((decisionId, k) => ({ decisionId, c: ps.filter((p) => p.decisions?.[k] === "P").length, n: ps.length }));
}

/** Included launches (optionally a subset) with at least one published state `state` among `checkIds`. */
export function anyState(input: AggregateInput, checkIds: string[], state: CountState, subset?: (p: Project) => boolean): Counts {
  const ps = includedProjects(input).filter((p) => !subset || subset(p));
  const ns = new Set(ps.map((p) => p.n));
  const want = new Set(checkIds);
  const hit = new Set(input.published.filter((s) => ns.has(s.projectN) && want.has(s.checkId) && s.published === state).map((s) => s.projectN));
  return { c: hit.size, n: ps.length };
}
