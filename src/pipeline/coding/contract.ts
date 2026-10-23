// The output contract for Nemotron coding (COD-01). Promoted unchanged from
// scripts/spikes/lib/contract.mjs (FND-05, D-15): exactly
// {checkId, proposedState, spanIds} per check, for the 24 check ids read at
// run time from the vendored gate JSON — never typed by hand. The gate
// file's sha256 is recorded alongside the extracted ids so the record can be
// re-derived.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

export const VENDORED_GATES_PATH = "vendor/ai-output-to-value/schemas/v1/decision-gates.json";
// Identical file on main and the fix branch (plan 01-10 read_first).
export const SIBLING_GATES_PATH = "/Users/helen/workspace/alreadyopen/repositories/ai-output-to-value/schemas/v1/decision-gates.json";

export const PROPOSED_STATES = ["pass", "fail", "unknown", "claimed"] as const;
export type ProposedState = (typeof PROPOSED_STATES)[number];

export interface CheckEntry {
  checkId: string;
  proposedState: ProposedState;
  spanIds: string[];
}

export interface CodingReply {
  checks: CheckEntry[];
}

export interface GateFile {
  path: string;
  sha256: string;
  checkIds: string[];
  checkLabels: Record<string, string>;
}

/** `--gates <path>` if given, else the vendored path if it exists, else the sibling checkout. */
export function resolveGatesPath(explicit?: string, repoRoot: string = process.cwd()): string {
  if (explicit) return path.resolve(explicit);
  const vendored = path.join(repoRoot, VENDORED_GATES_PATH);
  if (fs.existsSync(vendored)) return vendored;
  return SIBLING_GATES_PATH;
}

/**
 * Read the gate JSON, record its sha256, and extract the check ids (and their
 * labels) across all five decisions, in file order, deduplicated. Returns
 * { path, sha256, checkIds, checkLabels }.
 */
export function loadGateFile(gatesPath: string): GateFile {
  const raw = fs.readFileSync(gatesPath, "utf8");
  const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
  const json = JSON.parse(raw);
  const checkIds: string[] = [];
  const checkLabels: Record<string, string> = {};
  const seen = new Set<string>();
  for (const decision of Object.values(json.decisions ?? {}) as any[]) {
    for (const check of decision.requiredChecks ?? []) {
      if (typeof check?.id === "string" && !seen.has(check.id)) {
        seen.add(check.id);
        checkIds.push(check.id);
        checkLabels[check.id] = typeof check.label === "string" ? check.label : check.id;
      }
    }
  }
  return { path: gatesPath, sha256, checkIds, checkLabels };
}

function checkEntrySchema(checkIds: string[]) {
  return z
    .object({
      checkId: z.enum(checkIds as [string, ...string[]]),
      proposedState: z.enum(PROPOSED_STATES),
      spanIds: z.array(z.string()),
    })
    .strict();
}

/**
 * Build the zod contract (exactly `checkIds.length` strict entries, unique
 * checkIds) and its JSON Schema (for the response_format payload) from the
 * ids read from the gate file.
 */
export function buildContract(checkIds: string[]) {
  const Entry = checkEntrySchema(checkIds);
  const Shape = z.object({ checks: z.array(Entry).length(checkIds.length) }).strict();
  const zodSchema = Shape.refine((v) => new Set(v.checks.map((c) => c.checkId)).size === v.checks.length, {
    message: "duplicate checkId",
  });
  // The model is asked for `checks` keyed by check id, every id required: under constrained decoding
  // that rules out the duplicated and dropped checks a free-form array allowed (measured on the
  // 20-project pilot). isSchemaValid converts the keyed reply back to the array form above.
  const Keyed = z
    .object({
      checks: z
        .object(Object.fromEntries(checkIds.map((id) => [id, z.object({ proposedState: z.enum(PROPOSED_STATES), spanIds: z.array(z.string()) }).strict()])))
        .strict(),
    })
    .strict();
  const jsonSchema: any = z.toJSONSchema(Keyed);
  delete jsonSchema.$schema; // response_format wants a plain JSON Schema object, not a meta-schema pointer
  return { checkIds, zodSchema, jsonSchema };
}

/**
 * True when every span id cited anywhere in `reply.checks[].spanIds` is
 * present in `spanIds` (the page's own span list). A malformed shape (missing
 * checks array, a non-array spanIds) is treated as not resolving.
 */
export function resolveSpans(reply: unknown, spanIds: string[]): boolean {
  if (!reply || typeof reply !== "object" || !Array.isArray((reply as any).checks)) return false;
  const known = new Set(spanIds);
  for (const check of (reply as CodingReply).checks) {
    if (!Array.isArray(check.spanIds)) return false;
    for (const sid of check.spanIds) {
      if (!known.has(sid)) return false;
    }
  }
  return true;
}

export interface SchemaValidResult {
  valid: boolean;
  stage: "json_parse" | "zod" | "span_resolve" | "ok";
  data?: CodingReply;
}

/** Constrain an existing citation rule without weakening any check or the strict resolver. */
export function citationSchema(schema: unknown, spanIds: string[]) {
  const out: any = structuredClone(schema);
  out.$defs = { ...(out.$defs ?? {}), citedSpanId: { type: "string", enum: spanIds } };
  for (const entry of Object.values(out.properties.checks.properties) as any[]) entry.properties.spanIds.items = { $ref: "#/$defs/citedSpanId" };
  return out;
}

/**
 * The single definition of schema-valid (FND-05, D-15): JSON parses, the zod
 * contract holds, and every returned span id resolves to a span in the page.
 * Returns { valid, stage, data? } where `stage` names the first failure
 * ("json_parse", "zod" or "span_resolve") or "ok" when every stage passed.
 */
export function isSchemaValid(rawText: string, spanIds: string[], zodSchema: z.ZodType): SchemaValidResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { valid: false, stage: "json_parse" };
  }
  const checks = (parsed as any)?.checks;
  if (checks && typeof checks === "object" && !Array.isArray(checks)) {
    parsed = { ...(parsed as object), checks: Object.entries(checks).map(([checkId, v]) => ({ checkId, ...(v as object) })) };
  }
  const result = zodSchema.safeParse(parsed);
  if (!result.success) return { valid: false, stage: "zod" };
  if (!resolveSpans(result.data, spanIds)) return { valid: false, stage: "span_resolve" };
  return { valid: true, stage: "ok", data: result.data as CodingReply };
}
