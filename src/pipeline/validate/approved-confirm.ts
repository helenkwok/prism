// Full confirmation uses an injected, persistently budgeted client after spike review.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Kysely } from "kysely";
import type { Codebook } from "../coding/codebook-prompt.ts";
import { DollarBudget } from "../coding/spend-guards.ts";
import {
  confirmationStatus, confirmedStateFor, confirmWithModel, effectiveStates,
  ensureConfirmationSchema, ensureEditsSchema, inputDigest, projectSpans, readPositives,
  recordConfirmation, type Positive,
} from "../confirm/confirm.ts";
import { ARTCRAFT_HN_ID } from "../select/draw-sample.ts";

type SpikeOutcome = { projectN: number; checkId: string; state: string; setting: boolean; failed?: boolean; decision: string | null; spans: unknown; flaggedSpanIds?: string[] };
export type SpikeReview = {
  completed: boolean; model: string; selectedSetting: boolean; spikeDigest: string;
  reviewedDecisions: number; contractFailures: number; registeredThresholdBreached: boolean;
  supportedBySetting: { on: number; off: number };
};
type Spike = { model: string; completedExperiment: boolean; decisions: SpikeOutcome[]; stopped?: unknown; selected: { projectN: number; checkId: string; digest: string }[] };
const digest = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const canonicalModel = (model: string) => model.replace(/:cloud$/, "");

/** No new error-rate cutoff: invalid outcomes remain in the comparison denominator. */
export function validateSpikeReview(review: SpikeReview, spikeText: string, { model, reasoning }: { model: string; reasoning: boolean }): void {
  const spike: Spike = JSON.parse(spikeText);
  if (review.completed !== true || review.spikeDigest !== digest(spikeText) ||
      canonicalModel(review.model) !== canonicalModel(model) || canonicalModel(spike.model) !== canonicalModel(model) ||
      typeof review.selectedSetting !== "boolean" || review.selectedSetting !== reasoning ||
      review.registeredThresholdBreached !== false || review.contractFailures !== 0 ||
      spike.completedExperiment !== true || spike.stopped != null ||
      !Array.isArray(spike.decisions) || spike.decisions.length !== 60 || review.reviewedDecisions !== 60 ||
      !Array.isArray(spike.selected) || spike.selected.length !== 30)
    throw new Error("full confirmation requires completed, current, matching spike review");
  for (const count of [review.supportedBySetting?.on, review.supportedBySetting?.off]) {
    if (!Number.isInteger(count) || count < 0 || count > 30) throw new Error("invalid spike review comparison counts");
  }
  const pairs = new Map<string, SpikeOutcome[]>();
  for (const row of spike.decisions) {
    if (typeof row.setting !== "boolean") throw new Error("spike setting must be boolean");
    const key = `${row.projectN}:${row.checkId}`;
    const rows = pairs.get(key) ?? []; rows.push(row); pairs.set(key, rows);
  }
  if (pairs.size !== 30) throw new Error("spike requires thirty paired positives");
  if (new Set(spike.selected.map(row => `${row.projectN}:${row.checkId}`)).size !== 30 ||
      spike.selected.some(row => !pairs.has(`${row.projectN}:${row.checkId}`) || !/^[a-f0-9]{64}$/.test(row.digest))) throw new Error("spike selected inputs missing");
  for (const rows of pairs.values()) {
    if (rows.length !== 2 || rows[0].setting === rows[1].setting || rows[0].state !== rows[1].state ||
        JSON.stringify(rows[0].spans) !== JSON.stringify(rows[1].spans) ||
        JSON.stringify(rows[0].flaggedSpanIds ?? []) !== JSON.stringify(rows[1].flaggedSpanIds ?? []))
      throw new Error("spike conditions must use identical cited evidence");
  }
  if (!spike.decisions.some(row => row.setting === reasoning && !row.failed &&
      (row.decision === "confirmed" || row.decision === "rejected" || (row.decision === "downgraded" && row.state === "pass"))))
    throw new Error("selected spike condition has no valid decisions");
  for (const setting of [true, false]) {
    const valid = spike.decisions.filter(row => row.setting === setting && !row.failed &&
      (row.decision === "confirmed" || row.decision === "rejected" || (row.decision === "downgraded" && row.state === "pass"))).length;
    if (review.supportedBySetting[setting ? "on" : "off"] > valid) throw new Error("supported count exceeds valid spike decisions");
  }
}

export type FullConfirmationAccounting = {
  stage: "full-confirm"; total: number; accounted: number; cached: number; attempted: number;
  valid: number; failed: number; stopped: number; remaining: number; awaitingGold: number;
  confirmed: number; rejected: number; downgraded: number; flagged: number; excludedA3: number;
  reason: string | null; ok: boolean; complete: boolean;
};
type Client = Parameters<typeof confirmWithModel>[0] & { dollarBudget: DollarBudget };
export type FullConfirmationOptions = {
  db: Kysely<any>; dataDir: string; client: Client; codebook: Codebook; model: string;
  reasoning: boolean; entries: { n: number; hn_id: string }[]; goldOrder: string[];
  log?: (line: string) => void;
};

function validCachedDecision(row: any, p: Positive): boolean {
  const allowed = row.decision === "confirmed" || row.decision === "rejected" || (row.decision === "downgraded" && p.state === "pass");
  const flagged = p.spans.some(s => p.flaggedSpanIds?.includes(s.id));
  return allowed && typeof row.reason === "string" && (!flagged || row.decision === "rejected") &&
    row.confirmed_state === confirmedStateFor(row.decision, p.state) &&
    row.span_ids_json === JSON.stringify(p.spans.map(s => s.id));
}

export async function runApprovedConfirmation(o: FullConfirmationOptions): Promise<FullConfirmationAccounting> {
  if (canonicalModel(o.model) !== "nemotron-3-ultra" || typeof o.reasoning !== "boolean") throw new Error("approved full confirmer requires pinned model and boolean setting");
  if (!(o.client.dollarBudget instanceof DollarBudget) || o.client.dollarBudget.cap > 5) throw new Error("full confirmation requires the approved budget, capped at five dollars");
  const spikePath = path.join(o.dataDir, "validation", "confirmation-spike.json");
  const reviewPath = path.join(o.dataDir, "validation", "confirmation-spike-review.json");
  const spikeText = fs.readFileSync(spikePath, "utf8");
  validateSpikeReview(JSON.parse(fs.readFileSync(reviewPath, "utf8")), spikeText, { model: o.model, reasoning: o.reasoning });
  const spike: Spike = JSON.parse(spikeText);
  const log = o.log ?? console.log;
  const entries = o.entries.filter(e => String(e.hn_id) !== ARTCRAFT_HN_ID);
  if (!entries.length || new Set(entries.map(e => e.n)).size !== entries.length ||
      entries.some(e => !Number.isInteger(e.n) || e.n <= 0)) throw new Error("invalid full confirmation sample");
  const byN = new Map(entries.map(e => [e.n, String(e.hn_id)]));
  const order = new Map(o.goldOrder.map((id, i) => [String(id), i]));
  if (entries.some(e => !order.has(String(e.hn_id)))) throw new Error("full confirmation sample missing from gold order");
  await ensureConfirmationSchema(o.db); await ensureEditsSchema(o.db);
  // readPositives tolerates a missing flags table for legacy callers; this run must fail closed.
  await o.db.selectFrom("pipeline_injection_flags").select("project_n").limit(1).execute();
  const { positives, awaitingGold } = await readPositives(o.db, o.dataDir, { sampleNs: entries.map(e => e.n), codebookVersion: o.codebook.codebookVersion });
  const out: FullConfirmationAccounting = { stage: "full-confirm", total: positives.length, accounted: 0, cached: 0, attempted: 0, valid: 0, failed: 0, stopped: 0, remaining: positives.length, awaitingGold: awaitingGold.length, confirmed: 0, rejected: 0, downgraded: 0, flagged: positives.filter(p => p.spans.some(s => p.flaggedSpanIds?.includes(s.id))).length, excludedA3: o.entries.length - entries.length, reason: null, ok: false, complete: false };
  const confirmerId = `agent:ollama:${canonicalModel(o.model)}:thinking-${o.reasoning ? "on" : "off"}`;
  try {
    if (awaitingGold.length) throw new Error("gold-lock-incomplete");
    for (const selected of spike.selected) {
      const current = positives.find(p => p.projectN === selected.projectN && p.checkId === selected.checkId);
      const reviewed = spike.decisions.find(p => p.projectN === selected.projectN && p.checkId === selected.checkId);
      if (!current || inputDigest(o.codebook, current) !== selected.digest ||
          JSON.stringify(current.spans) !== JSON.stringify(reviewed?.spans) ||
          JSON.stringify((current.flaggedSpanIds ?? []).filter(id => current.spans.some(s => s.id === id))) !== JSON.stringify(reviewed?.flaggedSpanIds ?? []))
        throw new Error("reviewed-spike-inputs-stale");
    }
    const checkRows = await o.db.selectFrom("pipeline_check_states").select(["project_n", "check_id"]).where("project_n", "in", entries.map(e => e.n)).execute();
    if (entries.some(e => Object.keys(o.codebook.checks).some(id => !checkRows.some(r => r.project_n === e.n && r.check_id === id)))) throw new Error("primary-check-states-incomplete");
    const edits = await effectiveStates(o.db, entries.map(e => e.n));
    const actorBase = `agent:ollama:${canonicalModel(o.model)}`;
    if (edits.some(e => (e.editActorId === actorBase || e.editActorId?.startsWith(`${actorBase}:`)) && positives.some(p => p.projectN === e.projectN && p.checkId === e.checkId))) throw new Error("confirmer-cannot-confirm-own-edit");
    const originalByN = new Map<number, Map<string, string>>();
    for (const p of positives) {
      if (!originalByN.has(p.projectN)) originalByN.set(p.projectN, new Map(projectSpans(o.dataDir, p.projectN).map(s => [s.id, s.text])));
      const original = originalByN.get(p.projectN)!;
      if (!p.spans.length || p.spans.some(s => !s.text || original.get(s.id) !== s.text)) throw new Error("positive-citation-unresolved");
    }
    const decisions = await o.db.selectFrom("pipeline_confirmations").select(["project_n", "check_id", "input_digest", "decision", "reason", "confirmed_state", "span_ids_json"]).where("confirmer_id", "=", confirmerId).execute();
    const statuses = confirmationStatus(positives, decisions, o.codebook).sort((a, b) => order.get(byN.get(a.positive.projectN)!)! - order.get(byN.get(b.positive.projectN)!)! || a.positive.checkId.localeCompare(b.positive.checkId));
    for (const s of statuses) {
      const p = s.positive;
      const previous = decisions.find(r => r.project_n === p.projectN && r.check_id === p.checkId && r.input_digest === s.digest);
      if (previous && validCachedDecision(previous, p)) {
        out.cached++; out.valid++; out.accounted++; out[previous.decision as "confirmed" | "rejected" | "downgraded"]++;
        continue;
      }
      out.attempted++;
      try {
        const result = await confirmWithModel(o.client, o.codebook, p, o.model, 3, o.reasoning);
        await recordConfirmation(o.db, { projectN: p.projectN, checkId: p.checkId, decision: result.decision, confirmedState: confirmedStateFor(result.decision, p.state), reason: result.reason, confirmerId, confirmerKind: "agent", modelId: o.model, decidedAt: new Date().toISOString(), inputDigest: s.digest, spanIds: p.spans.map(span => span.id) });
        out.valid++; out.accounted++; out[result.decision]++;
        log(`CONFIRMATION: ${JSON.stringify({ stage: out.stage, projectN: p.projectN, checkId: p.checkId, decision: result.decision, valid: out.valid, total: out.total })}`);
      } catch (error) {
        const name = (error as Error).name;
        out.reason = name;
        if (!["BudgetExceededError", "QuotaStop", "TooLargeError", "ReservationExceededError"].includes(name)) { out.failed++; out.accounted++; }
        break;
      }
    }
  } catch (error) { out.reason = (error as Error).message; }
  out.remaining = out.total - out.valid;
  out.stopped = Math.max(0, out.total - out.accounted);
  out.ok = !out.reason && !out.failed && !out.awaitingGold && out.valid === out.total;
  out.complete = out.ok;
  log(o.client.dollarBudget.budgetLine());
  log(`CONFIRMATION: ${JSON.stringify(out)}`);
  log(`ACCOUNTING: ${JSON.stringify(out)}`);
  return out;
}
