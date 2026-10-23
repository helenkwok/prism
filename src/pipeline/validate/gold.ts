// VAL-01 / D-46: gold labeller through the coding path; insert-only locked rows (D-53).
// CLI: node src/pipeline/validate/gold.ts [--projects path] [--limit n] [--concurrency n]

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Kysely } from "kysely";
import pLimit from "p-limit";

import { readCached, stageCacheKey, withStageCache } from "../cache/stage-cache.ts";
import type { Codebook } from "../coding/codebook-prompt.ts";
import { applyQuoteOrUnknownFilter } from "../coding/filter.ts";
import { buildChatBody, isQuotaResponse, QuotaStop } from "../coding/nebius-client.ts";
import { allUnknownChecks, codeProjectWithRetry, type CallOnce, type RetryContract } from "../coding/retry.ts";
import { projectSpans, spansDigest } from "../confirm/confirm.ts";
import { ARTCRAFT_HN_ID, GOLD_SEED } from "../select/draw-sample.ts";
import { sortPilotCandidates } from "../select/pilot-draw.ts";
import { buildCodingMessages, chunkSpans, CODING_MAX_TOKENS, mergeChunkCodings } from "../run.ts";
import { buildContract, citationSchema, isSchemaValid } from "../coding/contract.ts";
import { uniqueProjectSpans } from "../coding/span-packing.ts";
import { readRepairIndex, recordRepairMetadata } from "../coding/repair-index.ts";
import { assertIndependent, ROLE_CONFIG, roleClient, type RoleSpec } from "./providers.ts";

const DEFAULT_CONCURRENCY = 4;
export const GOLD_ATTEMPT_REVISION = "format-feedback-v1";

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
    .addColumn("attempt_revision", "text")
    .addPrimaryKeyConstraint("pipeline_gold_outcomes_pk", [
      "project_n",
      "codebook_version",
      "labeller_id",
      "input_digest",
    ])
    .execute();
  const outcomes = (await db.introspection.getTables()).find(t => t.name === "pipeline_gold_outcomes");
  if (!outcomes?.columns.some(c => c.name === "attempt_revision")) {
    try { await db.schema.alterTable("pipeline_gold_outcomes").addColumn("attempt_revision", "text").execute(); }
    catch (error) {
      const current = (await db.introspection.getTables()).find(t => t.name === "pipeline_gold_outcomes");
      if (!current?.columns.some(c => c.name === "attempt_revision")) throw error;
    }
  }
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
  dataDir: string,
  projectN: number,
): CallOnce {
  const diagnosticsPath = path.join(dataDir, "validation", "coding-invalid-replies.jsonl");
  const failures = new Map(Object.values(readRepairIndex(dataDir)).filter(row => row.stage === "gold").map(row => [row.baseDigest, row.lastValidationStage]));
  const attempts = new Map<string, number>();
  return async (_client, _cfg, jsonSchema, checkIds, spanIds) => {
    const spans = spanIds.map((id) => ({ id, text: spansById.get(id) ?? "" }));
    const makeBody = (schema: unknown, feedback?: string) => buildChatBody({
      model: role.model,
      messages: buildCodingMessages(checkIds, codebook, schema, spans).map((message, i) => i === 0 && feedback ? { ...message, content: `${message.content}\n\nFormat correction (${GOLD_ATTEMPT_REVISION}): ${feedback}` } : message),
      mode: "json_schema",
      schema: { name: "gate_checks", schema, strict: true },
      thinking: false,
      ...(typeof role.reasoning === "string" ? { reasoningEffort: role.reasoning } : {}),
      maxTokens: CODING_MAX_TOKENS,
    });
    let body = makeBody(jsonSchema);
    const baseDigest = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const baseCache = readCached<string>(cacheDir, stageCacheKey(hnId, "gold-valid-chunk", { provider: role.provider, model: role.model, reasoning: role.reasoning, requestHash: baseDigest }));
    if (baseCache.hit && isSchemaValid(baseCache.value, spanIds, buildContract(checkIds).zodSchema).valid) return baseCache.value;
    const failure = failures.get(baseDigest);
    // Cloud schemas are advisory; local validation is strict and retry feedback is trusted text.
    if (failure === "json_parse") body = makeBody(jsonSchema, "Return exactly one valid JSON object, with no prose, markdown fences or text outside the object. Do not omit any required check.");
    if (failure === "zod") body = makeBody(jsonSchema, `Return exactly the required checks object keyed by all ${checkIds.length} ids: ${checkIds.join(", ")}. Each check contains only proposedState (pass, fail, unknown or claimed) and spanIds (an array of strings, empty when unsupported). Do not add, rename or omit keys. Match the supplied schema exactly; no prose or fences.`);
    if (failure === "span_resolve") body = makeBody(citationSchema(jsonSchema, spanIds), `Your previous citations did not resolve. Cite only these exact span ids: ${JSON.stringify(spanIds)}. Never invent, alias or shorten an id. Use an empty spanIds array when no listed span supports the state. Return every required check.`);
    const requestHash = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const { value } = await withStageCache(
      cacheDir,
      hnId,
      "gold-valid-chunk",
      { provider: role.provider, model: role.model, reasoning: role.reasoning, requestHash },
      async () => {
        const res = await client.request("/chat/completions", { method: "POST", body });
        if (isQuotaResponse(res)) throw new QuotaStop(res.status, `quota stop status ${res.status}`);
        if (!res.ok) throw new Error(`gold chat returned status ${res.status}`);
        const content = (res.json as any)?.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new Error("gold response missing content");
        const validation = isSchemaValid(content, spanIds, buildContract(checkIds).zodSchema);
        const attempt = (attempts.get(baseDigest) ?? 0) + 1; attempts.set(baseDigest, attempt);
        process.stdout.write(`GOLD_VALIDATION: ${JSON.stringify({ projectN, validationStage: validation.stage, attempt, count: 1 })}\n`);
        if (!validation.valid) {
          if (validation.stage === "ok") throw new Error("invalid gold validation stage");
          failures.set(baseDigest, validation.stage);
          fs.mkdirSync(path.dirname(diagnosticsPath), { recursive: true, mode: 0o700 });
          fs.appendFileSync(diagnosticsPath, JSON.stringify({ stage: "gold", projectN, attemptRevision: GOLD_ATTEMPT_REVISION, baseDigest, requestDigest: requestHash, validationStage: validation.stage, finishReason: (res.json as any)?.choices?.[0]?.finish_reason ?? null, content, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
          recordRepairMetadata(dataDir, { baseDigest, lastValidationStage: validation.stage, model: role.model, stage: "gold" });
        }
        return content;
      },
      (content) => isSchemaValid(content, spanIds, buildContract(checkIds).zodSchema).valid,
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
  attempt_revision?: string | null;
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
  if (existing && (existing.outcome !== "no-gold" || existing.attempt_revision === GOLD_ATTEMPT_REVISION)) return existing as GoldOutcome;
  if (existing) {
    const historyPath = path.join(dataDir, "validation", "gold-attempt-history.jsonl");
    fs.mkdirSync(path.dirname(historyPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(historyPath, JSON.stringify({ previousOutcome: existing, retryRevision: GOLD_ATTEMPT_REVISION, retainedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
  }

  const spansById = new Map(spans.map((s) => [s.id, s.text]));
  const chunks = chunkSpans(uniqueProjectSpans(spans));
  const callOnce = makeGoldCallOnce(codebook, spansById, role, client, cacheDir, hnId, dataDir, projectN);
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
        attempt_revision: GOLD_ATTEMPT_REVISION,
      };
      await db
        .insertInto("pipeline_gold_outcomes")
        .values(outcome)
        .onConflict(oc => oc.columns(["project_n", "codebook_version", "labeller_id", "input_digest"]).doUpdateSet({ outcome: outcome.outcome, reason: outcome.reason, decided_at: decidedAt, attempt_revision: GOLD_ATTEMPT_REVISION }))
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
        attempt_revision: GOLD_ATTEMPT_REVISION,
      })
      .onConflict(oc => oc.columns(["project_n", "codebook_version", "labeller_id", "input_digest"]).doUpdateSet({ outcome: "labelled", reason: null, decided_at: decidedAt, attempt_revision: GOLD_ATTEMPT_REVISION }))
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
    attempt_revision: GOLD_ATTEMPT_REVISION,
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

type SampleEntry = { n: number; hn_id: string };

function parseGoldArgs(argv: string[]) {
  const out: { projects?: string; limit?: number; concurrency: number } = { concurrency: DEFAULT_CONCURRENCY };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--projects" && argv[i + 1]) out.projects = argv[++i];
    else if (argv[i] === "--limit" && argv[i + 1]) out.limit = Number(argv[++i]);
    else if (argv[i] === "--concurrency" && argv[i + 1]) out.concurrency = Number(argv[++i]);
  }
  return out;
}

async function writeNoSpansLabels({
  db,
  projectN,
  codebookVersion,
  role,
  digest,
  checkIds,
}: {
  db: Kysely<any>;
  projectN: number;
  codebookVersion: string;
  role: RoleSpec;
  digest: string;
  checkIds: string[];
}): Promise<GoldOutcome> {
  const lid = labellerId(role);
  const decidedAt = new Date().toISOString();
  const reasoning = reasoningStored(role);
  const checks = allUnknownChecks(checkIds);
  await db.transaction().execute(async (trx) => {
    for (const check of checks) {
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
          raw_state: "unknown",
          filtered_state: "unknown",
          span_ids_json: "[]",
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
        reason: "no-spans",
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
    reason: "no-spans",
    decided_at: decidedAt,
  };
}

export async function writeExcludedA3({
  db,
  projectN,
  codebookVersion,
  role,
  digest,
}: {
  db: Kysely<any>;
  projectN: number;
  codebookVersion: string;
  role: RoleSpec;
  digest: string;
}): Promise<GoldOutcome> {
  const lid = labellerId(role);
  const decidedAt = new Date().toISOString();
  const outcome: GoldOutcome = {
    project_n: projectN,
    codebook_version: codebookVersion,
    labeller_id: lid,
    input_digest: digest,
    outcome: "excluded-a3",
    reason: "artcraft",
    decided_at: decidedAt,
  };
  await db.insertInto("pipeline_gold_outcomes").values(outcome).onConflict((oc) => oc.doNothing()).execute();
  return outcome;
}

async function findOutcome(
  db: Kysely<any>,
  projectN: number,
  codebookVersion: string,
  role: RoleSpec,
  digest: string,
): Promise<GoldOutcome | undefined> {
  const row = await db
    .selectFrom("pipeline_gold_outcomes")
    .selectAll()
    .where("project_n", "=", projectN)
    .where("codebook_version", "=", codebookVersion)
    .where("labeller_id", "=", labellerId(role))
    .where("input_digest", "=", digest)
    .executeTakeFirst();
  return row as GoldOutcome | undefined;
}

/** Longest gold-order prefix whose projects all have an outcome for the current digest. */
export async function completePrefixLength(
  ordered: SampleEntry[],
  dataDir: string,
  db: Kysely<any>,
  codebookVersion: string,
  role: RoleSpec,
): Promise<number> {
  let n = 0;
  for (const e of ordered) {
    const manPath = path.join(dataDir, "pipeline", "manifests", `${e.n}.json`);
    if (!fs.existsSync(manPath)) {
      // noEvidence: no outcome expected — still breaks a contiguous outcome prefix
      break;
    }
    const spans = String(e.hn_id) === ARTCRAFT_HN_ID ? [] : projectSpans(dataDir, e.n);
    const digest = spansDigest(spans);
    const existing = await findOutcome(db, e.n, codebookVersion, role, digest);
    if (!existing) break;
    n += 1;
  }
  return n;
}

export type GoldCliDeps = {
  argv?: string[];
  dataDir?: string;
  db?: Kysely<any>;
  client?: { request: (p: string, init: { method: string; body: unknown }) => Promise<{ ok: boolean; status: number; json: unknown; text?: string }> };
  role?: RoleSpec;
  protocolPath?: string;
  signoffPath?: string;
  repoRoot?: string;
  log?: (line: string) => void;
  err?: (line: string) => void;
};

export type GoldCliResult = {
  exitCode: number;
  summary: Record<string, unknown>;
};

export async function runGoldCli(deps: GoldCliDeps = {}): Promise<GoldCliResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const args = parseGoldArgs(deps.argv ?? process.argv.slice(2));

  const { resolveDataDir, getDb } = await import("../../app/server/db.ts");
  const { loadCodebook } = await import("../coding/codebook-prompt.ts");
  const { buildContract, loadGateFile, resolveGatesPath } = await import("../coding/contract.ts");
  const { readKey } = await import("../run.ts");
  const { defaultCacheDir } = await import("../cache/stage-cache.ts");

  const dataDir = deps.dataDir ?? resolveDataDir();
  const repoRoot = deps.repoRoot ?? process.cwd();
  const protocolPath = deps.protocolPath ?? path.join(repoRoot, "protocol", "PROTOCOL.md");
  const signoffPath = deps.signoffPath ?? path.join(dataDir, "decisions", "signoff.jsonl");

  // D-49: A7 gate before any client is built.
  const signed = await a7Signed({ protocolPath, signoffPath });
  if (!signed) {
    err("A7 not signed");
    const summary = { projects: 0, labelled: 0, noGold: 0, excludedA3: 0, noEvidence: 0, stopped: "A7 not signed", completePrefix: 0 };
    log(`GOLD: ${JSON.stringify(summary)}`);
    return { exitCode: 1, summary };
  }

  const role = deps.role ?? ROLE_CONFIG.gold;
  let client = deps.client;
  if (!client) {
    const { assertA9Signed } = await import("../signoff/a9.ts");
    assertA9Signed({ protocolPath, signoffPath });
    const nebiusKey = readKey("NEBIUS_API_KEY", "nebius.key");
    client = roleClient("gold", { nebiusKey, roleSpec: role });
  }

  const db = deps.db ?? getDb();
  await ensureGoldSchema(db);
  const codebook = loadCodebook(path.join(repoRoot, "codebook.md"));
  const contract = buildContract(loadGateFile(resolveGatesPath(undefined, repoRoot)).checkIds);
  const cacheDir = deps.dataDir ? path.join(dataDir, "pipeline", "cache") : defaultCacheDir();

  const projectsPath = args.projects ?? path.join(dataDir, "pipeline", "sample-projects.json");
  const entries = JSON.parse(fs.readFileSync(projectsPath, "utf8")) as SampleEntry[];
  let ordered = sortPilotCandidates(
    entries.map((e) => ({ id: String(e.hn_id), n: e.n, hn_id: String(e.hn_id) })),
    GOLD_SEED,
  ).map((x) => ({ n: x.n, hn_id: x.hn_id }));
  if (args.limit != null && Number.isFinite(args.limit)) ordered = ordered.slice(0, args.limit);

  type Tag = "labelled" | "no-gold" | "excluded-a3" | "no-evidence" | "threw" | "skipped";
  let stopped: string | null = null;
  const limit = pLimit(Math.max(1, args.concurrency || DEFAULT_CONCURRENCY));

  const tags = await Promise.all(
    ordered.map((entry) =>
      limit(async (): Promise<Tag> => {
        if (stopped) return "skipped";
        try {
          const manPath = path.join(dataDir, "pipeline", "manifests", `${entry.n}.json`);
          if (!fs.existsSync(manPath)) return "no-evidence";
          if (String(entry.hn_id) === ARTCRAFT_HN_ID) {
            const digest = spansDigest([]);
            const existing = await findOutcome(db, entry.n, codebook.codebookVersion, role, digest);
            if (!existing) {
              await writeExcludedA3({
                db,
                projectN: entry.n,
                codebookVersion: codebook.codebookVersion,
                role,
                digest,
              });
            }
            return "excluded-a3";
          }

          const spans = projectSpans(dataDir, entry.n);
          const digest = spansDigest(spans);
          const existing = await findOutcome(db, entry.n, codebook.codebookVersion, role, digest);
          if (existing && (existing.outcome !== "no-gold" || existing.attempt_revision === GOLD_ATTEMPT_REVISION)) {
            return existing.outcome === "no-gold" ? "no-gold" : "labelled";
          }

          if (spans.length === 0) {
            await writeNoSpansLabels({
              db,
              projectN: entry.n,
              codebookVersion: codebook.codebookVersion,
              role,
              digest,
              checkIds: contract.checkIds,
            });
            return "labelled";
          }

          const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
          const hnId = String(man.hnId ?? entry.hn_id);
          const outcome = await labelProject({
            db,
            dataDir,
            cacheDir,
            projectN: entry.n,
            hnId,
            codebook,
            codebookVersion: codebook.codebookVersion,
            contract,
            role,
            client: client!,
          });
          return outcome.outcome === "no-gold" ? "no-gold" : "labelled";
        } catch (e) {
          if (e instanceof QuotaStop || (e as Error)?.name === "QuotaStop") {
            stopped = (e as Error).message || "quota";
            err(`quota stop: ${stopped}`);
            return "skipped";
          }
          err(`project ${entry.n}: ${(e as Error)?.message ?? e}`);
          return "threw";
        }
      }),
    ),
  );

  const labelled = tags.filter((t) => t === "labelled").length;
  const noGold = tags.filter((t) => t === "no-gold").length;
  const excludedA3 = tags.filter((t) => t === "excluded-a3").length;
  const noEvidence = tags.filter((t) => t === "no-evidence").length;
  const threw = tags.filter((t) => t === "threw").length;

  const completePrefix = await completePrefixLength(ordered, dataDir, db, codebook.codebookVersion, role);
  const summary = {
    projects: ordered.length,
    labelled,
    noGold,
    excludedA3,
    noEvidence,
    stopped,
    completePrefix,
    provider: role.provider,
    model: role.model,
    reasoning: role.reasoning,
  };
  log(`GOLD: ${JSON.stringify(summary)}`);
  const exitCode = stopped || threw > 0 ? 1 : 0;
  return { exitCode, summary };
}

async function main() {
  const { exitCode } = await runGoldCli();
  process.exitCode = exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`${(e as Error)?.stack ?? e}\n`);
    process.exitCode = 1;
  });
}
