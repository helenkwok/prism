// APP-02 / D-80 / research Pattern 6: the live run's job table, stage events,
// spend ledger and the one in-process runner queue. No TanStack imports: the
// server functions in run-fns.ts load this module on the server only, and the
// unit tests call the *As / core functions with an in-memory database.
//
// Order of checks in startLiveRunAs: admin role, trusted Origin, a configured
// cap, URL shape, own/opt-in pre-flight (07-02), then the $0.10 reservation.
// A refusal writes no job and makes no request.
//
// Money (D-80, caveat C7): each run reserves $0.10 in app_spend_ledger before
// its job row exists; the run's DollarBudget has the ledger as parent; the end
// of a run releases the reservation and adds the actual spend; a restart
// charges every unfinished reservation as spent. spent_usd only ever grows.
// Each ledger change is one conditional UPDATE, atomic on its own across
// requests and processes, so the reservation needs no transaction. (Kysely does
// serialise this process's queries and transactions on the one SQLite
// connection: tests/app/db-concurrency.test.mjs.)
import { sql, type Kysely } from "kysely";
import pLimit from "p-limit";
import { z } from "zod";

import { AccessError, checkRole } from "./access.ts";
import { preflightLiveUrl, type PreflightRefusal } from "./live-preflight.ts";
import { BudgetExceededError, DollarBudget, formatBudgetLine } from "../../pipeline/coding/spend-guards.ts";
import type { Boundary } from "../../pipeline/evidence/boundary.ts";
import { scrubSecrets } from "../../pipeline/evidence/redact.ts";
import {
  COLLECTORS,
  DEFAULT_PROVIDER,
  MEDIAN_RUN_SECONDS,
  MODEL_NAME,
  MODEL_PROVIDERS,
  PAID_BY,
  PROVIDER_NAME,
  STAGE_MODEL,
  type CollectorId,
  type KeySource,
  type ProviderId,
  type ReceiptLine,
  type RunReceipt,
} from "./live-options.ts";

export const STAGES = ["queued", "screen", "collect", "code", "gate", "confirm", "report"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABELS: Record<Stage, string> = {
  queued: "Queued",
  screen: "Screen",
  collect: "Collect (robots.txt first)",
  code: "Code",
  gate: "Gate",
  confirm: "Confirm positives",
  report: "Build report",
};

export type JobStatus = "queued" | "running" | "done" | "stopped" | "refused" | "error" | "interrupted";
export type StageStatus = "waiting" | "running" | "done" | "skipped" | "stopped" | "refused" | "error" | "interrupted";
export const ACTIVE: readonly JobStatus[] = ["queued", "running"];

export const RUN_BUDGET_USD = 0.1;
export const LEDGER_SCOPE = "live-run";
export const NOT_CONFIGURED = "Live run is not configured on this server";
export const FIXTURE_ADDRESS = "93.184.216.34";
const EPS = 1e-9;

export type Refusal = PreflightRefusal | "budget" | "not-configured" | "bad-option";
/** `position`: jobs ahead of this one (0 = it runs now); `waitSeconds` a rough estimate (J7). */
export type StartResult = { jobId: number; position: number; waitSeconds: number } | { refused: Refusal };

// ---- bring your own key ----------------------------------------------------------

/** Keys live only here, in the job object in memory, for one run. Never written anywhere. */
export interface LiveKeys {
  model?: string;
  tavily?: string;
}
export interface LiveOptions {
  provider: ProviderId;
  collector: CollectorId;
  keySource: KeySource;
  keys: LiveKeys;
}
export const SERVER_OPTIONS: LiveOptions = { provider: DEFAULT_PROVIDER, collector: "own-site", keySource: "server", keys: {} };

const keyShape = z.string().min(8).max(512).regex(/^[\x21-\x7e]+$/); // printable ASCII, no whitespace
const optionalKey = z.preprocess((v) => (v === "" || v == null ? undefined : v), keyShape.optional());
const optionsSchema = z
  .object({
    modelKey: optionalKey,
    tavilyKey: optionalKey,
    provider: z.enum(Object.keys(MODEL_PROVIDERS) as [ProviderId, ...ProviderId[]]).optional(),
    collector: z.enum(Object.keys(COLLECTORS) as [CollectorId, ...CollectorId[]]).optional(),
  })
  .strict(); // an unknown field (a base URL, say) is refused, not ignored

/**
 * The form's key and choice fields, or null (refused). A provider other than the default needs
 * a model key; the Tavily collector needs a Tavily key; a Tavily key alone selects Tavily.
 * Never put the raw input in an error: it may hold a key.
 */
export function parseLiveOptions(raw: unknown): LiveOptions | null {
  const p = optionsSchema.safeParse(raw ?? {});
  if (!p.success) return null;
  const { modelKey, tavilyKey } = p.data;
  const provider = p.data.provider ?? DEFAULT_PROVIDER;
  const collector = p.data.collector ?? (tavilyKey ? "tavily" : "own-site");
  if (provider !== DEFAULT_PROVIDER && !modelKey) return null;
  if (collector === "tavily" && !tavilyKey) return null;
  if (collector !== "tavily" && tavilyKey) return null;
  const keys: LiveKeys = {};
  if (modelKey) keys.model = modelKey;
  if (tavilyKey) keys.tavily = tavilyKey;
  return { provider, collector, keySource: modelKey ? "user" : "server", keys };
}

/** Ledger row for a run: the server cap's own row, or one per provider for user-key spend. */
export const ledgerScope = (o: { keySource: KeySource; provider: ProviderId }) =>
  o.keySource === "server" ? LEDGER_SCOPE : `${LEDGER_SCOPE}:user:${o.provider}`;

/** Idempotent: safe at every server start. */
export async function ensureLiveRunSchema(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("app_job")
    .ifNotExists()
    .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
    .addColumn("project_ref", "text")
    .addColumn("url", "text", (c) => c.notNull())
    .addColumn("host", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("stop_stage", "text")
    .addColumn("message", "text")
    .addColumn("spent_usd", "real", (c) => c.notNull().defaultTo(0))
    .addColumn("created_by", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("finished_at", "text")
    .addColumn("report_ready", "integer", (c) => c.notNull().defaultTo(0))
    .execute();
  await db.schema
    .createTable("app_job_event")
    .ifNotExists()
    .addColumn("job_id", "integer", (c) => c.notNull())
    .addColumn("seq", "integer", (c) => c.notNull())
    .addColumn("stage", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("message", "text")
    .addColumn("at", "text", (c) => c.notNull())
    .addPrimaryKeyConstraint("app_job_event_pk", ["job_id", "seq"])
    .execute();
  await db.schema
    .createTable("app_spend_ledger")
    .ifNotExists()
    .addColumn("scope", "text", (c) => c.primaryKey())
    .addColumn("cap_usd", "real", (c) => c.notNull())
    .addColumn("spent_usd", "real", (c) => c.notNull().defaultTo(0))
    .addColumn("reserved_usd", "real", (c) => c.notNull().defaultTo(0))
    .execute();
  // J2 receipt: one row per model call. Model, provider, key source, tokens, list-price dollars. Never a key.
  await db.schema
    .createTable("app_job_usage")
    .ifNotExists()
    .addColumn("job_id", "integer", (c) => c.notNull())
    .addColumn("stage", "text", (c) => c.notNull())
    .addColumn("model", "text", (c) => c.notNull())
    .addColumn("provider", "text", (c) => c.notNull())
    .addColumn("key_source", "text", (c) => c.notNull())
    .addColumn("tokens_in", "integer", (c) => c.notNull())
    .addColumn("tokens_out", "integer", (c) => c.notNull())
    .addColumn("usd", "real", (c) => c.notNull())
    .execute();
  // BYOK (2026-10-24): which key paid, which provider and which collector. Never key material.
  await addColumnIfMissing(db, "app_job", "key_source", "'server'");
  await addColumnIfMissing(db, "app_job", "provider", `'${DEFAULT_PROVIDER}'`);
  await addColumnIfMissing(db, "app_job", "collector", "'own-site'");
  await addColumnIfMissing(db, "app_spend_ledger", "key_source", "'server'");
  await addColumnIfMissing(db, "app_spend_ledger", "provider", `'${DEFAULT_PROVIDER}'`);
}

async function addColumnIfMissing(db: Kysely<any>, table: string, column: string, defaultSql: string): Promise<void> {
  const cols = (await sql<{ name: string }>`select name from pragma_table_info(${table})`.execute(db)).rows.map((r) => r.name);
  if (!cols.includes(column)) await sql.raw(`alter table ${table} add column ${column} text not null default ${defaultSql}`).execute(db);
}

// ---- runners -------------------------------------------------------------------

export interface RunJob {
  id: number;
  url: string;
  host: string;
  projectRef: string | null;
  /** BYOK: the run's choices; `options.keys` is cleared when the job ends. Absent = server key, own-site. */
  options?: LiveOptions;
}
export interface RunContext {
  db: Kysely<any>;
  job: RunJob;
  /** One event per transition; the stage list shows each stage's latest event. */
  emit(stage: Exclude<Stage, "queued">, status: "running" | "done", message?: string | null): Promise<void>;
  /** The per-run $0.10 budget; every paid call goes through assertRequestAllowed with it. */
  budget: DollarBudget;
  /** Records that a report view exists for this project (call it once the gate has run). */
  setReport(projectRef: string): Promise<void>;
  /**
   * J2: wraps a model fetch so each call's usage lands in the receipt under the current stage.
   * `toPipelineId` turns a provider's model id back into the pipeline's.
   */
  meter?(f: typeof fetch | undefined, toPipelineId?: (model: string) => string): typeof fetch;
}
/** `notAnalysed`: the screen excluded the project; the job ends with that message and no report. */
export type LiveRunner = (ctx: RunContext) => Promise<{ projectRef: string; notAnalysed?: string }>;

/** Production default until plan 07-13 wires the real pipeline. */
export const notConfiguredRunner: LiveRunner = async () => {
  throw new Error(NOT_CONFIGURED);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * PRISM_LIVE_RUNNER=fixture: no network, no model call. It walks the six
 * stages and re-stores the matched corpus project's report, flagged fixture.
 */
export function createFixtureRunner({ stageMs = 200 }: { stageMs?: number } = {}): LiveRunner {
  return async ({ db, job, emit, setReport }) => {
    const { readReportView, upsertReportView } = await import("../../report/store.ts");
    const view = job.projectRef ? await readReportView(db, job.projectRef, "identifiable") : null;
    const step = async (stage: Exclude<Stage, "queued">, message: string) => {
      await emit(stage, "running");
      if (stageMs) await sleep(stageMs);
      await emit(stage, "done", message);
    };
    await step("screen", "Fixture: screened as an AI product.");
    if (!view || view.view !== "identifiable") throw new Error("no stored fixture report for this site");
    await step("collect", `Fixture: ${view.collection.pages} pages collected. robots.txt allowed collection.`);
    await step("code", `Fixture: ${view.checks.length} checks coded.`);
    await step("gate", "Fixture: gate run on the stored states.");
    await upsertReportView(db, { ...view, fixture: true, generatedAt: new Date().toISOString() });
    await setReport(view.projectRef);
    await step("confirm", "Fixture: stored confirmations used.");
    await step("report", "Fixture: report stored.");
    return { projectRef: view.projectRef };
  };
}

export function runnerFromEnv(env: NodeJS.ProcessEnv = process.env): { name: "fixture" | "real" | "not-configured"; runner: LiveRunner } {
  if (env.PRISM_LIVE_RUNNER === "real") {
    const missing = ["NEBIUS_API_KEY", "PRISM_LIVE_RUN_CAP_USD"].filter((k) => !env[k]?.trim());
    if (missing.length) throw new Error(`PRISM_LIVE_RUNNER=real needs ${missing.join(" and ")}`);
    return { name: "real", runner: createRealRunner({ apiKey: env.NEBIUS_API_KEY!, githubToken: env.GITHUB_TOKEN ?? "" }) };
  }
  return env.PRISM_LIVE_RUNNER === "fixture"
    ? { name: "fixture", runner: createFixtureRunner() }
    : { name: "not-configured", runner: notConfiguredRunner };
}

// ---- the real runner (07-13, D-80) ----------------------------------------------------

export const A9_TABLE = "app_a9_signoff";

/** seed-access fills it; the runner copies it into each job's scratch decisions file for the A9 guard. */
export async function ensureA9Table(db: Kysely<any>): Promise<void> {
  await db.schema.createTable(A9_TABLE).ifNotExists().addColumn("line", "text", (c) => c.primaryKey()).execute();
}

export interface RealRunnerDeps {
  apiKey: string;
  githubToken: string;
  /** Fetch for the server key's calls (tests). The URL is always Token Factory's: no base-URL override. */
  modelFetch?: typeof fetch;
  /** Collector connections; default pinnedFetch (D-80). */
  siteFetch?: typeof fetch;
  githubFetch?: typeof fetch;
  gateSpawnImpl?: unknown;
  pythonPath?: string;
  /** Root for per-job scratch dirs; default PRISM_DATA_DIR/live. */
  scratchRoot?: string;
  /** A9 sign-off record lines; default the app database's app_a9_signoff table. */
  a9Lines?: (db: Kysely<any>) => Promise<string[]>;
  keepScratch?: boolean;
  /** Tavily connection (tests); default fetch. Used only with a user's Tavily key. */
  tavilyFetch?: typeof fetch;
  /** Raw fetch under a user-key provider (tests); the provider's own wrapper still applies. Default fetch. */
  userModelFetch?: typeof fetch;
}

/**
 * The fixed provider list behind MODEL_PROVIDERS: base URL, model map and fetch wrapper are
 * chosen here on the server, by id. The client can never supply a URL (SSRF).
 */
async function userProvider(id: ProviderId, rawFetch: typeof fetch = fetch) {
  const { PINNED_BASE_URL } = await import("../../pipeline/coding/nebius-client.ts");
  if (id === "openrouter") {
    const p = await import("../../pipeline/validate/providers.ts");
    // Prices come from OpenRouter's public model list (no key sent), so the run budget prices each call.
    const res = await rawFetch(`${p.OPENROUTER_BASE_URL}/models`);
    if (!res.ok) throw new Error(`OpenRouter model list: status ${res.status}`);
    p.registerOpenRouterPrices(((await res.json()) as any)?.data ?? []);
    return { baseUrl: p.OPENROUTER_BASE_URL, modelMap: p.OPENROUTER_MODEL_MAP, fetchImpl: p.openRouterFetch({ fetchImpl: rawFetch }) };
  }
  return { baseUrl: PINNED_BASE_URL, modelMap: undefined, fetchImpl: rawFetch };
}

/**
 * Screen (Lightning) -> runPipeline on a one-entry slice (own site + own repos, robots.txt first,
 * pinnedFetch, no rendering) -> confirm positives (Ultra, thinking on: Phase 4's A10.2 winner) ->
 * report. Every paid call goes through the run's DollarBudget. Pipeline rows live only in the
 * job's scratch database; the app database receives the ReportView and its snapshots.
 */
export function createRealRunner(deps: RealRunnerDeps): LiveRunner {
  return async ({ db, job, emit, budget, setReport, meter }) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { default: Database } = await import("better-sqlite3");
    const { Kysely: K, SqliteDialect } = await import("kysely");
    const { resolveDataDir } = await import("./db.ts");
    const { createClient, PINNED_BASE_URL, PINNED_MODEL } = await import("../../pipeline/coding/nebius-client.ts");
    const { screenCandidate, SCREENER_MODEL, STAGE1_THINKING } = await import("../../pipeline/select/screen-model.ts");
    const { runPipeline } = await import("../../pipeline/run.ts");
    const { pinnedFetch } = await import("../../pipeline/evidence/pinned-fetch.ts");
    const { loadCodebook } = await import("../../pipeline/coding/codebook-prompt.ts");
    const { resolveGatesPath } = await import("../../pipeline/coding/contract.ts");
    const conf = await import("../../pipeline/confirm/confirm.ts");
    const { runGate } = await import("../../pipeline/gate/run-gate.ts");
    const { sourceFromStore } = await import("../../report/source-from-store.ts");
    const { buildReportView, loadGapText } = await import("../../report/view.ts");
    const { upsertReportView, upsertSnapshot } = await import("../../report/store.ts");

    const access = job.projectRef
      ? await db.selectFrom("app_project_access").select(["project_id", "title"]).where("project_id", "=", job.projectRef).executeTakeFirst()
      : undefined;
    if (!access) throw new Error("no access row for this site");
    const projectRef = String(access.project_id);
    const title = String(access.title ?? job.host);
    const opts = job.options ?? SERVER_OPTIONS;
    const user = opts.keys.model ? await userProvider(opts.provider, deps.userModelFetch) : null;
    const model = user
      ? { apiKey: opts.keys.model!, baseUrl: user.baseUrl, modelMap: user.modelMap, fetchImpl: user.fetchImpl, host: PROVIDER_NAME[opts.provider] }
      : // PRISM's own key only ever goes to Token Factory (hackathon platform rule): no URL or map override.
        { apiKey: deps.apiKey, baseUrl: PINNED_BASE_URL, modelMap: undefined, fetchImpl: deps.modelFetch, host: PROVIDER_NAME["token-factory"] };
    const useTavily = opts.collector === "tavily";
    if (meter) {
      const back = new Map(Object.entries(model.modelMap ?? {}).map(([k, v]) => [v, k]));
      model.fetchImpl = meter(model.fetchImpl, (m) => back.get(m) ?? m);
    }
    const client = createClient({
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      fetchImpl: model.fetchImpl,
      modelMap: model.modelMap,
      budget,
      concurrency: 1,
    });
    const host = model.host;
    const runLine = { collector: COLLECTORS[opts.collector], paidBy: PAID_BY[opts.keySource], provider: host };

    await emit("screen", "running");
    const screen = await screenCandidate(client, 1, { title, url: job.url }, { thinking: STAGE1_THINKING });
    if (!screen.include) {
      const message = `Not analysed: the screen found ${screen.reasonCode}. No report was built.`;
      await emit("screen", "done", message);
      return { projectRef, notAnalysed: message };
    }
    await emit("screen", "done", "Screened as an AI product.");

    const scratch = path.join(deps.scratchRoot ?? path.join(resolveDataDir(), "live"), String(job.id));
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(path.join(scratch, "decisions"), { recursive: true, mode: 0o700 });
    const sdb = new K<any>({ dialect: new SqliteDialect({ database: new Database(path.join(scratch, "pipeline.sqlite")) }) });
    try {
      const lines = deps.a9Lines
        ? await deps.a9Lines(db)
        : await ensureA9Table(db).then(async () => (await db.selectFrom(A9_TABLE).select("line").execute()).map((r: any) => String(r.line)));
      const a9Path = path.join(scratch, "decisions", "signoff.jsonl");
      fs.writeFileSync(a9Path, lines.map((l) => l + "\n").join(""), { mode: 0o600 });
      const slice = path.join(scratch, "slice.json");
      fs.writeFileSync(slice, JSON.stringify([{ n: 1, hn_id: `live-${job.id}`, title, final_url: job.url }]));

      const accounting = await runPipeline({
        sliceProjectsPath: slice,
        apiKeys: { tavily: useTavily ? opts.keys.tavily! : "", nebius: model.apiKey, github: deps.githubToken },
        concurrency: 1,
        cacheDir: path.join(scratch, "cache"),
        dataDir: scratch,
        db: sdb as any,
        secondCoderIds: new Set(),
        overrides: {
          ownSiteFetchImpl: deps.siteFetch ?? pinnedFetch,
          githubFetchImpl: deps.githubFetch ?? pinnedFetch,
          nebiusFetchImpl: model.fetchImpl,
          nebiusBaseUrl: model.baseUrl,
          modelMap: model.modelMap,
          useTavily,
          tavilyRobotsFirst: true,
          tavilyFetchImpl: deps.tavilyFetch,
          renderImpl: async () => "",
          gateSpawnImpl: deps.gateSpawnImpl as any,
          pythonPath: deps.pythonPath,
          tfBudget: budget,
          a9SignoffPath: a9Path,
          onStage: (stage, status, message) => emit(stage, status, message ?? null),
        },
      });
      const outcome = accounting.outcomes[0];
      if (!outcome || outcome.status !== "ok") {
        if (outcome?.status === "stopped" && /budget|reserved allowance/i.test(outcome.error ?? "")) throw new BudgetExceededError(budget.snapshot());
        throw new Error(outcome?.error ?? "the pipeline ran no project");
      }

      const codebook = loadCodebook(path.join(process.cwd(), "codebook.md"));
      const gatesPath = resolveGatesPath();
      const gapText = loadGapText({ codebook });
      const gate = (record: unknown) => runGate(record as any, { spawnImpl: deps.gateSpawnImpl as any, pythonPath: deps.pythonPath });
      await conf.ensureConfirmationSchema(sdb as any);
      await conf.ensureEditsSchema(sdb as any);
      const collectedAt = new Date().toISOString();
      const store = async () => {
        const source = await sourceFromStore(sdb as any, scratch, codebook, 1, {
          projectId: projectRef,
          title,
          hnId: null,
          collectedAt,
          generatedAt: new Date().toISOString(),
          renderAvailable: false,
          roles: {
            coding: { role: "coder", modelId: PINNED_MODEL, host },
            confirmation: { role: "confirmer", modelId: conf.CONFIRMER_MODEL, host },
            humanEdits: "none",
            run: { ...runLine, receipt: await readRunReceipt(db, job.id) },
          },
        });
        const view = await buildReportView(source, { codebook, gatesPath, runGate: gate as any, gapText });
        for (const p of source.pages) {
          const snap = JSON.parse(fs.readFileSync(path.join(scratch, "pipeline", "snapshots", `${p.snapshotHash}.json`), "utf8"));
          await upsertSnapshot(db, { projectRef, hash: p.snapshotHash, url: p.url, archivedAt: collectedAt, text: snap.redactedText, fixture: false });
        }
        await upsertReportView(db, view);
        return view;
      };
      await store(); // after the gate: a budget stop in Confirm still leaves a report (positives awaiting)
      await setReport(projectRef);

      await emit("confirm", "running");
      const spanText = new Map(conf.projectSpans(scratch, 1).map((s) => [s.id, s.text]));
      const flags = (await sdb.selectFrom("pipeline_injection_flags").select("span_id").where("project_n", "=", 1).execute()).map((r: any) => r.span_id);
      const rows = await sdb.selectFrom("pipeline_check_states").selectAll().where("project_n", "=", 1).execute();
      const positives = (rows as any[])
        .filter((r) => r.filtered_state === "pass" || r.filtered_state === "claimed")
        .map((r) => ({ projectN: 1, checkId: r.check_id, state: r.filtered_state, flaggedSpanIds: flags, spans: JSON.parse(r.span_ids_json).map((id: string) => ({ id, text: spanText.get(id) ?? "" })) }));
      let decided = 0;
      let undecided = 0;
      for (const p of positives) {
        try {
          const v = await conf.confirmWithModel(client, codebook, p, conf.CONFIRMER_MODEL, 3, true);
          await conf.recordConfirmation(sdb as any, {
            projectN: 1, checkId: p.checkId, decision: v.decision, confirmedState: conf.confirmedStateFor(v.decision, p.state), reason: v.reason,
            confirmerId: `agent:${conf.CONFIRMER_MODEL}`, confirmerKind: "agent", modelId: conf.CONFIRMER_MODEL,
            decidedAt: new Date().toISOString(), inputDigest: conf.inputDigest(codebook, p), spanIds: p.spans.map((s: { id: string }) => s.id),
          });
          decided += 1;
        } catch (err) {
          // An off-contract or flagged-span reply leaves that positive awaiting; money and quota stops end the run.
          if (err instanceof conf.InvalidConfirmationError || err instanceof conf.FlaggedRuleError) undecided += 1;
          else throw err;
        }
      }
      await emit("confirm", "done", `${decided} of ${positives.length} positives confirmed or decided${undecided ? `, ${undecided} awaiting` : ""}.`);

      await emit("report", "running");
      const view = await store();
      await emit("report", "done", `Report stored: ${view.collection.pages} pages, not rendered on the server.`);
      return { projectRef };
    } finally {
      await sdb.destroy();
      if (!deps.keepScratch) fs.rmSync(scratch, { recursive: true, force: true });
    }
  };
}

/** Fixture mode answers .example hosts with one public address, so tests need no real DNS. */
export async function fixtureResolver(hostname: string): Promise<string[]> {
  if (hostname === "example" || hostname.endsWith(".example")) return [FIXTURE_ADDRESS];
  throw new Error("ENOTFOUND");
}

// ---- start, status, list -------------------------------------------------------

export interface StartDeps {
  db: Kysely<any>;
  runner: LiveRunner;
  resolver?: (hostname: string) => Promise<string[]>;
  env?: NodeJS.ProcessEnv;
}

async function trustedOrigins(env: NodeJS.ProcessEnv): Promise<string[]> {
  const { parseOrigins } = await import("./auth.ts");
  return parseOrigins(env.TRUSTED_ORIGINS, env.BETTER_AUTH_URL || "http://localhost:3000");
}

/** T-07-32: a state-changing, money-spending POST is accepted only from a trusted origin. */
export async function assertTrustedOrigin(headers: Headers, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const origin = headers.get("origin");
  if (!origin || !(await trustedOrigins(env)).includes(origin)) throw new AccessError(403);
}

const urlSchema = z.string().trim().min(1).max(2048);

/** Own and opt-in boundaries from app_project_access, each with its project id. */
export async function liveBoundaries(db: Kysely<any>): Promise<{ projectId: string; boundary: Boundary }[]> {
  const rows = await db
    .selectFrom("app_project_access")
    .select(["project_id", "live_boundary_json"])
    .where("basis", "in", ["own", "opt-in"])
    .where("live_boundary_json", "is not", null)
    .orderBy("project_id")
    .execute();
  const out: { projectId: string; boundary: Boundary }[] = [];
  for (const r of rows as any[]) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.live_boundary_json);
    } catch {
      continue;
    }
    for (const b of Array.isArray(parsed) ? parsed : [parsed]) {
      if (b && typeof b === "object" && typeof (b as Boundary).host === "string") out.push({ projectId: r.project_id, boundary: b as Boundary });
    }
  }
  return out;
}

const now = () => new Date().toISOString();

async function addEvent(db: Kysely<any>, jobId: number, stage: Stage, status: StageStatus, message: string | null) {
  const last = await db.selectFrom("app_job_event").select((eb) => eb.fn.max("seq").as("seq")).where("job_id", "=", jobId).executeTakeFirst();
  await db
    .insertInto("app_job_event")
    .values({ job_id: jobId, seq: Number((last as any)?.seq ?? 0) + 1, stage, status, message, at: now() })
    .execute();
}

/** The session has already passed checkRole / requireRole("admin"). */
export async function startLiveRunCore(
  session: { user: { id: string } },
  headers: Headers,
  rawUrl: unknown,
  { db, runner, resolver, env = process.env }: StartDeps,
  rawOptions?: unknown,
): Promise<StartResult> {
  await assertTrustedOrigin(headers, env);
  const cap = parseCap(env);
  if (cap === null) return { refused: "not-configured" };
  const options = parseLiveOptions(rawOptions);
  if (!options) return { refused: "bad-option" };
  const parsed = urlSchema.safeParse(rawUrl);
  if (!parsed.success) return { refused: "bad-url" };
  const list = await liveBoundaries(db);
  const pre = await preflightLiveUrl(
    parsed.data,
    list.map((l) => l.boundary),
    { resolver },
  );
  if (!pre.ok) return { refused: pre.reason };
  const projectRef = list.find((l) => l.boundary === pre.boundary)!.projectId;
  const url = new URL(parsed.data).toString();
  // A user's own model key pays for its run: the server cap is not reserved, the run budget still applies.
  const server = options.keySource === "server";
  if (server && !(await reserveRun(db, cap))) return { refused: "budget" };
  let jobId: number;
  try {
    const inserted = await db
      .insertInto("app_job")
      .values({
        project_ref: projectRef,
        url,
        host: new URL(url).hostname,
        status: "queued",
        created_by: session.user.id,
        created_at: now(),
        key_source: options.keySource,
        provider: options.provider,
        collector: options.collector,
      })
      .executeTakeFirstOrThrow();
    jobId = Number(inserted.insertId);
  } catch (err) {
    if (server) await settleRun(db, LEDGER_SCOPE, 0); // no job, so nothing spent: give the reservation back
    throw err;
  }
  await addEvent(db, jobId, "queued", "running", "Waiting for the runner.");
  const position = await queuePosition(db, jobId);
  enqueue(db, jobId, runner, options);
  return { jobId, position, waitSeconds: position * MEDIAN_RUN_SECONDS };
}

/** Unit-test entry: the same checks the server function makes, with injected headers. */
export async function startLiveRunAs(headers: Headers, rawUrl: unknown, deps: StartDeps, rawOptions?: unknown): Promise<StartResult> {
  const session = await checkRole({ headers, roles: ["admin"] });
  return startLiveRunCore(session, headers, rawUrl, deps, rawOptions);
}

// ---- ledger --------------------------------------------------------------------

/** PRISM_LIVE_RUN_CAP_USD as a positive number, or null: no cap means no live run. */
export function parseCap(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.PRISM_LIVE_RUN_CAP_USD;
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface LedgerState {
  cap: number;
  spent: number;
  reserved: number;
}

export async function readLedger(db: Kysely<any>): Promise<LedgerState> {
  const r = await db.selectFrom("app_spend_ledger").selectAll().where("scope", "=", LEDGER_SCOPE).executeTakeFirst();
  return { cap: Number(r?.cap_usd ?? 0), spent: Number(r?.spent_usd ?? 0), reserved: Number(r?.reserved_usd ?? 0) };
}

/** One atomic statement: reserve $0.10 only if spent + reserved + 0.10 stays within the cap. */
async function reserveRun(db: Kysely<any>, cap: number): Promise<boolean> {
  await db
    .insertInto("app_spend_ledger")
    .values({ scope: LEDGER_SCOPE, cap_usd: cap, spent_usd: 0, reserved_usd: 0 })
    .onConflict((oc) => oc.column("scope").doUpdateSet({ cap_usd: cap }))
    .execute();
  const r = await db
    .updateTable("app_spend_ledger")
    .set({ reserved_usd: sql`reserved_usd + ${RUN_BUDGET_USD}` })
    .where("scope", "=", LEDGER_SCOPE)
    .where(sql<number>`spent_usd + reserved_usd + ${RUN_BUDGET_USD}`, "<=", cap + EPS)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) === 1;
}

/**
 * Releases one run's reservation and charges what it spent (never negative). A user-key scope has
 * no reservation and no cap: its row only records what users' own keys spent, per provider.
 */
async function settleRun(db: Kysely<any>, scope: string, charged: number, o?: { keySource: KeySource; provider: ProviderId }): Promise<void> {
  if (scope !== LEDGER_SCOPE) {
    await db
      .insertInto("app_spend_ledger")
      .values({ scope, cap_usd: 0, spent_usd: 0, reserved_usd: 0, key_source: o?.keySource ?? "user", provider: o?.provider ?? DEFAULT_PROVIDER })
      .onConflict((oc) => oc.column("scope").doNothing())
      .execute();
  }
  await db
    .updateTable("app_spend_ledger")
    .set({
      reserved_usd: scope === LEDGER_SCOPE ? sql`max(0, reserved_usd - ${RUN_BUDGET_USD})` : sql`reserved_usd`,
      spent_usd: sql`spent_usd + ${Math.max(0, charged)}`,
    })
    .where("scope", "=", scope)
    .execute();
}

/** Every ledger row: scope, key source ("server" | "user"), provider and spend. No key material. */
export async function readLedgerRows(db: Kysely<any>) {
  const rows = await db.selectFrom("app_spend_ledger").selectAll().orderBy("scope").execute();
  return rows.map((r: any) => ({ scope: String(r.scope), keySource: r.key_source as KeySource, provider: r.provider as ProviderId, spent: Number(r.spent_usd), reserved: Number(r.reserved_usd) }));
}

const RESTARTED = "The server restarted during this run.";

/**
 * Boot rule (Pattern 6): every job left queued or running is interrupted and its
 * $0.10 reservation charged as spent, so a restart never resets or undercounts
 * the ledger. Idempotent: a second boot finds nothing to change.
 */
export async function markInterruptedJobs(db: Kysely<any>): Promise<number> {
  const open = await db.selectFrom("app_job").select(["id", "key_source", "provider"]).where("status", "in", [...ACTIVE]).orderBy("id").execute();
  let n = 0;
  for (const { id, key_source, provider } of open as { id: number; key_source: KeySource; provider: ProviderId }[]) {
    const last = await db.selectFrom("app_job_event").select("stage").where("job_id", "=", id).orderBy("seq", "desc").executeTakeFirst();
    const stage = (last?.stage as Stage | undefined) ?? "queued";
    const r = await db
      .updateTable("app_job")
      .set({ status: "interrupted", stop_stage: stage, message: RESTARTED, spent_usd: RUN_BUDGET_USD, finished_at: now() })
      .where("id", "=", id)
      .where("status", "in", [...ACTIVE])
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) !== 1) continue;
    await addEvent(db, id, stage, "interrupted", RESTARTED);
    const o = { keySource: key_source ?? "server", provider: provider ?? DEFAULT_PROVIDER };
    await settleRun(db, ledgerScope(o), RUN_BUDGET_USD, o);
    n += 1;
  }
  return n;
}

export interface BudgetSummary {
  configured: boolean;
  cap: number;
  /** Spent plus what runs still going have reserved: what the cap has already committed. */
  used: number;
  line: string;
  disabled: boolean;
  notice: string | null;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** Shown once the server cap is reached: a user key still runs (it never touches PRISM's budget). */
export const BUDGET_SPENT_NOTICE =
  "PRISM's shared demo budget is used up, so runs on PRISM's key are closed. You can still run with your own key: a Nebius Token Factory API key (or an OpenRouter key as the alternative), and optionally a Tavily key. Or read the recorded reports.";

/** The /run meter, its line and whether the form is disabled (07-UI-SPEC). */
export function budgetSummary(s: { configured: boolean; cap: number; spent: number; reserved: number }): BudgetSummary {
  const used = Math.round((s.spent + s.reserved) * 1e6) / 1e6;
  if (!s.configured) {
    return { configured: false, cap: 0, used, line: "Live-run budget: not configured", disabled: true, notice: "Live runs are not configured on this server: no budget cap is set." };
  }
  const disabled = s.cap - used < RUN_BUDGET_USD - EPS;
  return {
    configured: true,
    cap: s.cap,
    used,
    line: `Live-run budget: ${usd(used)} of ${usd(s.cap)} spent`,
    disabled,
    notice: disabled ? BUDGET_SPENT_NOTICE : null,
  };
}

export async function readBudgetSummary(db: Kysely<any>, env: NodeJS.ProcessEnv = process.env): Promise<BudgetSummary> {
  const cap = parseCap(env);
  const l = await readLedger(db);
  return budgetSummary({ configured: cap !== null, cap: cap ?? 0, spent: l.spent, reserved: l.reserved });
}

// ---- the queue -------------------------------------------------------------------

const limit = pLimit(1);
const inFlight = new Set<Promise<void>>();

function enqueue(db: Kysely<any>, jobId: number, runner: LiveRunner, options: LiveOptions = SERVER_OPTIONS): void {
  const p = limit(() => runJob(db, jobId, runner, options)).catch((err) => {
    console.error(`[prism] live run ${jobId}: runner bookkeeping failed: ${err instanceof Error ? err.name : "error"}`);
  });
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
}

/** Resolves once every queued job has ended (tests). */
export async function whenIdle(): Promise<void> {
  while (inFlight.size) await Promise.all([...inFlight]);
}

async function runJob(db: Kysely<any>, jobId: number, runner: LiveRunner, options: LiveOptions): Promise<void> {
  try {
    await runJobInner(db, jobId, runner, options);
  } finally {
    options.keys = {}; // success, stop, error or skipped: the keys leave memory with the job
  }
}

async function runJobInner(db: Kysely<any>, jobId: number, runner: LiveRunner, options: LiveOptions): Promise<void> {
  const started = await db.updateTable("app_job").set({ status: "running" }).where("id", "=", jobId).where("status", "=", "queued").executeTakeFirst();
  if (Number(started.numUpdatedRows) !== 1) return; // interrupted at boot, or gone
  const row = await db.selectFrom("app_job").selectAll().where("id", "=", jobId).executeTakeFirstOrThrow();
  await addEvent(db, jobId, "queued", "done", "Started.");
  // Every message that leaves the runner (events, the job row) passes this: a provider error that
  // echoes a request header can never carry a user's key into the database.
  const secrets = [options.keys.model, options.keys.tavily].filter((k): k is string => !!k);
  const clean = (m: string | null) => (m == null ? m : scrubSecrets(m, secrets));
  // Server key: the parent holds everything else the ledger has committed; this run's own
  // $0.10 is already reserved there, so the child cap is the binding one. User key: the
  // run budget alone protects the user's credit.
  let budget: DollarBudget;
  if (options.keySource === "server") {
    const l = await readLedger(db);
    const ledger = new DollarBudget(Math.max(l.cap, RUN_BUDGET_USD), { initialSpent: Math.max(0, l.spent + l.reserved - RUN_BUDGET_USD) });
    budget = new DollarBudget(RUN_BUDGET_USD, { parent: ledger });
  } else budget = new DollarBudget(RUN_BUDGET_USD);
  let stage = "queued" as Stage; // set by emit, inside the runner
  let reportReady = false;
  const job: RunJob = { id: jobId, url: row.url, host: row.host, projectRef: row.project_ref, options };
  const provider = PROVIDER_NAME[options.keySource === "user" ? options.provider : DEFAULT_PROVIDER];
  const meter = (f: typeof fetch = fetch, toPipelineId: (m: string) => string = (m) => m): typeof fetch =>
    (async (input: any, init: any) => {
      const res = await f(input, init);
      try {
        const sent = JSON.parse(String(init?.body ?? "null"))?.model;
        const usage = (await res.clone().json())?.usage;
        if (typeof sent === "string" && usage) {
          const tokensIn = Number(usage.prompt_tokens ?? 0);
          const tokensOut = Number(usage.completion_tokens ?? 0);
          const { priceOf } = await import("../../pipeline/coding/spend-guards.ts");
          let usd = 0;
          try {
            const p = priceOf(sent);
            usd = tokensIn * p.prompt + tokensOut * p.completion;
          } catch {
            // no list price: tokens still count, dollars show 0
          }
          await db
            .insertInto("app_job_usage")
            .values({ job_id: jobId, stage, model: toPipelineId(sent), provider, key_source: options.keySource, tokens_in: tokensIn, tokens_out: tokensOut, usd })
            .execute();
        }
      } catch {
        // a reply without JSON usage is not metered
      }
      return res;
    }) as typeof fetch;
  let end: Record<string, unknown>;
  try {
    const result = await runner({
      db,
      job,
      budget,
      meter,
      emit: async (s, status, message = null) => {
        stage = s;
        await addEvent(db, jobId, s, status, clean(message));
      },
      setReport: async (projectRef) => {
        reportReady = true;
        await db.updateTable("app_job").set({ project_ref: projectRef }).where("id", "=", jobId).execute();
      },
    });
    end = result.notAnalysed
      ? { status: "done", project_ref: result.projectRef, report_ready: 0, stop_stage: null, message: result.notAnalysed }
      : { status: "done", project_ref: result.projectRef, report_ready: 1, stop_stage: null, message: null };
  } catch (err) {
    const at: Stage = stage === "queued" ? "screen" : stage;
    if (err instanceof BudgetExceededError) {
      const message = "Stopped at the $0.10 run budget.";
      await addEvent(db, jobId, at, "stopped", message);
      // A report exists only if the runner built one after the gate.
      end = { status: "stopped", stop_stage: at, message, report_ready: reportReady && (at === "confirm" || at === "report") ? 1 : 0 };
    } else {
      const message = clean(err instanceof Error ? err.message : String(err))!.slice(0, 300);
      await addEvent(db, jobId, at, "error", message);
      end = { status: "error", stop_stage: at, message, report_ready: 0 };
    }
  }
  // Only a job still running is finished here: one the boot rule already marked
  // interrupted was charged in full and must not be released a second time.
  const finished = await db
    .updateTable("app_job")
    .set({ ...end, spent_usd: budget.spent, finished_at: now() })
    .where("id", "=", jobId)
    .where("status", "=", "running")
    .executeTakeFirst();
  // ponytail: two statements; a crash between them leaves this $0.10 reserved for good (over-counts, never under).
  if (Number(finished.numUpdatedRows) === 1) await settleRun(db, ledgerScope(options), budget.spent, options);
  console.log(`[prism] live run ${jobId} ${String(end.status)} ${formatBudgetLine({ estimated: budget.estimated, spent: budget.spent, cap: budget.cap })}`);
}

// ---- read side ---------------------------------------------------------------------

export interface StageView {
  stage: Stage;
  label: string;
  /** J2: what does the work, e.g. "Nemotron 3.5 Lightning on Nebius Token Factory". */
  detail: string | null;
  status: StageStatus;
  message: string | null;
  at: string | null;
}
export interface JobView {
  id: number;
  url: string;
  host: string;
  status: JobStatus;
  stopStage: Stage | null;
  stopStageLabel: string | null;
  message: string | null;
  spentUsd: number;
  projectRef: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** The receipt: which collector ran, which provider answered, which key paid. */
  collector: string;
  provider: string;
  paidBy: string;
}
export interface RunStatus {
  job: JobView;
  stages: StageView[];
  /** J7: while queued, the jobs ahead and a rough wait. */
  queue: { position: number; waitSeconds: number } | null;
  /** J2: per-call usage summed by stage; empty until a model is called. */
  receipt: RunReceipt;
  /** Set when a report was built (done, or stopped after Gate). */
  report: { projectRef: string; pages: number; pass: number; fixture: boolean } | null;
}

function jobView(r: any): JobView {
  const stop = STAGES.includes(r.stop_stage) ? (r.stop_stage as Stage) : null;
  return {
    id: Number(r.id),
    url: r.url,
    host: r.host,
    status: r.status,
    stopStage: stop,
    stopStageLabel: stop ? STAGE_LABELS[stop] : null,
    message: r.message ?? null,
    spentUsd: Number(r.spent_usd ?? 0),
    projectRef: r.project_ref ?? null,
    createdAt: r.created_at,
    finishedAt: r.finished_at ?? null,
    collector: COLLECTORS[r.collector as CollectorId] ?? COLLECTORS["own-site"],
    provider: PROVIDER_NAME[r.provider as ProviderId] ?? PROVIDER_NAME[DEFAULT_PROVIDER],
    paidBy: PAID_BY[(r.key_source as KeySource) ?? "server"] ?? PAID_BY.server,
  };
}

/** Stages in the fixed order; each shows its latest event. Stages never reached show Waiting, or Skipped once the job has ended. */
export async function readRunStatus(db: Kysely<any>, jobId: number): Promise<RunStatus | null> {
  const r = await db.selectFrom("app_job").selectAll().where("id", "=", jobId).executeTakeFirst();
  if (!r) return null;
  const job = jobView(r);
  const events = await db.selectFrom("app_job_event").selectAll().where("job_id", "=", jobId).orderBy("seq").execute();
  const latest = new Map<string, any>();
  for (const e of events) latest.set(e.stage, e);
  const active = ACTIVE.includes(job.status);
  const stages = STAGES.map((stage): StageView => {
    const e = latest.get(stage);
    const status: StageStatus = e ? e.status : active ? "waiting" : "skipped";
    return { stage, label: STAGE_LABELS[stage], detail: stageDetail(stage, job), status, message: e?.message ?? null, at: e?.at ?? null };
  });
  let report: RunStatus["report"] = null;
  if (job.projectRef && (job.status === "done" || job.status === "stopped")) {
    const { readReportView } = await import("../../report/store.ts");
    const v = await readReportView(db, job.projectRef, "identifiable");
    if (v && v.view === "identifiable" && r.report_ready === 1) {
      report = { projectRef: job.projectRef, pages: v.collection.pages, pass: v.checks.filter((c) => c.published === "pass").length, fixture: v.fixture };
    }
  }
  const queue = job.status === "queued" ? await queuePosition(db, jobId).then((position) => ({ position, waitSeconds: position * MEDIAN_RUN_SECONDS })) : null;
  return { job, stages, report, queue, receipt: await readRunReceipt(db, jobId) };
}

function stageDetail(stage: Stage, job: JobView): string | null {
  if (stage === "collect") return job.collector;
  if (stage === "gate") return "deterministic gate, no model";
  const model = STAGE_MODEL[stage];
  return model ? `${MODEL_NAME[model] ?? model} on ${job.provider}` : null;
}

/** Jobs ahead of this one: queued or running with a smaller id (the queue runs one job at a time, in order). */
export async function queuePosition(db: Kysely<any>, jobId: number): Promise<number> {
  const r = await db
    .selectFrom("app_job")
    .select((eb) => eb.fn.countAll().as("n"))
    .where("status", "in", [...ACTIVE])
    .where("id", "<", jobId)
    .executeTakeFirst();
  return Number((r as any)?.n ?? 0);
}

/** J2: the receipt from the usage rows, by stage in run order, with a total and the all-Ultra estimate. */
export async function readRunReceipt(db: Kysely<any>, jobId: number): Promise<RunReceipt> {
  const rows = await db.selectFrom("app_job_usage").selectAll().where("job_id", "=", jobId).execute();
  const by = new Map<string, ReceiptLine>();
  for (const r of rows as any[]) {
    const k = `${r.stage}|${r.model}|${r.provider}|${r.key_source}`;
    const l = by.get(k) ?? { stage: r.stage, model: MODEL_NAME[r.model] ?? r.model, provider: r.provider, paidBy: PAID_BY[r.key_source as KeySource] ?? r.key_source, calls: 0, tokensIn: 0, tokensOut: 0, usd: 0 };
    l.calls += 1;
    l.tokensIn += Number(r.tokens_in);
    l.tokensOut += Number(r.tokens_out);
    l.usd += Number(r.usd);
    by.set(k, l);
  }
  const lines = [...by.values()].sort((a, b) => STAGES.indexOf(a.stage as Stage) - STAGES.indexOf(b.stage as Stage));
  const total = lines.reduce((t, l) => ({ calls: t.calls + l.calls, tokensIn: t.tokensIn + l.tokensIn, tokensOut: t.tokensOut + l.tokensOut, usd: t.usd + l.usd }), { calls: 0, tokensIn: 0, tokensOut: 0, usd: 0 });
  const { priceOf } = await import("../../pipeline/coding/spend-guards.ts");
  const ultra = priceOf(STAGE_MODEL.confirm); // Token Factory list price
  return { lines, total, ultraEstimateUsd: total.tokensIn * ultra.prompt + total.tokensOut * ultra.completion };
}

/** Newest 20 first; ties broken by job id. */
export async function readRecentRuns(db: Kysely<any>): Promise<JobView[]> {
  const rows = await db.selectFrom("app_job").selectAll().orderBy("created_at", "desc").orderBy("id", "desc").limit(20).execute();
  return rows.map(jobView);
}

export async function getRunStatusAs(headers: Headers, jobId: number, db: Kysely<any>): Promise<RunStatus | null> {
  await checkRole({ headers, roles: ["admin"] });
  return readRunStatus(db, jobId);
}

export async function listRecentRunsAs(headers: Headers, db: Kysely<any>): Promise<JobView[]> {
  await checkRole({ headers, roles: ["admin"] });
  return readRecentRuns(db);
}
