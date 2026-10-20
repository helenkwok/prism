// VAL-01 / D-46: gold labeller through the coding path; insert-only locked rows (D-53).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Kysely } from "kysely";

import { withStageCache } from "../cache/stage-cache.ts";
import type { Codebook } from "../coding/codebook-prompt.ts";
import { applyQuoteOrUnknownFilter } from "../coding/filter.ts";
import { buildChatBody, isQuotaResponse, QuotaStop } from "../coding/nebius-client.ts";
import { codeProjectWithRetry, type CallOnce, type RetryContract } from "../coding/retry.ts";
import { projectSpans, spansDigest } from "../confirm/confirm.ts";
import { buildCodingMessages, chunkSpans, CODING_MAX_TOKENS, mergeChunkCodings } from "../run.ts";
import { assertIndependent, type RoleName, type RoleSpec } from "./providers.ts";

export async function ensureGoldSchema(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("pipeline_gold_labels")
    .ifNotExists()
    .addColumn("project_n", "integer")
    .addColumn("check_id", "text")
    .addColumn("codebook_version", "text")
    .addColumn("labeller_id", "text")
    .addColumn("labeller_kind", "text")
    .addColumn("provider", "text")
    .addColumn("model_id", "text")
    .addColumn("reasoning", "text")
    .addColumn("raw_state", "text")
    .addColumn("filtered_state", "text")
    .addColumn("span_ids_json", "text")
    .addColumn("input_digest", "text")
    .addColumn("labelled_at", "text")
    .addPrimaryKeyConstraint("pipeline_gold_labels_pk", [
      "project_n",
      "check_id",
      "codebook_version",
      "labeller_id",
      "input_digest",
    ])
    .execute();
  await db.schema
    .createTable("pipeline_gold_outcomes")
    .ifNotExists()
    .addColumn("project_n", "integer")
    .addColumn("codebook_version", "text")
    .addColumn("labeller_id", "text")
    .addColumn("input_digest", "text")
    .addColumn("outcome", "text")
    .addColumn("reason", "text")
    .addColumn("decided_at", "text")
    .addPrimaryKeyConstraint("pipeline_gold_outcomes_pk", [
      "project_n",
      "codebook_version",
      "labeller_id",
      "input_digest",
    ])
    .execute();
}

function labellerId(role: RoleSpec): string {
  return `agent:${role.provider}:${role.model}`;
}

function reasoningStored(role: RoleSpec): string {
  return typeof role.reasoning === "boolean" ? String(role.reasoning) : role.reasoning;
}

function makeGoldCallOnce(
  codebook: Codebook,
  spansById: Map<string, string>,
  role: RoleSpec,
  client: { request: (p: string, init: { method: string; body: unknown }) => Promise<{ ok: boolean; status: number; json: unknown; text?: string }> },
  cacheDir: string,
  hnId: string,
): CallOnce {
  return async (_client, _cfg, jsonSchema, checkIds, spanIds) => {
    const spans = spanIds.map((id) => ({ id, text: spansById.get(id) ?? "" }));
    const messages = buildCodingMessages(checkIds, codebook, jsonSchema, spans);
    const body = buildChatBody({
      model: role.model,
      messages,
      mode: "json_schema",
      schema: { name: "gate_checks", schema: jsonSchema, strict: true },
      thinking: false,
      ...(typeof role.reasoning === "string" ? { reasoningEffort: role.reasoning } : {}),
      maxTokens: CODING_MAX_TOKENS,
    });
    const requestHash = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const { value } = await withStageCache(
      cacheDir,
      hnId,
      "gold",
      { provider: role.provider, model: role.model, reasoning: role.reasoning, requestHash },
      async () => {
        const res = await client.request("/chat/completions", { method: "POST", body });
        if (isQuotaResponse(res)) throw new QuotaStop(res.status, `quota stop status ${res.status}`);
        if (!res.ok) throw new Error(`gold chat returned status ${res.status}`);
        const content = (res.json as any)?.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new Error("gold response missing content");
        return content;
      },
    );
    return value;
  };
}

export type GoldOutcome = {
  project_n: number;
  codebook_version: string;
  labeller_id: string;
  input_digest: string;
  outcome: "labelled" | "no-gold" | "excluded-a3";
  reason: string | null;
  decided_at: string;
};

export async function labelProject({
  db,
  dataDir,
  cacheDir,
  projectN,
  hnId,
  codebook,
  codebookVersion,
  contract,
  role,
  client,
}: {
  db: Kysely<any>;
  dataDir: string;
  cacheDir: string;
  projectN: number;
  hnId: string;
  codebook: Codebook;
  codebookVersion: string;
  contract: RetryContract;
  role: RoleSpec;
  client: { request: (p: string, init: { method: string; body: unknown }) => Promise<{ ok: boolean; status: number; json: unknown; text?: string }> };
}): Promise<GoldOutcome> {
  assertIndependent("gold", role.model);
  await ensureGoldSchema(db);
  const spans = projectSpans(dataDir, projectN);
  const digest = spansDigest(spans);
  const lid = labellerId(role);

  const existing = await db
    .selectFrom("pipeline_gold_outcomes")
    .selectAll()
    .where("project_n", "=", projectN)
    .where("codebook_version", "=", codebookVersion)
    .where("labeller_id", "=", lid)
    .where("input_digest", "=", digest)
    .executeTakeFirst();
  if (existing) return existing as GoldOutcome;

  const spansById = new Map(spans.map((s) => [s.id, s.text]));
  const chunks = chunkSpans(spans);
  const callOnce = makeGoldCallOnce(codebook, spansById, role, client, cacheDir, hnId);
  const perChunk = [];
  for (const chunk of chunks) {
    const result = await codeProjectWithRetry({
      client,
      cfg: {},
      contract,
      spanIds: chunk.map((s) => s.id),
      callOnce,
    });
    if (!result.valid || (result as any).allUnknown) {
      const decidedAt = new Date().toISOString();
      const outcome: GoldOutcome = {
        project_n: projectN,
        codebook_version: codebookVersion,
        labeller_id: lid,
        input_digest: digest,
        outcome: "no-gold",
        reason: "retry-exhausted",
        decided_at: decidedAt,
      };
      await db
        .insertInto("pipeline_gold_outcomes")
        .values(outcome)
        .execute();
      return outcome;
    }
    perChunk.push(result.data!.checks);
  }

  const merged = mergeChunkCodings(contract.checkIds, perChunk);
  const filtered = applyQuoteOrUnknownFilter(
    merged,
    spans.map((s) => s.id),
  );
  const decidedAt = new Date().toISOString();
  const reasoning = reasoningStored(role);

  await db.transaction().execute(async (trx) => {
    for (const check of filtered) {
      const raw = merged.find((c) => c.checkId === check.checkId)!;
      await trx
        .insertInto("pipeline_gold_labels")
        .values({
          project_n: projectN,
          check_id: check.checkId,
          codebook_version: codebookVersion,
          labeller_id: lid,
          labeller_kind: "agent",
          provider: role.provider,
          model_id: role.model,
          reasoning,
          raw_state: raw.proposedState,
          filtered_state: check.proposedState,
          span_ids_json: JSON.stringify(check.spanIds),
          input_digest: digest,
          labelled_at: decidedAt,
        })
        .execute();
    }
    await trx
      .insertInto("pipeline_gold_outcomes")
      .values({
        project_n: projectN,
        codebook_version: codebookVersion,
        labeller_id: lid,
        input_digest: digest,
        outcome: "labelled",
        reason: null,
        decided_at: decidedAt,
      })
      .execute();
  });

  return {
    project_n: projectN,
    codebook_version: codebookVersion,
    labeller_id: lid,
    input_digest: digest,
    outcome: "labelled",
    reason: null,
    decided_at: decidedAt,
  };
}

/** A7 item names — must match PROTOCOL.md ### headings and sign-off --item values. */
export const A7_ITEMS = [
  "A7.1 Gold labels on all 300",
  "A7.2 Labeller and auditor configuration",
  "A7.3 Rendered text as own-source evidence",
  "A7.4 Shortfall step 1",
  "A7.5 Shortfall step 2",
  "A7.6 Confirmer downgrade",
  "A7.7 Injection-flagged projects",
  "A7.8 Published state",
  "A7.9 Agreement details",
  "A7.10 Screening audit",
  "A7.11 Collection recall",
  "A7.12 Strata and N",
] as const;

export function a7Section(protocolText: string): string {
  const lines = protocolText.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^## Addendum .+ \(A7\)\s*$/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## Addendum /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export async function a7Signed({
  protocolPath,
  signoffPath,
}: {
  protocolPath: string;
  signoffPath: string;
}): Promise<boolean> {
  const section = a7Section(fs.readFileSync(protocolPath, "utf8"));
  if (!section) return false;
  const digest = crypto.createHash("sha256").update(section).digest("hex");
  if (!fs.existsSync(signoffPath)) return false;
  const records = fs
    .readFileSync(signoffPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  for (const name of A7_ITEMS) {
    const forItem = records.filter((r) => r.item === name && r.docDigest === digest);
    if (forItem.some((r) => r.decision === "rejected")) return false;
    if (!forItem.some((r) => r.decision === "approved")) return false;
  }
  return true;
}
