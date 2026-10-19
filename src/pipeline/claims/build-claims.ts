// COD-04: build the 5 claim.json records for one project and gate every one
// of them. Reads vendor/ai-output-to-value/schemas/v1/decision-gates.json
// directly (not via coding/contract.ts's flattened loadGateFile(), which
// loses the per-decision requiredChecks grouping this module needs).

import fs from "node:fs";
import path from "node:path";

import type { CheckEntry, ProposedState } from "../coding/contract.ts";
import type { GateResult } from "../gate/run-gate.ts";

const DECISION_IDS = ["explore", "rely", "operate", "measure-outcome", "scale-renew-stop"] as const;
export type DecisionId = (typeof DECISION_IDS)[number];

export interface ClaimRecord {
  schemaVersion: "1.0";
  project: string;
  targetDecision: DecisionId;
  requiredClaimLevel: string;
  assertedClaimLevel: string;
  intendedUse: string;
  actors: { type: string; role: string; interactionChannel?: string }[];
  authority: string;
  accountability: string;
  evidenceCharacter: string[];
  evidenceRefs: string[];
  gateChecks: Record<string, "pass" | "fail" | "unknown" | "not-applicable">;
  nextEvidence: string;
  stopRule: string;
}

export interface DecisionGateCheck {
  id: string;
  label: string;
}

export interface DecisionGateRule {
  label: string;
  requiredClaimLevel: string;
  description?: string;
  requiredChecks: DecisionGateCheck[];
}

export interface DecisionGatesFile {
  decisions: Record<string, DecisionGateRule>;
}

/**
 * The six generic text fields shared by every claim record for this project,
 * independent of which decision it targets.
 */
export function templateFields(
  project: string,
  decisionLabel: string,
): Pick<ClaimRecord, "project" | "intendedUse" | "actors" | "authority" | "accountability" | "nextEvidence" | "stopRule"> {
  return {
    project,
    intendedUse: `Code the AI readiness evidence for "${decisionLabel}" against the PRISM codebook v1.0, from ${project}'s own publicly reachable pages and repository.`,
    actors: [
      { type: "ai-agent", role: "Evidence coder (primary and second coder on Nebius Token Factory)", interactionChannel: "api" },
      { type: "deterministic-system", role: "Quote-or-unknown filter and claim gate", interactionChannel: "api" },
    ],
    authority: "PRISM review protocol v1 (protocol/PROTOCOL.md), within the pre-registered inclusion rules and disclosure controls.",
    accountability: "PRISM's sign-off reviewer role (protocol addendum A6); every pass/claimed state is confirmed by a confirmer that did not code it before publication (A2).",
    nextEvidence: "The Phase 4 blind-label and second-model validation of codebook v1.0.",
    stopRule: "Stop and withhold the affected estimate if the Phase 4 pre-registered validation threshold for this check is missed and no corrective action has been applied (protocol section 4, VAL-07).",
  };
}

/**
 * claim.schema.json's gateChecks enum has no "claimed" value: a claimed
 * proposedState projects to unknown before it reaches gateChecks. Every other
 * state passes through unchanged.
 */
export function projectToGateState(state: ProposedState): "pass" | "fail" | "unknown" | "not-applicable" {
  if (state === "claimed") return "unknown";
  return state;
}

function loadDecisionGates(gatesPath: string): DecisionGatesFile {
  return JSON.parse(fs.readFileSync(gatesPath, "utf8"));
}

export type RunGateFn = (record: ClaimRecord) => Promise<GateResult>;

/**
 * Build and gate the 5 claim.json records for one project. rely is built and
 * gated FIRST; operate's deliverable-gate-passed check is then overridden
 * from rely's gate result (the only one of the 24 checks ever overridden
 * from a non-Nemotron source). explore, measure-outcome and scale-renew-stop
 * build in any order after rely.
 */
export async function buildClaimsForProject({
  project,
  filteredStates,
  spanUrls = {},
  runGate,
  gatesPath,
  repoRoot = process.cwd(),
}: {
  project: string;
  filteredStates: CheckEntry[];
  spanUrls?: Record<string, string>;
  runGate: RunGateFn;
  gatesPath?: string;
  repoRoot?: string;
}): Promise<Record<DecisionId, { record: ClaimRecord; gateResult: GateResult }>> {
  const resolvedGatesPath = gatesPath ?? path.join(repoRoot, "vendor", "ai-output-to-value", "schemas", "v1", "decision-gates.json");
  const gates = loadDecisionGates(resolvedGatesPath);
  const byCheckId = new Map(filteredStates.map((c) => [c.checkId, c]));

  function buildRecord(decisionId: DecisionId): ClaimRecord {
    const decision = gates.decisions[decisionId];
    const fields = templateFields(project, decision.label);
    const gateChecks: ClaimRecord["gateChecks"] = {};
    const refs = new Set<string>();
    for (const check of decision.requiredChecks) {
      const state = byCheckId.get(check.id);
      const proposedState: ProposedState = state?.proposedState ?? "unknown";
      gateChecks[check.id] = projectToGateState(proposedState);
      if (state && (proposedState === "pass" || proposedState === "claimed")) {
        for (const spanId of state.spanIds) {
          const url = spanUrls[spanId];
          if (url) refs.add(`${url}#${spanId}`);
        }
      }
    }
    return {
      schemaVersion: "1.0",
      targetDecision: decisionId,
      requiredClaimLevel: decision.requiredClaimLevel,
      assertedClaimLevel: decision.requiredClaimLevel,
      evidenceCharacter: ["public-measured"],
      evidenceRefs: [...refs],
      gateChecks,
      ...fields,
    };
  }

  const relyRecord = buildRecord("rely");
  const relyGateResult = await runGate(relyRecord);

  const operateRecord = buildRecord("operate");
  operateRecord.gateChecks["deliverable-gate-passed"] =
    relyGateResult.status === "PASS" ? "pass" : relyGateResult.status === "BLOCKED" ? "fail" : "not-applicable";
  const operateGateResult = await runGate(operateRecord);

  const rest: { id: DecisionId; record: ClaimRecord; gateResult: GateResult }[] = [];
  for (const id of ["explore", "measure-outcome", "scale-renew-stop"] as const) {
    const record = buildRecord(id);
    const gateResult = await runGate(record);
    rest.push({ id, record, gateResult });
  }

  const out = {
    rely: { record: relyRecord, gateResult: relyGateResult },
    operate: { record: operateRecord, gateResult: operateGateResult },
  } as Record<DecisionId, { record: ClaimRecord; gateResult: GateResult }>;
  for (const r of rest) out[r.id] = { record: r.record, gateResult: r.gateResult };
  return out;
}
