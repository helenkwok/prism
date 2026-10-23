// PUB-03 / PUB-01: the aggregate side of the export boundary. Turns per-project
// published states into check-level counts by partition. Pure apart from
// loadFixture(); nothing here writes.
//
// Count rule (protocol section 3, A7.8): N is every included project (tag
// "sample"); pass counts confirmed passes only; a rejected positive is not
// evidenced and stays in N; a downgraded pass counts as claimed.

import fs from "node:fs";

import type { PublishedBasis, PublishedState } from "../pipeline/confirm/confirm.ts";

// Local copy of the 04-11 gate contract (Pitfall 5: the gate module is not built yet).
export const PUBLISHABLE = ["released", "released-not-estimable", "corrected-revalidated", "person-coded"] as const;
export type GateStatus = (typeof PUBLISHABLE)[number] | "missed" | "withheld";

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
  };
}
