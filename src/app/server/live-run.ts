// APP-02 / D-80 / research Pattern 6: the live run's job table, stage events,
// spend ledger and the one in-process runner queue. No TanStack imports: the
// server functions in run-fns.ts load this module on the server only, and the
// unit tests call the *As / core functions with an in-memory database.
//
// Order of checks in startLiveRunAs: admin role, trusted Origin, URL shape,
// own/opt-in pre-flight (07-02). A refusal writes nothing and makes no request.
import type { Kysely } from "kysely";
import pLimit from "p-limit";
import { z } from "zod";

import { AccessError, checkRole } from "./access.ts";
import { preflightLiveUrl, type PreflightRefusal } from "./live-preflight.ts";
import { DollarBudget } from "../../pipeline/coding/spend-guards.ts";
import type { Boundary } from "../../pipeline/evidence/boundary.ts";

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

export type Refusal = PreflightRefusal | "budget" | "not-configured";
export type StartResult = { jobId: number } | { refused: Refusal };

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
}

// ---- runners -------------------------------------------------------------------

export interface RunJob {
  id: number;
  url: string;
  host: string;
  projectRef: string | null;
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
}
export type LiveRunner = (ctx: RunContext) => Promise<{ projectRef: string }>;

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

export function runnerFromEnv(env: NodeJS.ProcessEnv = process.env): { name: "fixture" | "not-configured"; runner: LiveRunner } {
  return env.PRISM_LIVE_RUNNER === "fixture"
    ? { name: "fixture", runner: createFixtureRunner() }
    : { name: "not-configured", runner: notConfiguredRunner };
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
): Promise<StartResult> {
  await assertTrustedOrigin(headers, env);
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
  const createdAt = now();
  const inserted = await db
    .insertInto("app_job")
    .values({ project_ref: projectRef, url, host: new URL(url).hostname, status: "queued", created_by: session.user.id, created_at: createdAt })
    .executeTakeFirstOrThrow();
  const jobId = Number(inserted.insertId);
  await addEvent(db, jobId, "queued", "running", "Waiting for the runner.");
  enqueue(db, jobId, runner);
  return { jobId };
}

/** Unit-test entry: the same checks the server function makes, with injected headers. */
export async function startLiveRunAs(headers: Headers, rawUrl: unknown, deps: StartDeps): Promise<StartResult> {
  const session = await checkRole({ headers, roles: ["admin"] });
  return startLiveRunCore(session, headers, rawUrl, deps);
}

// ---- the queue -------------------------------------------------------------------

const limit = pLimit(1);
const inFlight = new Set<Promise<void>>();

function enqueue(db: Kysely<any>, jobId: number, runner: LiveRunner): void {
  const p = limit(() => runJob(db, jobId, runner)).catch((err) => {
    console.error(`[prism] live run ${jobId}: runner bookkeeping failed: ${err instanceof Error ? err.name : "error"}`);
  });
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
}

/** Resolves once every queued job has ended (tests). */
export async function whenIdle(): Promise<void> {
  while (inFlight.size) await Promise.all([...inFlight]);
}

async function runJob(db: Kysely<any>, jobId: number, runner: LiveRunner): Promise<void> {
  const row = await db.selectFrom("app_job").selectAll().where("id", "=", jobId).executeTakeFirst();
  if (!row || row.status !== "queued") return; // interrupted at boot, or gone
  await db.updateTable("app_job").set({ status: "running" }).where("id", "=", jobId).execute();
  await addEvent(db, jobId, "queued", "done", "Started.");
  let stage: Stage = "queued";
  const budget = new DollarBudget(RUN_BUDGET_USD);
  const job: RunJob = { id: jobId, url: row.url, host: row.host, projectRef: row.project_ref };
  const finish = (values: Record<string, unknown>) =>
    db.updateTable("app_job").set({ ...values, spent_usd: budget.spent, finished_at: now() }).where("id", "=", jobId).execute();
  try {
    const result = await runner({
      db,
      job,
      budget,
      emit: async (s, status, message = null) => {
        stage = s;
        await addEvent(db, jobId, s, status, message);
      },
      setReport: async (projectRef) => {
        await db.updateTable("app_job").set({ project_ref: projectRef }).where("id", "=", jobId).execute();
      },
    });
    await finish({ status: "done", project_ref: result.projectRef, stop_stage: null, message: null });
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    if (stage !== "queued") await addEvent(db, jobId, stage, "error", message);
    await finish({ status: "error", stop_stage: stage === "queued" ? "screen" : stage, message });
  }
}

// ---- read side ---------------------------------------------------------------------

export interface StageView {
  stage: Stage;
  label: string;
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
}
export interface RunStatus {
  job: JobView;
  stages: StageView[];
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
    return { stage, label: STAGE_LABELS[stage], status, message: e?.message ?? null, at: e?.at ?? null };
  });
  let report: RunStatus["report"] = null;
  if (job.projectRef && (job.status === "done" || job.status === "stopped")) {
    const { readReportView } = await import("../../report/store.ts");
    const v = await readReportView(db, job.projectRef, "identifiable");
    if (v && v.view === "identifiable" && (job.status === "done" || job.stopStage === "confirm" || job.stopStage === "report")) {
      report = { projectRef: job.projectRef, pages: v.collection.pages, pass: v.checks.filter((c) => c.published === "pass").length, fixture: v.fixture };
    }
  }
  return { job, stages, report };
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
