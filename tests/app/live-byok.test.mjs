// BYOK (Helen, 2026-10-24): a user's own model key (Token Factory, or OpenRouter as the alternative)
// and Tavily key for one live run. No real network: every reply is injected. Covers key reach,
// key leaks (byte scan of the database file, events, ledger, logs), redaction, the allow-lists,
// the server key's fixed Token Factory route, the spent-cap path, the receipt (J2) and the queue (J7).
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-byok-"));
process.env.PRISM_DATA_DIR = dataDir;
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3997";
delete process.env.TRUSTED_ORIGINS;

const live = await import("../../src/app/server/live-run.ts");
const { ensureAccessSchema, upsertProjectAccess } = await import("../../src/app/server/access-store.ts");
const { ensureReportViewSchema, readReportView } = await import("../../src/report/store.ts");
const { loadGateFile, resolveGatesPath } = await import("../../src/pipeline/coding/contract.ts");
const { A9_ITEMS, a9Section } = await import("../../src/pipeline/signoff/a9.ts");
const { OPENROUTER_MODEL_MAP } = await import("../../src/pipeline/validate/providers.ts");
const { evaluateClaim, loadBundledGates } = await import("../../vendor/ai-output-to-value/packages/mcp/src/core.mjs");
const crypto = await import("node:crypto");

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const USER_KEY = "uk-USERMODELKEY-7f3a9c1e5b2d";
const TAVILY_KEY = "tvly-USERTAVILYKEY-4e8d2a6c";
const SERVER_KEY = "sk-SERVERKEY-000111222";
const ORIGIN_HDR = new Headers({ origin: "http://127.0.0.1:3997" });

const HOST = "own-byok.example";
const ORIGIN = `https://${HOST}`;
const PAGE = `<html><body><main><h1>Own product</h1>${"<p>The assistant drafts replies with a model; a test suite of 120 cases runs on every change.</p>".repeat(12)}</main></body></html>`;
function siteFetchWith(robots = "User-agent: *\nAllow: /\n") {
  return async (url) => {
    const u = new URL(url);
    if (u.host !== HOST) return new Response("nf", { status: 404 });
    if (u.pathname === "/robots.txt") return new Response(robots, { status: 200, headers: { "content-type": "text/plain" } });
    if (u.pathname === "/") return new Response(PAGE, { status: 200, headers: { "content-type": "text/html" } });
    return new Response("nf", { status: 404 });
  };
}
const githubFetch = async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });

const checkIds = loadGateFile(resolveGatesPath()).checkIds;
const ultraOr = OPENROUTER_MODEL_MAP["nvidia/Nemotron-3-Ultra-550b-a55b"];
/** One fake model host: records URL, Authorization and model of every call. */
function modelHost({ codingUsage = null, failWith = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/models")) {
      calls.push({ url: u, auth: init.headers?.authorization ?? null, model: null });
      return new Response(JSON.stringify({ data: Object.values(OPENROUTER_MODEL_MAP).map((id) => ({ id, pricing: { prompt: "0.000001", completion: "0.000002" } })) }), { status: 200 });
    }
    const body = JSON.parse(init.body);
    calls.push({ url: u, auth: init.headers?.authorization ?? null, model: body.model });
    if (failWith) return failWith(init);
    const name = body.response_format?.json_schema?.name;
    const reply = (content, usage = { prompt_tokens: 10, completion_tokens: 5 }) =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage }), { status: 200 });
    if (name === "screen") return reply({ include: true, reasonCode: null });
    if (name === "confirm") return reply({ decision: "confirmed", reason: "p1-x shows it." });
    const user = body.messages.find((m) => m.role === "user").content;
    const ids = [...user.matchAll(/^(p\d+-[^:\s]+):/gm)].map((m) => m[1]);
    const checks = checkIds.map((checkId, k) => (k < 3 && ids[k] ? { checkId, proposedState: "pass", spanIds: [ids[k]] } : { checkId, proposedState: "unknown", spanIds: [] }));
    return reply({ checks }, codingUsage ?? undefined);
  };
  return { fetchImpl, calls };
}
function tavilyHost() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), auth: init.headers?.authorization ?? null });
    if (String(url).endsWith("/map")) return new Response(JSON.stringify({ results: [`${ORIGIN}/`], usage: { credits: 1 } }), { status: 200 });
    return new Response(JSON.stringify({ results: [{ url: `${ORIGIN}/`, raw_content: "The assistant drafts replies with a model. ".repeat(40) }], failed_results: [], usage: { credits: 1 } }), { status: 200 });
  };
  return { fetchImpl, calls };
}

const gateSpawnImpl = (_py, args) => {
  const record = JSON.parse(fs.readFileSync(args[2], "utf8"));
  const status = evaluateClaim(record, loadBundledGates()).status;
  return { status: status === "PASS" ? 0 : 1, stdout: JSON.stringify({ status }), stderr: "" };
};
const a9Digest = crypto.createHash("sha256").update(a9Section(fs.readFileSync("protocol/PROTOCOL.md", "utf8"))).digest("hex");
const a9Lines = async () => A9_ITEMS.map((item) => JSON.stringify({ item, decision: "approved", docDigest: a9Digest }));

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
function realRunner({ model, user = model, tavily = tavilyHost(), site = siteFetchWith() }) {
  return live.createRealRunner({
    apiKey: SERVER_KEY,
    githubToken: "gh-test",
    modelFetch: model.fetchImpl,
    userModelFetch: user.fetchImpl,
    tavilyFetch: tavily.fetchImpl,
    siteFetch: site,
    githubFetch,
    gateSpawnImpl,
    pythonPath: "js-gate",
    a9Lines,
    scratchRoot: path.join(dataDir, "live"),
  });
}
async function start(runner, options, { cap = "1.00" } = {}) {
  return live.startLiveRunCore({ user: { id: "admin" } }, ORIGIN_HDR, `${ORIGIN}/`, { db, runner, resolver, env: { ...process.env, PRISM_LIVE_RUN_CAP_USD: cap } }, options);
}
/** Captures everything written to stdout and stderr while fn runs. */
async function captureLogs(fn) {
  const out = [];
  const ow = process.stdout.write.bind(process.stdout);
  const ew = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c, ...a) => (out.push(String(c)), ow(c, ...a));
  process.stderr.write = (c, ...a) => (out.push(String(c)), ew(c, ...a));
  try {
    return { result: await fn(), logs: out.join("") };
  } finally {
    process.stdout.write = ow;
    process.stderr.write = ew;
  }
}
/** Byte scan: the database file (and its WAL), every event, the job rows, the ledger and the logs. */
async function assertNoKey(logs, keys = [USER_KEY, TAVILY_KEY]) {
  const files = [dbFile, `${dbFile}-wal`, `${dbFile}-journal`].filter((f) => fs.existsSync(f));
  const bytes = Buffer.concat(files.map((f) => fs.readFileSync(f)));
  const dump = JSON.stringify({
    events: await db.selectFrom("app_job_event").selectAll().execute(),
    jobs: await db.selectFrom("app_job").selectAll().execute(),
    ledger: await db.selectFrom("app_spend_ledger").selectAll().execute(),
    usage: await db.selectFrom("app_job_usage").selectAll().execute(),
  });
  for (const k of keys) {
    assert.equal(bytes.indexOf(Buffer.from(k)), -1, "key bytes in the database file");
    assert.ok(!dump.includes(k), "key in events, jobs, ledger or usage");
    assert.ok(!logs.includes(k), "key in stdout/stderr");
  }
}

test("a user Token Factory key reaches that run's model calls only; the next run uses the server key", async () => {
  const model = modelHost();
  const { result: s, logs } = await captureLogs(async () => {
    const r = await start(realRunner({ model }), { modelKey: USER_KEY });
    assert.ok(r.jobId, JSON.stringify(r));
    await live.whenIdle();
    return live.readRunStatus(db, r.jobId);
  });
  assert.equal(s.job.status, "done", s.job.message ?? "");
  const chat = model.calls.filter((c) => c.model);
  assert.ok(chat.length >= 3);
  for (const c of chat) {
    assert.equal(c.auth, `Bearer ${USER_KEY}`);
    assert.ok(c.url.startsWith("https://api.tokenfactory.nebius.com/v1/"), c.url);
  }
  await assertNoKey(logs);
  assert.equal(s.job.paidBy, "your key");
  assert.equal(s.job.provider, "Nebius Token Factory");
  // The server cap was not touched; the user scope recorded the spend with keySource user.
  assert.equal((await live.readLedger(db)).spent, 0);
  const rows = await live.readLedgerRows(db);
  const userRow = rows.find((r) => r.keySource === "user");
  assert.ok(userRow && userRow.spent > 0 && userRow.provider === "token-factory", JSON.stringify(rows));

  const model2 = modelHost();
  const r2 = await start(realRunner({ model: model2 }), {});
  await live.whenIdle();
  assert.equal((await live.readRunStatus(db, r2.jobId)).job.paidBy, "PRISM's key");
  for (const c of model2.calls) assert.equal(c.auth, `Bearer ${SERVER_KEY}`);
});

test("OpenRouter is reachable only with a user key, by id; it uses the mapped models and the receipt names it", async () => {
  const user = modelHost();
  const server = modelHost();
  const r = await start(realRunner({ model: server, user }), { modelKey: USER_KEY, provider: "openrouter" });
  await live.whenIdle();
  const s = await live.readRunStatus(db, r.jobId);
  assert.equal(s.job.status, "done", s.job.message ?? "");
  assert.equal(server.calls.length, 0, "the server key was never used");
  const chat = user.calls.filter((c) => c.model);
  for (const c of chat) {
    assert.ok(c.url.startsWith("https://openrouter.ai/api/v1/"), c.url);
    assert.ok(Object.values(OPENROUTER_MODEL_MAP).includes(c.model), c.model);
    assert.equal(c.auth, `Bearer ${USER_KEY}`);
  }
  const models = user.calls.find((c) => c.url.endsWith("/models"));
  assert.equal(models.auth, null, "the price list is fetched without the key");
  assert.equal(s.job.provider, "OpenRouter");
  assert.equal(s.stages.find((x) => x.stage === "screen").detail, "Nemotron 3.5 Lightning on OpenRouter");
  assert.ok(s.receipt.lines.length >= 3);
  for (const l of s.receipt.lines) {
    assert.equal(l.provider, "OpenRouter");
    assert.equal(l.paidBy, "your key");
  }
  assert.ok(s.receipt.lines.some((l) => l.model === "Nemotron 3 Ultra" && l.stage === "confirm"));
  assert.ok(s.receipt.ultraEstimateUsd > 0);
  const view = await readReportView(db, "OWN1", "identifiable");
  assert.equal(view.howMade.run.provider, "OpenRouter");
  assert.equal(view.howMade.run.paidBy, "your key");
  assert.ok(view.howMade.run.receipt.lines.length >= 3);
  assert.ok(!JSON.stringify(view).includes(USER_KEY));
  assert.ok(ultraOr);
});

test("the server key always goes to Token Factory: no option routes it elsewhere", async () => {
  assert.equal(live.parseLiveOptions({ provider: "openrouter" }), null, "OpenRouter without a user key is refused");
  const model = modelHost();
  const r = await start(realRunner({ model }), { provider: "token-factory" });
  await live.whenIdle();
  const s = await live.readRunStatus(db, r.jobId);
  assert.equal(s.job.status, "done", s.job.message ?? "");
  for (const c of model.calls) assert.ok(c.url.startsWith("https://api.tokenfactory.nebius.com/v1/"), c.url);
  assert.deepEqual(await start(realRunner({ model }), { provider: "openrouter" }), { refused: "bad-option" });
});

test("allow-lists: an unknown provider, an unknown collector, a URL field or a bad key shape is refused before any job", async () => {
  const model = modelHost();
  const runner = realRunner({ model });
  for (const options of [
    { modelKey: USER_KEY, provider: "ollama" },
    { modelKey: USER_KEY, provider: "https://evil.example/v1" },
    { modelKey: USER_KEY, baseUrl: "https://evil.example/v1" },
    { modelKey: USER_KEY, provider: "openrouter", url: "https://evil.example" },
    { collector: "firecrawl", tavilyKey: TAVILY_KEY },
    { modelKey: "has space inside" },
    { modelKey: "short" },
    { modelKey: "x".repeat(600) },
    { collector: "tavily" },
  ]) {
    assert.deepEqual(await start(runner, options), { refused: "bad-option" }, JSON.stringify(Object.keys(options)));
  }
  assert.equal((await db.selectFrom("app_job").selectAll().execute()).length, 0);
  assert.equal(model.calls.length, 0);
});

test("a provider error that echoes the Authorization header never reaches the database or logs", async () => {
  const echo = (init) => new Response(`bad request; you sent Authorization: ${init.headers.authorization} and key ${USER_KEY}`, { status: 400 });
  const user = modelHost({ failWith: echo });
  const { result: s, logs } = await captureLogs(async () => {
    const r = await start(realRunner({ model: modelHost(), user }), { modelKey: USER_KEY });
    await live.whenIdle();
    return live.readRunStatus(db, r.jobId);
  });
  assert.equal(s.job.status, "error");
  await assertNoKey(logs);

  // A runner error that quotes the key verbatim is scrubbed by the queue itself.
  const leaky = async () => {
    throw new Error(`upstream said: Authorization: Bearer ${USER_KEY}; tavily ${TAVILY_KEY}`);
  };
  const { result: s2, logs: logs2 } = await captureLogs(async () => {
    const r = await start(leaky, { modelKey: USER_KEY, tavilyKey: TAVILY_KEY });
    await live.whenIdle();
    return live.readRunStatus(db, r.jobId);
  });
  assert.equal(s2.job.status, "error");
  assert.match(s2.job.message, /\[secret\]/);
  await assertNoKey(logs + logs2);
});

test("the run budget still stops a run on a user key", async () => {
  const user = modelHost({ codingUsage: { prompt_tokens: 5_000_000, completion_tokens: 5 } });
  const r = await start(realRunner({ model: modelHost(), user }), { modelKey: USER_KEY });
  await live.whenIdle();
  const s = await live.readRunStatus(db, r.jobId);
  assert.equal(s.job.status, "stopped");
  assert.equal(s.job.stopStage, "code");
});

test("Tavily runs only with a user Tavily key, robots.txt first; the free collector otherwise", async () => {
  const t1 = tavilyHost();
  const r1 = await start(realRunner({ model: modelHost(), tavily: t1 }), {});
  await live.whenIdle();
  assert.equal(t1.calls.length, 0, "no Tavily call without a key");
  assert.equal((await live.readRunStatus(db, r1.jobId)).job.collector, "own-site collector");

  const t2 = tavilyHost();
  const { result: s, logs } = await captureLogs(async () => {
    const r = await start(realRunner({ model: modelHost(), tavily: t2 }), { tavilyKey: TAVILY_KEY, collector: "tavily" });
    await live.whenIdle();
    return live.readRunStatus(db, r.jobId);
  });
  assert.equal(s.job.status, "done", s.job.message ?? "");
  assert.equal(s.job.collector, "Tavily");
  assert.ok(t2.calls.length >= 2);
  for (const c of t2.calls) assert.equal(c.auth, `Bearer ${TAVILY_KEY}`);
  await assertNoKey(logs);

  const t3 = tavilyHost();
  const r3 = await start(realRunner({ model: modelHost(), tavily: t3, site: siteFetchWith("User-agent: *\nDisallow: /\n") }), { tavilyKey: TAVILY_KEY });
  await live.whenIdle();
  await live.readRunStatus(db, r3.jobId);
  assert.equal(t3.calls.length, 0, "robots.txt disallows: Tavily is never called");
});

test("once the server cap is reached: no server-key call, the page says so, and a user-key run still works", async () => {
  await db.insertInto("app_spend_ledger").values({ scope: live.LEDGER_SCOPE, cap_usd: 0.1, spent_usd: 0.1, reserved_usd: 0 }).execute();
  const server = modelHost();
  assert.deepEqual(await start(realRunner({ model: server }), {}, { cap: "0.10" }), { refused: "budget" });
  assert.equal(server.calls.length, 0);
  const summary = live.budgetSummary({ configured: true, cap: 0.1, spent: 0.1, reserved: 0 });
  assert.equal(summary.notice, live.BUDGET_SPENT_NOTICE);
  assert.match(summary.notice, /shared demo budget is used up/);
  assert.match(summary.notice, /your own key/);

  const user = modelHost();
  const r = await start(realRunner({ model: server, user }), { modelKey: USER_KEY }, { cap: "0.10" });
  assert.ok(r.jobId, JSON.stringify(r));
  await live.whenIdle();
  assert.equal((await live.readRunStatus(db, r.jobId)).job.status, "done");
  assert.equal(server.calls.length, 0, "still no server-key call");
  assert.equal((await live.readLedger(db)).spent, 0.1, "the server ledger did not move");
});

test("J7: a second submit while one job runs gets position 1 and runs when the first ends", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const slow = async ({ emit }) => {
    await emit("screen", "running");
    await gate;
    await emit("screen", "done", "ok");
    return { projectRef: "OWN1", notAnalysed: "Not analysed: test." };
  };
  const quick = async () => ({ projectRef: "OWN1", notAnalysed: "Not analysed: test." });
  const a = await start(slow, {});
  await new Promise((r) => setTimeout(r, 20));
  const b = await start(quick, {});
  assert.equal(a.position, 0);
  assert.equal(b.position, 1);
  assert.equal(b.waitSeconds, 135);
  const sb = await live.readRunStatus(db, b.jobId);
  assert.equal(sb.job.status, "queued");
  assert.deepEqual(sb.queue, { position: 1, waitSeconds: 135 });
  release();
  await live.whenIdle();
  const done = await live.readRunStatus(db, b.jobId);
  assert.equal(done.job.status, "done");
  assert.equal(done.queue, null);
});
