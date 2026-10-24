// Usage limits on PRISM's own keys (Helen, 2026-10-24). A live run on PRISM's Tavily key or PRISM's
// Token Factory key takes one row here before its job exists; a run on the user's own key takes none.
//
// One row = one run on one of PRISM's keys: kind ("tavily" | "model"), the better-auth user and
// session ids, the time, the worst-case amount reserved (the per-run cap) and, once the run ends,
// what it actually spent. Counts are a rolling 24 h window over `at`. The Tavily credit total is
// the sum of coalesce(actual, reserved) over every Tavily row, so a run still going (or lost in a
// restart) counts at its worst case and the total can never be overshot.
//
// The reservation is ONE `insert ... select ... where <every limit holds>` statement: SQLite runs it
// atomically, so concurrent submissions cannot both take the last slot. The Token Factory dollar
// total stays in app_spend_ledger (live-run.ts); this table adds the run counts for it.
// Limits come only from server environment settings; nothing the client sends reaches them.
import { sql, type Kysely } from "kysely";
import type { DemoAllowance, DemoKind, DemoLimitHit } from "./live-options.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;
const TABLE = "app_demo_usage";

export interface DemoLimits {
  tavily: { totalCredits: number; perAccountDay: number; perSessionDay: number; creditsPerRun: number };
  model: { perAccountDay: number; perSessionDay: number };
}

/** Defaults are Helen's 2026-10-24 numbers. A missing or unreadable value falls back to its default. */
export const DEMO_DEFAULTS = {
  PRISM_DEMO_TAVILY_TOTAL_CREDITS: 90,
  PRISM_DEMO_TAVILY_PER_ACCOUNT_DAY: 10,
  PRISM_DEMO_TAVILY_PER_SESSION_DAY: 3,
  /** Every live Tavily run, on any key: the lean map + extract never spends more than this. */
  PRISM_LIVE_TAVILY_CREDITS_PER_RUN: 10,
  PRISM_DEMO_MODEL_PER_ACCOUNT_DAY: 20,
  PRISM_DEMO_MODEL_PER_SESSION_DAY: 5,
} as const;

function num(env: NodeJS.ProcessEnv, name: keyof typeof DEMO_DEFAULTS): number {
  const raw = env[name];
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEMO_DEFAULTS[name];
}

export function demoLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): DemoLimits {
  return {
    tavily: {
      totalCredits: num(env, "PRISM_DEMO_TAVILY_TOTAL_CREDITS"),
      perAccountDay: num(env, "PRISM_DEMO_TAVILY_PER_ACCOUNT_DAY"),
      perSessionDay: num(env, "PRISM_DEMO_TAVILY_PER_SESSION_DAY"),
      creditsPerRun: num(env, "PRISM_LIVE_TAVILY_CREDITS_PER_RUN"),
    },
    model: {
      perAccountDay: num(env, "PRISM_DEMO_MODEL_PER_ACCOUNT_DAY"),
      perSessionDay: num(env, "PRISM_DEMO_MODEL_PER_SESSION_DAY"),
    },
  };
}

export async function ensureDemoQuotaSchema(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable(TABLE)
    .ifNotExists()
    .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("account_id", "text", (c) => c.notNull())
    .addColumn("session_id", "text", (c) => c.notNull())
    .addColumn("job_id", "integer")
    .addColumn("at", "text", (c) => c.notNull())
    .addColumn("reserved", "real", (c) => c.notNull())
    .addColumn("actual", "real")
    .execute();
}

export interface Who {
  accountId: string;
  sessionId: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Reserves one run of `kind` for `who`, or says which limit stops it. `reserved` is the worst case
 * (the per-run cap); `totalCap` is null when the total lives elsewhere (Token Factory's ledger).
 */
export async function reserveDemo(
  db: Kysely<any>,
  kind: DemoKind,
  who: Who,
  limits: DemoLimits,
  { reserved, nowMs }: { reserved: number; nowMs: number },
): Promise<{ id: number } | { hit: DemoLimitHit }> {
  const l = limits[kind];
  const totalCap = kind === "tavily" ? limits.tavily.totalCredits : null;
  const since = iso(nowMs - DAY_MS);
  const r = await sql`
    insert into app_demo_usage (kind, account_id, session_id, at, reserved)
    select ${kind}, ${who.accountId}, ${who.sessionId}, ${iso(nowMs)}, ${reserved}
    where (select count(*) from app_demo_usage where kind = ${kind} and session_id = ${who.sessionId} and at > ${since}) < ${l.perSessionDay}
      and (select count(*) from app_demo_usage where kind = ${kind} and account_id = ${who.accountId} and at > ${since}) < ${l.perAccountDay}
      and (${totalCap} is null or (select coalesce(sum(coalesce(actual, reserved)), 0) from app_demo_usage where kind = ${kind}) + ${reserved} <= ${totalCap ?? 0})
  `.execute(db);
  if (Number(r.numAffectedRows ?? 0) === 1) return { id: Number(r.insertId) };
  // Refused: work out which limit, for the message. A read after the fact is enough for wording.
  const a = await readAllowance(db, kind, who, limits, nowMs);
  const limit = a.totalLeft !== null && a.totalLeft < reserved ? "total" : a.sessionLeft === 0 ? "session" : "account";
  return { hit: { kind, limit, of: limit === "session" ? a.sessionOf : limit === "account" ? a.accountOf : a.totalOf!, resetsAt: limit === "session" ? a.sessionResetsAt : limit === "account" ? a.accountResetsAt : null } };
}

/** A reservation whose job was never created is given back. */
export async function releaseDemo(db: Kysely<any>, id: number): Promise<void> {
  await db.deleteFrom(TABLE).where("id", "=", id).execute();
}

export async function attachDemoJob(db: Kysely<any>, ids: number[], jobId: number): Promise<void> {
  if (ids.length) await db.updateTable(TABLE).set({ job_id: jobId }).where("id", "in", ids).execute();
}

/** Settles a finished job's rows to what it actually spent (dollars for model, credits for Tavily). */
export async function settleDemo(db: Kysely<any>, jobId: number, spent: { model: number; tavily: number }): Promise<void> {
  await db.updateTable(TABLE).set({ actual: Math.max(0, spent.model) }).where("job_id", "=", jobId).where("kind", "=", "model").execute();
  await db.updateTable(TABLE).set({ actual: Math.max(0, spent.tavily) }).where("job_id", "=", jobId).where("kind", "=", "tavily").execute();
}

/** Tavily credits PRISM's demo budget has committed: settled spend plus what open runs hold. */
export async function tavilyCreditsUsed(db: Kysely<any>): Promise<number> {
  const r = await sql<{ n: number }>`select coalesce(sum(coalesce(actual, reserved)), 0) as n from app_demo_usage where kind = 'tavily'`.execute(db);
  return Number(r.rows[0]?.n ?? 0);
}

async function windowRows(db: Kysely<any>, kind: DemoKind, col: "account_id" | "session_id", id: string, sinceIso: string): Promise<string[]> {
  const rows = await db.selectFrom(TABLE).select("at").where("kind", "=", kind).where(col, "=", id).where("at", ">", sinceIso).orderBy("at").execute();
  return rows.map((r: any) => String(r.at));
}

/** What `who` has left of `kind`, and when the oldest run in each window drops out. */
export async function readAllowance(db: Kysely<any>, kind: DemoKind, who: Who, limits: DemoLimits, nowMs: number): Promise<DemoAllowance> {
  const l = limits[kind];
  const since = iso(nowMs - DAY_MS);
  const s = await windowRows(db, kind, "session_id", who.sessionId, since);
  const a = await windowRows(db, kind, "account_id", who.accountId, since);
  const reset = (rows: string[], of: number) => (rows.length >= of && rows.length ? iso(Date.parse(rows[rows.length - of] ?? rows[0]) + DAY_MS) : null);
  const total = kind === "tavily" ? limits.tavily.totalCredits : null;
  return {
    kind,
    sessionLeft: Math.max(0, l.perSessionDay - s.length),
    sessionOf: l.perSessionDay,
    sessionResetsAt: reset(s, l.perSessionDay),
    accountLeft: Math.max(0, l.perAccountDay - a.length),
    accountOf: l.perAccountDay,
    accountResetsAt: reset(a, l.perAccountDay),
    totalLeft: total === null ? null : Math.max(0, Math.round((total - (await tavilyCreditsUsed(db))) * 1e6) / 1e6),
    totalOf: total,
    perRun: kind === "tavily" ? limits.tavily.creditsPerRun : null,
  };
}
