// APP-04 read model (research Pattern 3): one project's PUBLISHED states,
// cited spans and confirmation records become a gate-first ReportView. The
// verdicts come only from buildClaimsForProject + the injected gate over the
// published states; a published null (awaiting confirmation) reaches the gate
// as unknown. The builder emits plain strings only, never markup (T-07-14).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { buildClaimsForProject, type DecisionGatesFile, type DecisionId, type RunGateFn } from "../pipeline/claims/build-claims.ts";
import type { CheckEntry } from "../pipeline/coding/contract.ts";
import type { Codebook } from "../pipeline/coding/codebook-prompt.ts";
import type { PublishedBasis } from "../pipeline/confirm/confirm.ts";

export type GateStatus = "PASS" | "BLOCKED" | "INSUFFICIENT_EVIDENCE";
export type PublishedValue = "pass" | "claimed" | "unknown" | "fail" | null;
export type GapSource = "gap-text" | "passRule";

export const CROSSWALK_ORDER = ["iso42001", "gaicc", "nistAiRmf", "euAiAct", "oecd"] as const;
const DECISION_ORDER: DecisionId[] = ["explore", "rely", "operate", "measure-outcome", "scale-renew-stop"];

export interface RoleLine {
  role: string;
  modelId: string | null;
  host: string | null;
}

export interface ConfirmationLine {
  decision: string;
  role: string;
  actorKind: string;
  modelId: string | null;
  decidedAt: string;
}

/** Everything the builder needs about one project, already read from the private store or a fixture. */
export interface ReportSource {
  projectId: string;
  hnId: number | null;
  /** The launch post title, e.g. "Show HN: Name – tagline". */
  title: string;
  collectedAt: string;
  codebookVersion: string;
  generatedAt: string;
  fixture: boolean;
  pages: { url: string; snapshotHash: string; rendered: boolean }[];
  renderAvailable: boolean;
  /** One entry per gate check, from publishedStates() (confirm.ts). */
  published: { checkId: string; published: PublishedValue; basis: PublishedBasis }[];
  spans: Record<string, { text: string; url: string | null; snapshotHash: string | null }>;
  /** The span ids each check cites. */
  cites: Record<string, string[]>;
  flaggedSpanIds: string[];
  confirmations: Record<string, ConfirmationLine[]>;
  roles: { coding: RoleLine; confirmation: RoleLine; humanEdits: string; run?: LiveRunLine };
}

/** A live run's receipt (BYOK, 2026-10-24): collector, model provider and which key paid. Never a key. */
export interface LiveRunLine {
  collector: string;
  provider: string;
  paidBy: string;
  receipt?: import("../app/server/live-options.ts").RunReceipt;
}

export interface Quote {
  spanId: string;
  text: string;
  url: string | null;
  snapshotHash: string | null;
  injectionFlagged: boolean;
}

export interface CrosswalkChip {
  standard: string;
  locator: string;
  relationType: "addresses" | "supports" | "partial";
  informational: boolean;
}

export interface Tally {
  pass: number;
  claimed: number;
  unknown: number;
  fail: number;
  awaiting: number;
}

export interface DecisionView {
  decisionId: DecisionId;
  label: string;
  status: GateStatus;
  requiredChecks: string[];
  tally: Tally;
}

export interface CheckView {
  checkId: string;
  decision: string;
  label: string;
  /** The published state; null = awaiting confirmation (a rejected positive is "unknown"). */
  published: PublishedValue;
  basis: PublishedBasis;
  quotes: Quote[];
  crosswalk: CrosswalkChip[];
  gapText: string | null;
  gapSource: GapSource | null;
  confirmations: ConfirmationLine[];
}

export interface ReportView {
  version: 1;
  view: "identifiable";
  projectRef: string;
  title: string;
  fixture: boolean;
  generatedAt: string;
  codebookVersion: string;
  gateSha: string;
  collection: { pages: number; rendered: number; notRendered: number; renderAvailable: boolean; collectedAt: string; urls: string[] };
  decisions: DecisionView[];
  checks: CheckView[];
  howMade: { coding: RoleLine; confirmation: RoleLine; gateSha: string; humanEdits: string; run?: LiveRunLine };
}

export type GapTextFn = (checkId: string) => { text: string; source: GapSource };

/**
 * The report title (Helen, 07-03 Q4: launch title): the product name from the
 * launch post title, i.e. the text after "Show HN:" up to the first " – ",
 * " - " or ":". No company-supplied display title is used.
 */
export function productName(launchTitle: string): string {
  const rest = launchTitle.replace(/^\s*Show HN:\s*/i, "");
  const cut = rest.search(/ – | - |:/);
  return (cut === -1 ? rest : rest.slice(0, cut)).trim();
}

/** sha256 over the entries with sorted keys: the digest an approval record binds to. */
export function gapTextDigest(entries: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.keys(entries).sort().map((k) => [k, entries[k]]));
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/**
 * The gap-text source. protocol/gap-text.json is used only when it carries an
 * approval whose digest equals the digest of its entries; otherwise (or for a
 * check the file does not cover) the codebook pass rule is shown, and
 * gapSource says which (T-07-15: drafted text is never shown as approved).
 */
export function loadGapText({ repoRoot = process.cwd(), codebook, file }: { repoRoot?: string; codebook: Codebook; file?: string }): GapTextFn {
  const p = file ?? path.join(repoRoot, "protocol", "gap-text.json");
  let approved: Record<string, string> | null = null;
  if (fs.existsSync(p)) {
    const g = JSON.parse(fs.readFileSync(p, "utf8"));
    if (g?.entries && g.approval && typeof g.approval.digest === "string" && g.approval.digest === gapTextDigest(g.entries)) {
      approved = g.entries;
    }
  }
  return (checkId) => {
    const text = approved?.[checkId];
    if (typeof text === "string") return { text, source: "gap-text" };
    const rule = codebook.checks[checkId]?.passRule;
    if (!rule) throw new Error(`codebook has no check "${checkId}"`);
    return { text: rule, source: "passRule" };
  };
}

function gateFile(gatesPath: string): DecisionGatesFile {
  return JSON.parse(fs.readFileSync(gatesPath, "utf8"));
}

/** Check ids in decision-gates.json order (the codebook uses the same order). */
export function gateCheckOrder(gatesPath: string): string[] {
  const ids: string[] = [];
  for (const d of Object.values(gateFile(gatesPath).decisions)) for (const c of d.requiredChecks) if (!ids.includes(c.id)) ids.push(c.id);
  return ids;
}

export async function buildReportView(
  source: ReportSource,
  { codebook, gatesPath, runGate, gapText }: { codebook: Codebook; gatesPath: string; runGate: RunGateFn; gapText: GapTextFn },
): Promise<ReportView> {
  const gates = gateFile(gatesPath);
  const order = gateCheckOrder(gatesPath);
  const byId = new Map(source.published.map((p) => [p.checkId, p]));
  for (const id of order) if (!byId.has(id)) throw new Error(`${source.projectId}: no published state for ${id}`);

  // A rejected positive is published null but decided: it shows as unknown, not awaiting.
  const shown = (id: string): PublishedValue => {
    const p = byId.get(id)!;
    return p.published === null && p.basis === "rejected" ? "unknown" : p.published;
  };

  // Only published states reach the gate; null (awaiting) is given to it as unknown.
  const filteredStates: CheckEntry[] = order.map((id) => ({
    checkId: id,
    proposedState: shown(id) ?? "unknown",
    spanIds: source.cites[id] ?? [],
  }));
  const spanUrls: Record<string, string> = {};
  for (const [sid, s] of Object.entries(source.spans)) if (s.url) spanUrls[sid] = s.url;

  const results = await buildClaimsForProject({ project: source.projectId, filteredStates, spanUrls, runGate, gatesPath });
  const gateSha = results.rely.gateResult.gateSha;

  const decisions: DecisionView[] = DECISION_ORDER.map((id) => {
    const rule = gates.decisions[id];
    const { record, gateResult } = results[id];
    const tally: Tally = { pass: 0, claimed: 0, unknown: 0, fail: 0, awaiting: 0 };
    for (const c of rule.requiredChecks) {
      // What the gate saw decides pass/fail (incl. operate's deliverable-gate-passed override);
      // claimed and awaiting are told apart from plain unknown for the tally line.
      const g = record.gateChecks[c.id];
      if (g === "pass") tally.pass++;
      else if (g === "fail") tally.fail++;
      else if (c.id === "deliverable-gate-passed" && id === "operate") tally.unknown++;
      else if (shown(c.id) === "claimed") tally.claimed++;
      else if (shown(c.id) === null) tally.awaiting++;
      else tally.unknown++;
    }
    return { decisionId: id, label: rule.label, status: gateResult.status, requiredChecks: rule.requiredChecks.map((c) => c.id), tally };
  });

  const flagged = new Set(source.flaggedSpanIds);
  const checks: CheckView[] = order.map((id) => {
    const cb = codebook.checks[id];
    if (!cb) throw new Error(`codebook has no check "${id}"`);
    const published = shown(id);
    const quotes: Quote[] = (source.cites[id] ?? []).map((sid) => {
      const s = source.spans[sid];
      if (!s) throw new Error(`${source.projectId}: ${id} cites unknown span ${sid}`);
      return { spanId: sid, text: s.text, url: s.url, snapshotHash: s.snapshotHash, injectionFlagged: flagged.has(sid) };
    });
    const crosswalk: CrosswalkChip[] = CROSSWALK_ORDER.flatMap((std) =>
      (cb.crosswalk[std] ?? []).map((e) => ({ standard: std, locator: e.locator, relationType: e.relation_type, informational: e.informational === true })),
    );
    const gap = published === "pass" ? null : gapText(id);
    return {
      checkId: id,
      decision: cb.decision,
      label: cb.label,
      published,
      basis: byId.get(id)!.basis,
      quotes,
      crosswalk,
      gapText: gap ? gap.text : null,
      gapSource: gap ? gap.source : null,
      confirmations: source.confirmations[id] ?? [],
    };
  });

  const rendered = source.pages.filter((p) => p.rendered).length;
  return {
    version: 1,
    view: "identifiable",
    projectRef: source.projectId,
    title: productName(source.title),
    fixture: source.fixture,
    generatedAt: source.generatedAt,
    codebookVersion: source.codebookVersion,
    gateSha,
    collection: {
      pages: source.pages.length,
      rendered,
      notRendered: source.pages.length - rendered,
      renderAvailable: source.renderAvailable,
      collectedAt: source.collectedAt,
      urls: source.pages.map((p) => p.url),
    },
    decisions,
    checks,
    howMade: {
      coding: source.roles.coding,
      confirmation: source.roles.confirmation,
      gateSha,
      humanEdits: source.roles.humanEdits,
      ...(source.roles.run ? { run: source.roles.run } : {}),
    },
  };
}

const STATE_CHARS: Record<string, PublishedValue> = { p: "pass", c: "claimed", u: "unknown", f: "fail", n: null };

/**
 * Expand one synthetic-corpus project (tests/fixtures/report/synthetic-corpus.json)
 * into a ReportSource. The states string is one character per gate check in
 * decision-gates.json order; default basis is confirmed for a positive,
 * not-positive for unknown/fail, unconfirmed for null; `basis` overrides it.
 */
export function sourceFromFixture(corpus: { synthetic?: boolean; generatedAt: string; checkOrder?: string[] }, p: any, checkOrder: string[]): ReportSource {
  if (corpus.checkOrder && corpus.checkOrder.join() !== checkOrder.join()) throw new Error("corpus checkOrder differs from the gate file");
  if (typeof p.states !== "string" || p.states.length !== checkOrder.length) throw new Error(`${p.projectId}: states must have ${checkOrder.length} characters`);
  const published = checkOrder.map((checkId, i) => {
    const ch = p.states[i];
    if (!(ch in STATE_CHARS)) throw new Error(`${p.projectId}: bad state "${ch}"`);
    const value = STATE_CHARS[ch];
    const basis: PublishedBasis =
      p.basis?.[checkId] ?? (value === "pass" || value === "claimed" ? "confirmed" : value === null ? "unconfirmed" : "not-positive");
    return { checkId, published: basis === "rejected" ? null : value, basis };
  });
  return {
    projectId: p.projectId,
    hnId: p.hnId ?? null,
    title: p.title,
    collectedAt: p.collectedAt,
    codebookVersion: p.codebookVersion,
    generatedAt: corpus.generatedAt,
    fixture: corpus.synthetic === true,
    pages: p.pages,
    renderAvailable: p.renderAvailable,
    published,
    spans: p.spans ?? {},
    cites: p.cites ?? {},
    flaggedSpanIds: p.flaggedSpanIds ?? [],
    confirmations: p.confirmations ?? {},
    roles: p.roles,
  };
}
