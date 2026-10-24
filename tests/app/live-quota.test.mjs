// Usage limits on PRISM's own keys and the lean Tavily collector (Helen, 2026-10-24). No real
// network: fake Tavily and fake model hosts only; an injected clock for the rolling 24 h window.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import dnsPromises from "node:dns/promises";

const realLookup = dnsPromises.lookup;
dnsPromises.lookup = async (hostname, opts) => {
  if (!String(hostname).endsWith(".example")) return realLookup(hostname, opts);
  const address = "93.184.215.14";
  return opts?.all ? [{ address, family: 4 }] : { address, family: 4 };
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-quota-"));
process.env.PRISM_DATA_DIR = dataDir;
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3996";
delete process.env.TRUSTED_ORIGINS;
process.env.PRISM_KEY_DIR = dataDir; // never the real key file
delete process.env.TAVILY_API_KEY;
for (const k of Object.keys(process.env)) if (k.startsWith("PRISM_DEMO_") || k === "PRISM_LIVE_TAVILY_CREDITS_PER_RUN") delete process.env[k];

const live = await import("../../src/app/server/live-run.ts");
const quota = await import("../../src/app/server/demo-quota.ts");
const opts = await import("../../src/app/server/live-options.ts");
const tav = await import("../../src/pipeline/evidence/tavily.ts");
const { ensureAccessSchema, upsertProjectAccess } = await import("../../src/app/server/access-store.ts");
const { ensureReportViewSchema, readReportView } = await import("../../src/report/store.ts");
const { loadGateFile, resolveGatesPath } = await import("../../src/pipeline/coding/contract.ts");
const { A9_ITEMS, a9Section } = await import("../../src/pipeline/signoff/a9.ts");
const { evaluateClaim, loadBundledGates } = await import("../../vendor/ai-output-to-value/packages/mcp/src/core.mjs");
const crypto = await import("node:crypto");

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const SERVER_TAVILY = "tvly-SERVERTAVILYKEY-9a8b7c6d";
const USER_TAVILY = "tvly-USERTAVILYKEY-1f2e3d4c";
const SERVER_KEY = "sk-SERVERKEY-000111222";
const USER_KEY = "uk-USERMODELKEY-7f3a9c1e5b2d";
const ORIGIN_HDR = new Headers({ origin: "http://127.0.0.1:3996" });
const HOST = "own-quota.example";
const ORIGIN = `https://${HOST}`;
const T0 = Date.parse("2026-10-24T10:00:00.000Z");

let db;
let dbFile;
let n = 0;
beforeEach(async () => {
  n += 1;
  dbFile = path.join(dataDir, `app-${n}.sqlite`);
  db = new Kysely({ dialect: new SqliteDialect({ database: new Database(dbFile) }) });
  await ensureAccessSchema(db);
  await ensureReportViewSchema(db);
  await live.ensureLiveRunSchema(db);
  await upsertProjectAccess(db, { projectId: "OWN1", title: "Show HN: Own – a test assistant", basis: "own", sponsorHold: false, inSample: false, liveBoundaryJson: JSON.stringify([{ host: HOST }]) });
});

const resolver = async () => ["93.184.216.34"];
const ENV = { PRISM_LIVE_RUN_CAP_USD: "1.00", TAVILY_API_KEY: SERVER_TAVILY, PRISM_KEY_DIR: dataDir };
const judge = (sessionId, accountId = "judges") => ({ user: { id: accountId }, session: { id: sessionId } });
/** A runner that makes no call at all: the limits are what is under test. */
const quick = async () => ({ projectRef: "OWN1", notAnalysed: "Not analysed: test." });
async function start(runner, options, { who = judge("s1"), env = {}, now = T0 } = {}) {
  return live.startLiveRunCore(who, ORIGIN_HDR, `${ORIGIN}/`, { db, runner, resolver, env: { ...process.env, ...ENV, ...env }, now: () => now }, options);
}
const jobs = async () => (await db.selectFrom("app_job").selectAll().execute()).length;

// ---- settings ----------------------------------------------------------------------

test("settings: names and defaults; garbage falls back to the default; nothing from the client", () => {
  assert.deepEqual(quota.demoLimitsFromEnv({}), {
    tavily: { totalCredits: 90, perAccountDay: 10, perSessionDay: 3, creditsPerRun: 10 },
    model: { perAccountDay: 20, perSessionDay: 5 },
  });
  const l = quota.demoLimitsFromEnv({ PRISM_DEMO_TAVILY_TOTAL_CREDITS: "40", PRISM_DEMO_MODEL_PER_SESSION_DAY: "x", PRISM_LIVE_TAVILY_CREDITS_PER_RUN: "6" });
  assert.equal(l.tavily.totalCredits, 40);
  assert.equal(l.model.perSessionDay, 5);
  assert.equal(l.tavily.creditsPerRun, 6);
  // The form's fields are a strict allow-list: a limit field is refused, not read.
  assert.equal(live.parseLiveOptions({ perSessionDay: 99 }), null);
  assert.equal(live.parseLiveOptions({ collector: "tavily", tavilyCredits: 99 }), null);
});

// ---- the three limits, before any external call -------------------------------------

test("per-session model limit: the 6th run in a session is refused before any job, with the limit and reset time", async () => {
  let calls = 0;
  const counting = async () => (calls++, { projectRef: "OWN1", notAnalysed: "x" });
  for (let i = 0; i < 5; i++) assert.ok((await start(quick, {}, { now: T0 + i * 1000 })).jobId);
  await live.whenIdle();
  const r = await start(counting, {}, { now: T0 + 10_000 });
  assert.equal(r.refused, "demo-limit");
  assert.deepEqual(r.limit, { kind: "model", limit: "session", of: 5, resetsAt: new Date(T0 + quota.DAY_MS).toISOString() });
  await live.whenIdle();
  assert.equal(calls, 0, "the runner never started");
  assert.equal(await jobs(), 5);
  const msg = opts.demoLimitMessage(r.limit, () => "Sat 21:30 ACDT");
  assert.equal(msg, "Not run: this session has used all 5 model runs on PRISM's demo budget in the last 24 hours. The next one frees up Sat 21:30 ACDT. Use your own Token Factory key (or an OpenRouter key), or read the recorded reports. Nothing was fetched.");
  // A second judge session on the same shared login still has its own 5.
  assert.ok((await start(quick, {}, { who: judge("s2"), now: T0 + 11_000 })).jobId);
});

test("per-account limit binds across sessions of one login", async () => {
  const env = { PRISM_DEMO_MODEL_PER_ACCOUNT_DAY: "3" };
  for (let i = 0; i < 3; i++) assert.ok((await start(quick, {}, { who: judge(`s${i}`), env, now: T0 + i })).jobId);
  const r = await start(quick, {}, { who: judge("s9"), env, now: T0 + 5 });
  assert.equal(r.refused, "demo-limit");
  assert.equal(r.limit.limit, "account");
  assert.equal(r.limit.of, 3);
  assert.match(opts.demoLimitMessage(r.limit, () => "later"), /this account has used all 3 model runs/);
  await live.whenIdle();
});

test("Tavily per-session limit and the total credit cap each stop a run before any Tavily call", async () => {
  const t = tavilyHost();
  const runner = realRunner({ tavily: t });
  for (let i = 0; i < 3; i++) {
    const r = await start(runner, { collector: "tavily" }, { now: T0 + i });
    assert.ok(r.jobId, JSON.stringify(r));
    await live.whenIdle();
  }
  const before = t.calls.length;
  const r = await start(runner, { collector: "tavily" }, { now: T0 + 10 });
  assert.equal(r.refused, "demo-limit");
  assert.equal(r.limit.kind, "tavily");
  assert.equal(r.limit.limit, "session");
  assert.equal(r.limit.of, 3);
  await live.whenIdle();
  assert.equal(t.calls.length, before, "no Tavily call after the refusal");

  // Total: with 90 credits and 10 reserved per run, the total binds when what is left is under 10.
  await db.insertInto("app_demo_usage").values({ kind: "tavily", account_id: "other", session_id: "other", at: new Date(T0).toISOString(), reserved: 10, actual: 85 }).execute();
  const r2 = await start(runner, { collector: "tavily" }, { who: judge("fresh", "fresh"), now: T0 + 20 });
  assert.equal(r2.refused, "demo-limit");
  assert.deepEqual(r2.limit, { kind: "tavily", limit: "total", of: 90, resetsAt: null });
  assert.match(opts.demoLimitMessage(r2.limit), /^Not run: PRISM's Tavily demo budget \(90 credits\) is used up\. Use your own Tavily key/);
  await live.whenIdle();
  assert.equal(t.calls.length, before);
  // The refusal gave back the model-run slot it had taken first.
  const fresh = await db.selectFrom("app_demo_usage").selectAll().where("session_id", "=", "fresh").execute();
  assert.equal(fresh.length, 0);
  // The form's notice for a spent total.
  const state = await live.readDemoState(db, { accountId: "fresh", sessionId: "fresh" }, { ...process.env, ...ENV }, T0 + 30);
  assert.equal(state.tavilyNotice, live.TAVILY_SPENT_NOTICE);
  assert.equal(state.tavily.totalLeft, 0);
});

test("the rolling window: a session's runs free up 24 h after each one (injected clock)", async () => {
  for (let i = 0; i < 5; i++) await start(quick, {}, { now: T0 + i * 60_000 });
  await live.whenIdle();
  assert.equal((await start(quick, {}, { now: T0 + quota.DAY_MS - 1 })).refused, "demo-limit");
  // The first run drops out exactly 24 h after it: one slot, then refused again.
  assert.ok((await start(quick, {}, { now: T0 + quota.DAY_MS + 1 })).jobId);
  assert.equal((await start(quick, {}, { now: T0 + quota.DAY_MS + 2 })).refused, "demo-limit");
  await live.whenIdle();
  const a = await quota.readAllowance(db, "model", { accountId: "judges", sessionId: "s1" }, quota.demoLimitsFromEnv({}), T0 + quota.DAY_MS + 3);
  assert.equal(a.sessionLeft, 0);
  assert.equal(a.sessionResetsAt, new Date(T0 + 60_000 + quota.DAY_MS).toISOString());
  assert.equal(opts.allowanceLine(a, () => "Sun 20:31"), "0 of 5 model runs left today on PRISM's demo budget; the next one frees up Sun 20:31.");
});

test("concurrent submissions cannot overshoot: session counts and the Tavily credit total", async () => {
  // 10 at once in one session: exactly 5 model runs get in.
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => start(quick, {}, { who: judge("burst", `burst-${i % 2}`), now: T0 + i })));
  assert.equal(rs.filter((r) => r.jobId).length, 5);
  assert.equal(rs.filter((r) => r.refused === "demo-limit").length, 5);
  await live.whenIdle();
  // Total 30 credits, 10 reserved each, 8 different sessions at once: exactly 3 get in, and the sum never passes 30.
  const env = { PRISM_DEMO_TAVILY_TOTAL_CREDITS: "30" };
  const ts = await Promise.all(Array.from({ length: 8 }, (_, i) => start(quick, { collector: "tavily" }, { who: judge(`t${i}`, `a${i}`), env, now: T0 + 100 + i })));
  assert.equal(ts.filter((r) => r.jobId).length, 3);
  assert.ok(ts.filter((r) => r.refused).every((r) => r.limit?.limit === "total"));
  assert.ok((await quota.tavilyCreditsUsed(db)) <= 30);
  await live.whenIdle();
});

test("the $ total still binds: a model-run slot taken before the ledger refusal is given back", async () => {
  await db.insertInto("app_spend_ledger").values({ scope: live.LEDGER_SCOPE, cap_usd: 0.1, spent_usd: 0.1, reserved_usd: 0 }).execute();
  assert.deepEqual(await start(quick, {}, { env: { PRISM_LIVE_RUN_CAP_USD: "0.10" } }), { refused: "budget" });
  assert.equal((await db.selectFrom("app_demo_usage").selectAll().execute()).length, 0);
  assert.equal(await jobs(), 0);
});

test("user-key runs bypass the demo limits but keep the per-run caps", async () => {
  const env = { PRISM_DEMO_MODEL_PER_SESSION_DAY: "0", PRISM_DEMO_TAVILY_PER_SESSION_DAY: "0" };
  assert.equal((await start(quick, {}, { env })).refused, "demo-limit");
  assert.equal((await start(quick, { modelKey: USER_KEY, collector: "tavily" }, { env })).refused, "demo-limit", "PRISM's Tavily still counts");
  // Both keys the user's own: no demo row, runs.
  const t = tavilyHost({ mapResults: 40 });
  const r = await start(realRunner({ tavily: t }), { modelKey: USER_KEY, tavilyKey: USER_TAVILY }, { env });
  assert.ok(r.jobId, JSON.stringify(r));
  await live.whenIdle();
  assert.equal((await db.selectFrom("app_demo_usage").selectAll().execute()).length, 0);
  const s = await live.readRunStatus(db, r.jobId);
  assert.equal(s.job.status, "done", s.job.message ?? "");
  assert.deepEqual(s.job.tavily, { credits: s.job.tavily.credits, paidBy: "your key" });
  assert.ok(s.job.tavily.credits <= 10, `per-run credit cap: ${s.job.tavily.credits}`);
  for (const c of t.calls) assert.equal(c.auth, `Bearer ${USER_TAVILY}`);
  const map = t.calls.find((c) => c.url.endsWith("/map"));
  assert.equal(map.body.limit, 20);
  for (const c of t.calls.filter((c) => c.url.endsWith("/extract"))) assert.ok(c.body.urls.length <= 10);
});

test("PRISM's Tavily key is used only when no user key is given, the demo budget remains and the key is configured", async () => {
  const t = tavilyHost({ mapResults: 40 });
  const r = await start(realRunner({ tavily: t }), { collector: "tavily" });
  assert.ok(r.jobId, JSON.stringify(r));
  await live.whenIdle();
  const s = await live.readRunStatus(db, r.jobId);
  assert.equal(s.job.status, "done", s.job.message ?? "");
  assert.ok(t.calls.length >= 2);
  for (const c of t.calls) assert.equal(c.auth, `Bearer ${SERVER_TAVILY}`);
  assert.equal(s.job.tavily.paidBy, "PRISM's key");
  // Ledger and receipt: credits and dollars per run with the key source, and what the demo budget has left.
  const credits = s.job.tavily.credits;
  assert.ok(credits > 0 && credits <= 10);
  assert.deepEqual(s.receipt.tavily, { credits, paidBy: "PRISM's key" });
  const rows = await db.selectFrom("app_demo_usage").selectAll().where("job_id", "=", r.jobId).orderBy("kind").execute();
  assert.deepEqual(rows.map((x) => [x.kind, x.reserved]), [["model", 0.1], ["tavily", 10]]);
  assert.equal(rows.find((x) => x.kind === "tavily").actual, credits);
  assert.equal(rows.find((x) => x.kind === "model").actual, s.job.spentUsd);
  assert.match(s.job.demoLeft, new RegExp(`^PRISM's demo budget left after this run: \\$\\d\\.\\d\\d of \\$1\\.00 for model calls; ${90 - credits} of 90 Tavily credits\\.$`));
  const view = await readReportView(db, "OWN1", "identifiable");
  assert.deepEqual(view.howMade.run.receipt.tavily, { credits, paidBy: "PRISM's key" });

  // A user key wins over PRISM's.
  const t2 = tavilyHost();
  const r2 = await start(realRunner({ tavily: t2 }), { collector: "tavily", tavilyKey: USER_TAVILY }, { now: T0 + 1 });
  await live.whenIdle();
  for (const c of t2.calls) assert.equal(c.auth, `Bearer ${USER_TAVILY}`);
  assert.equal((await live.readRunStatus(db, r2.jobId)).job.tavily.paidBy, "your key");

  // No server key configured: Tavily without a user key is refused, nothing runs.
  const t3 = tavilyHost();
  assert.deepEqual(await start(realRunner({ tavily: t3, serverKey: null }), { collector: "tavily" }, { env: { TAVILY_API_KEY: "" } }), { refused: "bad-option" });
  assert.equal(t3.calls.length, 0);

  await assertNoKey([SERVER_TAVILY, USER_TAVILY, SERVER_KEY, USER_KEY]);
});

// ---- lean collector --------------------------------------------------------------------

test("lean collector: map limit 20, extract the 10 most relevant (home, docs, pricing, security, about first)", async () => {
  const urls = ["blog/a", "about", "careers", "docs/start", "x1", "security", "pricing", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "x9", "logo.png"].map((p) => `${ORIGIN}/${p}`);
  assert.deepEqual(tav.leanOrder(`${ORIGIN}/`, urls).slice(0, 6), [`${ORIGIN}/`, `${ORIGIN}/docs/start`, `${ORIGIN}/pricing`, `${ORIGIN}/security`, `${ORIGIN}/about`, `${ORIGIN}/blog/a`]);
  const t = tavilyHost({ results: urls });
  const budget = new tav.CreditBudget(10);
  const r = await tav.collectProjectPages({ boundary: { host: HOST }, startUrl: `${ORIGIN}/`, apiKey: "k-test-0000", fetchImpl: t.fetchImpl, ...tav.LEAN, budget, prioritise: true });
  const map = t.calls.find((c) => c.url.endsWith("/map"));
  assert.equal(map.body.limit, 20);
  assert.equal(map.body.allow_external, false, "domain anchoring kept");
  assert.ok(map.body.select_domains[0].startsWith("^"), "anchored selector kept");
  const ex = t.calls.find((c) => c.url.endsWith("/extract"));
  assert.equal(ex.body.urls.length, 10);
  assert.deepEqual(ex.body.urls.slice(0, 5), [`${ORIGIN}/`, `${ORIGIN}/docs/start`, `${ORIGIN}/pricing`, `${ORIGIN}/security`, `${ORIGIN}/about`]);
  assert.ok(!ex.body.urls.includes(`${ORIGIN}/logo.png`));
  assert.ok(r.creditsSpent <= 10);
});

test("credit estimate: a call that would break the per-run cap is refused before it is sent", async () => {
  const t = tavilyHost({ mapResults: 40 });
  // Cap 3: map (2 credits for 20) fits; extract of 10 basic (2 credits) would make 4: refused, never sent.
  const budget = new tav.CreditBudget(3);
  const r = await tav.collectProjectPages({ boundary: { host: HOST }, startUrl: `${ORIGIN}/`, apiKey: "k-test-0000", fetchImpl: t.fetchImpl, ...tav.LEAN, budget, prioritise: true });
  assert.equal(t.calls.filter((c) => c.url.endsWith("/extract")).length, 0);
  assert.ok(r.calls.some((c) => c.refused && /exceed the credit ceiling/.test(c.reason)));
  assert.ok(budget.tally <= 3);
  // Cap 1: even the map is refused.
  const t2 = tavilyHost();
  await tav.collectProjectPages({ boundary: { host: HOST }, startUrl: `${ORIGIN}/`, apiKey: "k-test-0000", fetchImpl: t2.fetchImpl, ...tav.LEAN, budget: new tav.CreditBudget(1) });
  assert.equal(t2.calls.length, 0);
  // A shared budget carries across calls: the second call sees what the first spent.
  const shared = new tav.CreditBudget(10);
  shared.record({ formula: 9 });
  const t3 = tavilyHost();
  await tav.collectProjectPages({ boundary: { host: HOST }, startUrl: `${ORIGIN}/`, apiKey: "k-test-0000", fetchImpl: t3.fetchImpl, ...tav.LEAN, budget: shared });
  assert.equal(t3.calls.length, 0);
});

test("robots.txt first still applies to PRISM's Tavily key", async () => {
  const t = tavilyHost();
  const r = await start(realRunner({ tavily: t, robots: "User-agent: *\nDisallow: /\n" }), { collector: "tavily" });
  await live.whenIdle();
  await live.readRunStatus(db, r.jobId);
  assert.equal(t.calls.length, 0);
});

// ---- helpers ---------------------------------------------------------------------------

function tavilyHost({ mapResults = 1, results = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), auth: init.headers?.authorization ?? null, body });
    if (String(url).endsWith("/map")) {
      const list = results ?? Array.from({ length: mapResults }, (_, i) => (i === 0 ? `${ORIGIN}/` : `${ORIGIN}/p${i}`));
      const out = list.slice(0, body.limit);
      return new Response(JSON.stringify({ results: out, usage: { credits: Math.ceil(out.length / 10) } }), { status: 200 });
    }
    const ok = body.urls.map((u) => ({ url: u, raw_content: "The assistant drafts replies with a model. ".repeat(40) }));
    return new Response(JSON.stringify({ results: ok, failed_results: [], usage: { credits: Math.ceil(ok.length / 5) } }), { status: 200 });
  };
  return { fetchImpl, calls };
}

const checkIds = loadGateFile(resolveGatesPath()).checkIds;
function modelFetch() {
  return async (_url, init = {}) => {
    const body = JSON.parse(init.body);
    const name = body.response_format?.json_schema?.name;
    const reply = (content) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
    if (name === "screen") return reply({ include: true, reasonCode: null });
    if (name === "confirm") return reply({ decision: "confirmed", reason: "p1-x shows it." });
    const user = body.messages.find((m) => m.role === "user").content;
    const ids = [...user.matchAll(/^(p\d+-[^:\s]+):/gm)].map((m) => m[1]);
    return reply({ checks: checkIds.map((checkId, k) => (k < 3 && ids[k] ? { checkId, proposedState: "pass", spanIds: [ids[k]] } : { checkId, proposedState: "unknown", spanIds: [] })) });
  };
}
const PAGE = `<html><body><main><h1>Own product</h1>${"<p>The assistant drafts replies with a model; a test suite of 120 cases runs on every change.</p>".repeat(12)}</main></body></html>`;
function siteFetch(robots) {
  return async (url) => {
    const u = new URL(url);
    if (u.host !== HOST) return new Response("nf", { status: 404 });
    if (u.pathname === "/robots.txt") return new Response(robots, { status: 200, headers: { "content-type": "text/plain" } });
    return new Response(PAGE, { status: 200, headers: { "content-type": "text/html" } });
  };
}
const gateSpawnImpl = (_py, args) => {
  const record = JSON.parse(fs.readFileSync(args[2], "utf8"));
  const status = evaluateClaim(record, loadBundledGates()).status;
  return { status: status === "PASS" ? 0 : 1, stdout: JSON.stringify({ status }), stderr: "" };
};
const a9Digest = crypto.createHash("sha256").update(a9Section(fs.readFileSync("protocol/PROTOCOL.md", "utf8"))).digest("hex");
function realRunner({ tavily, robots = "User-agent: *\nAllow: /\n", serverKey = SERVER_TAVILY }) {
  return live.createRealRunner({
    apiKey: SERVER_KEY,
    githubToken: "gh-test",
    modelFetch: modelFetch(),
    userModelFetch: modelFetch(),
    tavilyFetch: tavily.fetchImpl,
    serverTavilyKey: serverKey ?? undefined,
    siteFetch: siteFetch(robots),
    githubFetch: async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
    gateSpawnImpl,
    pythonPath: "js-gate",
    a9Lines: async () => A9_ITEMS.map((item) => JSON.stringify({ item, decision: "approved", docDigest: a9Digest })),
    scratchRoot: path.join(dataDir, "live"),
  });
}
/** Byte scan of the database file and every table this feature writes. */
async function assertNoKey(keys) {
  const files = [dbFile, `${dbFile}-wal`, `${dbFile}-journal`].filter((f) => fs.existsSync(f));
  const bytes = Buffer.concat(files.map((f) => fs.readFileSync(f)));
  const dump = JSON.stringify({
    jobs: await db.selectFrom("app_job").selectAll().execute(),
    events: await db.selectFrom("app_job_event").selectAll().execute(),
    demo: await db.selectFrom("app_demo_usage").selectAll().execute(),
    ledger: await db.selectFrom("app_spend_ledger").selectAll().execute(),
    usage: await db.selectFrom("app_job_usage").selectAll().execute(),
  });
  for (const k of keys) {
    assert.equal(bytes.indexOf(Buffer.from(k)), -1, "key bytes in the database file");
    assert.ok(!dump.includes(k), "key in a table");
  }
}
