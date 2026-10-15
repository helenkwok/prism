// D-28's 3-attempt retry-to-unknown policy for Nemotron coding (COD-01
// robustness). Extends the 1-retry `processPage` pattern in
// scripts/spikes/nebius-matrix.mjs (lines ~210-223) to maxAttempts=3 total
// attempts; when every attempt is schema-invalid, every real check id (read
// live from contract.checkIds, which itself comes from loadGateFile()'s
// live read of the vendored gate file — never hand-typed or hardcoded to a
// fixture count) is recorded at proposedState "unknown" with an empty
// spanIds array, so the coding stage never stalls the caller's pipeline on
// a schema-invalid reply.

import type { z } from "zod";

import { isSchemaValid } from "./contract.ts";
import type { CheckEntry, SchemaValidResult } from "./contract.ts";

/**
 * `callOnce(client, cfg, jsonSchema, checkIds, spanIds)` -> the raw Nebius
 * response text for one coding attempt (the same shape
 * scripts/spikes/nebius-matrix.mjs's callOnce already produces, reduced
 * here to just the text isSchemaValid() needs).
 */
export type CallOnce = (client: unknown, cfg: unknown, jsonSchema: unknown, checkIds: string[], spanIds: string[]) => Promise<string>;

export interface RetryContract {
  jsonSchema: unknown;
  checkIds: string[];
  zodSchema: z.ZodType;
}

export interface AllUnknownResult {
  valid: false;
  attempts: number;
  allUnknown: true;
  checks: CheckEntry[];
}

export type RetryResult = (SchemaValidResult & { attempts: number }) | AllUnknownResult;

/** Every checkId at proposedState "unknown" with no spans — the D-28 fallback. */
export function allUnknownChecks(checkIds: string[]): CheckEntry[] {
  return checkIds.map((checkId) => ({ checkId, proposedState: "unknown", spanIds: [] }));
}

/**
 * Calls `callOnce` up to `maxAttempts` times (default 3), accepting the
 * first schema-valid reply. Never throws past this function: when every
 * attempt is invalid, resolves with the D-28 all-unknown fallback instead —
 * the caller (plan 02-07's orchestrator) treats that as this project's
 * coding-stage output, not as a pipeline failure.
 */
export async function codeProjectWithRetry({
  client,
  cfg,
  contract,
  spanIds,
  callOnce,
  maxAttempts = 3,
}: {
  client: unknown;
  cfg: unknown;
  contract: RetryContract;
  spanIds: string[];
  callOnce: CallOnce;
  maxAttempts?: number;
}): Promise<RetryResult> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const rawText = await callOnce(client, cfg, contract.jsonSchema, contract.checkIds, spanIds);
    const evalResult = isSchemaValid(rawText, spanIds, contract.zodSchema);
    if (evalResult.valid) {
      return { ...evalResult, attempts: attempt };
    }
  }
  return { valid: false, attempts: maxAttempts, allUnknown: true, checks: allUnknownChecks(contract.checkIds) };
}
