// Smoke check for the built app. Node built-ins only.
//   node scripts/app-smoke.mjs --spawn        start scripts/serve.mjs (the built app) and check it
//   node scripts/app-smoke.mjs --base <url> --email <e> --password-file <mode-600 file>
//                                             check an already running server; the
//                                             credentials must already be seeded there.
//        [--forwarded-for <ip>]               send that X-Forwarded-For on every request
//        [--expect-fixture-notice]            require the fixture notice on GET / (synthetic rows loaded)
// Passwords never travel on argv and are never printed.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const spawnMode = args.includes("--spawn");
const baseIdx = args.indexOf("--base");
const baseArg = baseIdx >= 0 ? args[baseIdx + 1] : undefined;
const flagValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

if (spawnMode === (baseArg !== undefined)) {
  console.error("usage: app-smoke.mjs --spawn | --base <url>");
  process.exit(2);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/sign-in`);
      return true;
    } catch {
      await sleep(250);
    }
  }
  return false;
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
  if (!ok) failures += 1;
}

async function assertions(base, creds) {
  const res = await fetch(`${base}/sign-in`);
  const body = await res.text();
  const type = res.headers.get("content-type") ?? "";
  check("GET /sign-in returns 200", res.status === 200, `status ${res.status}`);
  check("GET /sign-in is HTML", type.includes("text/html"), type);
  check("GET /sign-in body contains Sign in", body.includes("Sign in"));

  const json = { "content-type": "application/json", origin: base };

  // Public sign-up must be refused with the disabled-sign-up code.
  const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      email: `x-${randomBytes(4).toString("hex")}@example.test`,
      password: randomBytes(12).toString("hex"),
      name: "x",
    }),
  });
  const signUpBody = await signUp.json().catch(() => ({}));
  check(
    "public sign-up refused with EMAIL_PASSWORD_SIGN_UP_DISABLED",
    signUp.status === 400 && signUpBody.code === "EMAIL_PASSWORD_SIGN_UP_DISABLED",
    `status ${signUp.status} code ${signUpBody.code}`,
  );

  // Wrong password is refused.
  const wrong = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ email: creds.email, password: `${creds.password}-wrong` }),
  });
  check("wrong password refused with a 4xx", wrong.status >= 400 && wrong.status < 500, `status ${wrong.status}`);

  // Seeded credentials sign in and set a session cookie.
  const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ email: creds.email, password: creds.password }),
  });
  const setCookie = signIn.headers.get("set-cookie") ?? "";
  check("seeded sign-in returns 200", signIn.status === 200, `status ${signIn.status}`);
  check("seeded sign-in sets a cookie", setCookie.length > 0);
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

  // Guarded page: with the session it shows the email, without it it redirects.
  const home = await fetch(`${base}/`, { headers: { cookie }, redirect: "manual" });
  const homeBody = await home.text();
  check("GET / with a session returns 200", home.status === 200, `status ${home.status}`);
  check("GET / with a session shows the signed-in email", homeBody.includes(creds.email));
  const anon = await fetch(`${base}/`, { redirect: "manual" });
  const location = anon.headers.get("location") ?? "";
  check(
    "GET / without a session redirects to /sign-in",
    anon.status >= 300 && anon.status < 400 && new URL(location, base).pathname === "/sign-in",
    `status ${anon.status} location ${location}`,
  );

  // Skeleton PDF: read SQLite first, then takumi renders.
  creds.cookie = cookie;
  const pdfRes = await fetch(`${base}/api/report.pdf`);
  const pdf = Buffer.from(await pdfRes.arrayBuffer());
  const pdfType = pdfRes.headers.get("content-type") ?? "";
  check("GET /api/report.pdf returns 200", pdfRes.status === 200, `status ${pdfRes.status}`);
  check("PDF content type is application/pdf", pdfType.startsWith("application/pdf"), pdfType);
  check("PDF starts with %PDF-", pdf.subarray(0, 5).toString("latin1") === "%PDF-");
  check("PDF is larger than 1000 bytes", pdf.length > 1000, `${pdf.length} bytes`);
  check("PDF holds no user data", !pdf.includes(Buffer.from(creds.email)));
  const text = spawnSync("pdftotext", ["-", "-"], { input: pdf, encoding: "utf8" });
  if (text.status === 0 && !text.error) {
    console.log(`INFO pdftotext shows SQLite version line: ${/SQLite version \d/.test(text.stdout)}`);
  }
}

/**
 * Base mode against a deployment (07-12c): noindex on a page and a static file, no
 * fixture runner on /run (PRISM_LIVE_RUNNER unset), and the fixture notice on the
 * project list while only synthetic rows are loaded.
 */
async function deployChecks(base, cookie) {
  const signInPage = await page(base, null, "/sign-in");
  check("STATE X-Robots-Tag on /sign-in is noindex, nofollow", signInPage.headers.get("x-robots-tag") === "noindex, nofollow", `${signInPage.status} ${signInPage.headers.get("x-robots-tag")}`);
  const asset = /(?:src|href)="(\/assets\/[^"]+)"/.exec(signInPage.body)?.[1];
  const assetRes = asset ? await fetch(`${base}${asset}`) : null;
  check("STATE X-Robots-Tag on a static asset is noindex, nofollow", assetRes?.status === 200 && assetRes.headers.get("x-robots-tag") === "noindex, nofollow", `${asset} ${assetRes?.status}`);
  const run = await page(base, cookie, "/run");
  check("DEPLOY /run shows no fixture-runner notice", run.status === 200 && !run.body.includes('data-notice="fixture"') && !run.body.includes("Fixture:"), `status ${run.status}`);
  // Only while the synthetic rows are loaded (07-12c until 07-14 replaces them).
  if (args.includes("--expect-fixture-notice")) {
    const home = await page(base, cookie, "/");
    check("DEPLOY / shows the fixture notice on the synthetic rows", home.status === 200 && home.body.includes("Synthetic test data."), `status ${home.status}`);
  }
}

// better-auth rate-limits sign-in (T-07-06); the smoke signs in five times, so
// on a 429 it waits the server's own retry-after once instead of loosening the limit.
async function signIn(base, email, password) {
  const attempt = () =>
    fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ email, password }),
    });
  let res = await attempt();
  if (res.status === 429) {
    const wait = Math.min(Number(res.headers.get("x-retry-after")) || 10, 30);
    await sleep(wait * 1000 + 250);
    res = await attempt();
  }
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { status: res.status, cookie };
}

// APP-01 / Pitfall 2: the admin plugin's endpoints answer every signed-in user,
// so judge and company sessions must be refused there while admin is served.
async function accessChecks(base, accounts) {
  const sessions = {};
  for (const role of ["admin", "judge", "company"]) {
    const s = await signIn(base, accounts[role].email, accounts[role].password);
    check(`ACCESS ${role} sign-in returns 200`, s.status === 200, `status ${s.status}`);
    sessions[role] = s.cookie;
  }
  const listUsers = (role) => fetch(`${base}/api/auth/admin/list-users`, { headers: { cookie: sessions[role] } });
  const setRole = (role) =>
    fetch(`${base}/api/auth/admin/set-role`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, cookie: sessions[role] },
      body: JSON.stringify({ userId: accounts.company.id, role: "admin" }),
    });
  for (const role of ["judge", "company"]) {
    const list = await listUsers(role);
    check(`ACCESS ${role} GET /api/auth/admin/list-users returns 403`, list.status === 403, `status ${list.status}`);
    const set = await setRole(role);
    check(`ACCESS ${role} POST /api/auth/admin/set-role returns 403`, set.status === 403, `status ${set.status}`);
  }
  const adminList = await listUsers("admin");
  const listed = await adminList.json().catch(() => ({}));
  check("ACCESS admin GET /api/auth/admin/list-users returns 200", adminList.status === 200, `status ${adminList.status}`);
  const company = (listed.users ?? []).find((u) => u.email === accounts.company.email);
  check("ACCESS company role unchanged after the refused set-role calls", company?.role === "company", `role ${company?.role}`);
  return sessions;
}

const CORPUS = "tests/fixtures/report/synthetic-corpus.json";
/** The report title the app shows: the product name from the launch title (view.ts productName). */
const productName = (t) => t.replace(/^\s*Show HN:\s*/i, "").split(/ – | - |:/)[0].trim();

/** Write the synthetic corpus (identifiable + de-identified views, access rows) into the server's database. */
function materialize(dataDir, env) {
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-smoke-key-"));
  const keyFile = path.join(keyDir, "pseudonym.key");
  fs.writeFileSync(keyFile, randomBytes(24).toString("hex"), { mode: 0o600 });
  const run = spawnSync(
    process.execPath,
    ["scripts/materialize-views.mjs", "--fixture", CORPUS, "--db", path.join(dataDir, "prism.sqlite"), "--js-gate", "--deidentify", "--key-file", keyFile],
    { env, encoding: "utf8" },
  );
  fs.rmSync(keyDir, { recursive: true, force: true });
  check("LIST synthetic corpus materialised with access rows", run.status === 0 && run.stdout.includes("DEID scan hits=0"), (run.stderr || run.stdout).trim().slice(-300));
}

async function page(base, cookie, p = "/") {
  const res = await fetch(`${base}${p}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
  return { status: res.status, body: await res.text(), headers: res.headers };
}

const mainOf = (html) => /<main[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "";
const h1Of = (html) => /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1]?.replace(/<[^>]+>/g, "") ?? "";
const nextValue = (html) => /name="next"[^>]*value="([^"]*)"|value="([^"]*)"[^>]*name="next"/.exec(html)?.slice(1).find((v) => v !== undefined);

// 07-UI-SPEC refused and forbidden states, sign-in return path, noindex (T-07-25..27).
async function stateChecks(base, sessions) {
  const r1 = await page(base, sessions.judge, "/review/1");
  const r399 = await page(base, sessions.judge, "/review/399");
  console.log(`INFO judge GET /review/1 status ${r1.status}`);
  check("STATE judge GET /review/1 answers status 403", r1.status === 403, `status ${r1.status}`);
  check("STATE judge GET /review/399 answers status 403", r399.status === 403, `status ${r399.status}`);
  check("STATE 403 page h1 is Not available to your account", h1Of(r1.body) === "Not available to your account", h1Of(r1.body));
  check("STATE 403 body has no /j/ address", !r1.body.includes("/j/") && !r399.body.includes("/j/"));
  check("STATE 403 page is identical for /review/1 and /review/399", mainOf(r1.body) !== "" && mainOf(r1.body) === mainOf(r399.body));
  check("STATE 403 page links Go to your projects and, for a judge, the method audit", r1.body.includes(">Go to your projects<") && r1.body.includes(">Open the method audit<"));
  const c403 = await page(base, sessions.company, "/review/1");
  check("STATE company 403 page has no method audit link", c403.status === 403 && c403.body.includes(">Go to your projects<") && !c403.body.includes(">Open the method audit<"), `status ${c403.status}`);

  const anon = await page(base, null, "/");
  check("STATE anonymous GET / redirects to /sign-in?next=%2F", anon.status >= 300 && anon.status < 400 && anon.headers.get("location")?.endsWith("/sign-in?next=%2F"), `${anon.status} ${anon.headers.get("location")}`);
  const anonReview = await page(base, null, "/review/1");
  check("STATE anonymous GET /review/1 redirects with next", anonReview.headers.get("location")?.endsWith("/sign-in?next=%2Freview%2F1"), `${anonReview.status} ${anonReview.headers.get("location")}`);
  for (const [next, want] of [["//evil.example", "/"], ["/\\evil.example", "/"], ["https://evil.example/", "/"], ["/review/2", "/review/2"]]) {
    const si = await page(base, null, `/sign-in?next=${encodeURIComponent(next)}`);
    check(`STATE /sign-in?next=${next} returns to ${want}`, nextValue(si.body) === want, `got ${nextValue(si.body)}`);
  }

  const nf = await page(base, sessions.judge, "/no-such-page");
  check("STATE GET /no-such-page answers 404", nf.status === 404, `status ${nf.status}`);
  check("STATE 404 page h1 is Page not found", h1Of(nf.body) === "Page not found", h1Of(nf.body));
  const nfAnon = await page(base, null, "/no-such-page");
  check("STATE anonymous GET /no-such-page answers 404 with the 404 page", nfAnon.status === 404 && h1Of(nfAnon.body) === "Page not found", `status ${nfAnon.status}`);

  for (const [p, cookie] of [["/sign-in", null], ["/", sessions.admin], ["/api/report.pdf", null], ["/robots.txt", null], ["/review/1", sessions.judge], ["/no-such-page", null]]) {
    const res = await page(base, cookie, p);
    check(`STATE X-Robots-Tag on ${p} is noindex, nofollow`, res.headers.get("x-robots-tag") === "noindex, nofollow", `${res.status} ${res.headers.get("x-robots-tag")}`);
  }
  // Static files are served by serve.mjs, outside Start's middleware.
  const asset = /(?:src|href)="(\/assets\/[^"]+)"/.exec((await page(base, null, "/sign-in")).body)?.[1];
  const assetRes = asset ? await fetch(`${base}${asset}`) : null;
  check("STATE X-Robots-Tag on a static asset is noindex, nofollow", assetRes?.status === 200 && assetRes.headers.get("x-robots-tag") === "noindex, nofollow", `${asset} ${assetRes?.status}`);
  const robots = await page(base, null, "/robots.txt");
  check("STATE /robots.txt answers 200 text/plain with Disallow: /", robots.status === 200 && (robots.headers.get("content-type") ?? "").startsWith("text/plain") && robots.body.includes("User-agent: *") && robots.body.includes("Disallow: /"), `${robots.status} ${robots.headers.get("content-type")}`);
}

// APP-01 / 07-UI-SPEC project list: each role's GET / shows exactly the rows it may open.
async function listChecks(base, accounts, sessions) {
  const corpus = JSON.parse(fs.readFileSync(CORPUS, "utf8"));
  const name = Object.fromEntries(corpus.projects.map((p) => [p.projectId, productName(p.title)]));
  const fullTitle = Object.fromEntries(corpus.projects.map((p) => [p.projectId, p.title]));
  for (const key of ["companyA", "companyB"]) {
    const s = await signIn(base, accounts[key].email, accounts[key].password);
    check(`LIST ${key} sign-in returns 200`, s.status === 200, `status ${s.status}`);
    sessions[key] = s.cookie;
  }

  const judge = await page(base, sessions.judge);
  check("LIST judge GET / returns 200", judge.status === 200, `status ${judge.status}`);
  check("LIST judge sees the Identifiable records section", judge.body.includes("Identifiable records"));
  check("LIST judge sees the De-identified records section", judge.body.includes("De-identified records"));
  check("LIST judge sees the own and opt-in titles", judge.body.includes(name.P01) && judge.body.includes(name.P05));
  check("LIST judge sees why each record is identifiable", judge.body.includes("Owner&#x27;s project") && judge.body.includes("Opted in"));
  const deidIds = corpus.projects.map((p) => p.projectId).filter((id) => !["P01", "P05"].includes(id));
  const leaked = deidIds.filter((id) => judge.body.includes(name[id]) || judge.body.includes(fullTitle[id]));
  check("LIST judge never sees a de-identified project's title", leaked.length === 0, `leaked ${leaked.join(",")}`);
  const pseudonyms = [...judge.body.matchAll(/href="\/j\/([0-9A-Z]{5})"/g)].map((m) => m[1]);
  check("LIST judge sees 8 de-identified rows by pseudonym", new Set(pseudonyms).size === 8, `got ${new Set(pseudonyms).size}`);
  check("LIST judge sees no hold", !/hold/i.test(judge.body));
  check("LIST fixture notice shows above the list", judge.body.includes("Synthetic test data."));

  const a = await page(base, sessions.companyA);
  check("LIST company A sees only its own row", a.body.includes(name.P01) && !a.body.includes(name.P05) && !a.body.includes(name.P02));
  const b = await page(base, sessions.companyB);
  check("LIST company B sees only its own row", b.body.includes(name.P05) && !b.body.includes(name.P01));
  check("LIST company nav has no Method audit or Run a project", !a.body.includes(">Method audit<") && !a.body.includes(">Run a project<"));
  const none = await page(base, sessions.company);
  check("LIST company with no grant sees the empty state", none.body.includes("No project is linked to this account yet."));

  const admin = await page(base, sessions.admin);
  const allTitles = corpus.projects.every((p) => admin.body.includes(name[p.projectId]));
  check("LIST admin sees every project with the access column", allTitles && admin.body.includes("sponsor hold") && admin.body.includes("de-identified only"));
  check("LIST admin nav shows Run a project and Method audit", admin.body.includes(">Run a project<") && admin.body.includes(">Method audit<"));
  check("LIST judge nav shows Method audit, not Run a project", judge.body.includes(">Method audit<") && !judge.body.includes(">Run a project<"));
}

// Rate-limit keying (07-08a follow-up). Sign-ins for an unknown account: each one
// counts towards the limiter and answers 401 until the client's bucket is full.
async function signInAttempt(base, extraHeaders = {}) {
  const res = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, ...extraHeaders },
    body: JSON.stringify({ email: `nobody-${randomBytes(4).toString("hex")}@smoke.example`, password: randomBytes(12).toString("hex") }),
  });
  await res.arrayBuffer();
  return { status: res.status, retryAfter: Number(res.headers.get("x-retry-after")) };
}

/** Direct clients: a spoofed x-forwarded-for picks no bucket, and the limit is still 3 per 10 s. */
async function rateChecks(base) {
  // The smoke's own sign-ins came from the same client (127.0.0.1): start from an empty window.
  await sleep(10_500);
  const results = [];
  for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4"]) results.push(await signInAttempt(base, { "x-forwarded-for": ip }));
  const statuses = results.map((r) => r.status).join(",");
  console.log(`INFO RATE direct client statuses with spoofed x-forwarded-for: ${statuses}`);
  check("RATE spoofed x-forwarded-for from a direct client is ignored (4th attempt 429)", results[3].status === 429, statuses);
  check("RATE limit unchanged: 3 sign-ins pass the limiter, the 4th answers 429 within a 10 s window", results.slice(0, 3).every((r) => r.status === 401) && results[3].status === 429 && results[3].retryAfter > 0 && results[3].retryAfter <= 10, `${statuses} retry-after ${results[3].retryAfter}`);
}

/** Behind a trusted proxy (the smoke itself, from 127.0.0.1): each forwarded client gets its own bucket. */
async function proxyRateChecks(base) {
  const a = [];
  for (let i = 0; i < 4; i += 1) a.push(await signInAttempt(base, { "x-real-ip": "198.51.100.10" }));
  const b = await signInAttempt(base, { "x-real-ip": "198.51.100.20" });
  const statuses = `${a.map((r) => r.status).join(",")} then B ${b.status}`;
  console.log(`INFO RATE proxy client A then B: ${statuses}`);
  check("RATE client A reaches the limit (4th attempt 429)", a[3].status === 429 && a.slice(0, 3).every((r) => r.status === 401), statuses);
  check("RATE client B is not limited by client A's bucket", b.status === 401, statuses);
}

/**
 * D-79 on disk, run against the second boot on the first server's data directory:
 * its migrations were no-ops (a seeded account still signs in), and an online
 * backup of the live database verifies while it serves.
 */
async function diskChecks(base, accounts, env) {
  const res = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    // A client bucket of its own: the proxy rate checks filled the earlier ones.
    headers: { "content-type": "application/json", origin: base, "x-real-ip": "198.51.100.30" },
    body: JSON.stringify({ email: accounts.judge.email, password: accounts.judge.password }),
  });
  await res.arrayBuffer();
  check("DISK second boot on the same data directory signs in a seeded account", res.status === 200, `status ${res.status}`);

  const backup = spawnSync(process.execPath, ["scripts/export-hosted-db.mjs"], { env, encoding: "utf8" });
  const line = backup.stdout.trim();
  console.log(`INFO DISK ${line.replace(/ rows=.*/, "")}`);
  const users = Number(/(?:^|[ ,=])user:(\d+)/.exec(line)?.[1]);
  const file = /file=(\S+)/.exec(line)?.[1];
  const mode = file ? fs.statSync(path.join(env.PRISM_DATA_DIR, "backups", file)).mode & 0o777 : undefined;
  check("DISK backup of the live database passes integrity_check", backup.status === 0 && line.includes(" integrity=ok "), line || backup.stderr.trim());
  check("DISK backup user count equals the accounts seeded", users === Object.keys(accounts).length, `users ${users}`);
  check("DISK backup file mode is 600", mode === 0o600, `mode ${mode?.toString(8)}`);
}

/** A password file must grant no group or other access; one trailing newline is dropped. */
function readPasswordFile(file) {
  const mode = fs.statSync(file).mode;
  if ((mode & 0o077) !== 0) {
    throw new Error(`--password-file must not grant group or other access (chmod 600); mode is ${(mode & 0o777).toString(8)}`);
  }
  const password = fs.readFileSync(file, "utf8").replace(/\r?\n$/, "");
  if (!password) throw new Error("--password-file is empty");
  return password;
}

// Start the built server with a broken configuration and expect it to exit
// non-zero within 10 seconds, its output naming the failed setting. The
// process never stays alive: it is killed if it does not exit in time.
function bootRefusal(name, envOverrides, unset, expectText) {
  return new Promise((resolve) => {
    const env = { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", ...envOverrides };
    for (const key of unset) delete env[key];
    const proc = spawn(process.execPath, ["scripts/serve.mjs"], {
      env: { ...env, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      check(`${name}: exits non-zero within 10 seconds`, code !== null && code !== 0 && signal === null, `code ${code} signal ${signal}`);
      check(`${name}: output names ${expectText}`, out.includes(expectText), out.trim().slice(0, 200));
      resolve();
    });
  });
}

function randomCreds() {
  return {
    email: `smoke-${randomBytes(4).toString("hex")}@example.test`,
    password: randomBytes(16).toString("hex"),
  };
}

let child;
let dataDir;
let base = baseArg;
let creds;
try {
  if (spawnMode) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-smoke-"));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const serverEnv = {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOST: "127.0.0.1",
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      BETTER_AUTH_URL: base,
      TRUSTED_ORIGINS: base,
      PRISM_DATA_DIR: dataDir,
    };
    // The seed script is the only account path: random credentials, passed on
    // stdin (never argv) and never printed.
    const accounts = { admin: randomCreds(), judge: randomCreds(), company: randomCreds(), companyA: randomCreds(), companyB: randomCreds() };
    creds = accounts.admin;
    let seeded = true;
    // companyA and companyB each hold one grant; company holds none (empty state).
    const seedArgs = { companyA: ["--role", "company", "--grant", "P01"], companyB: ["--role", "company", "--grant", "P05"] };
    for (const key of ["admin", "judge", "company", "companyA", "companyB"]) {
      const seed = spawnSync(
        process.execPath,
        ["src/app/server/seed-account.ts", "--email", accounts[key].email, ...(seedArgs[key] ?? ["--role", key]), "--password-stdin"],
        { env: serverEnv, encoding: "utf8", input: `${accounts[key].password}\n` },
      );
      accounts[key].id = /id=([^,)]+)/.exec(seed.stdout ?? "")?.[1];
      const ok = seed.status === 0 && !`${seed.stdout}${seed.stderr}`.includes(accounts[key].password);
      check(`seed script created the ${key} account`, ok, (seed.stderr ?? "").trim());
      seeded &&= ok;
    }
    materialize(dataDir, serverEnv);
    child = spawn(process.execPath, ["scripts/serve.mjs"], {
      env: serverEnv,
      stdio: ["ignore", "inherit", "inherit"],
    });
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    const up = await waitFor(base, 30_000);
    check("built server answers within 30 seconds", up && !exited);
    if (up && !exited && seeded) {
      await assertions(base, creds);
      const sessions = await accessChecks(base, accounts);
      await listChecks(base, accounts, sessions);
      await stateChecks(base, sessions);
      // Last: these fill 127.0.0.1's sign-in bucket.
      await rateChecks(base);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    }

    // The same build behind a trusted proxy: the smoke plays the proxy from 127.0.0.1.
    const proxyPort = await freePort();
    const proxyBase = `http://127.0.0.1:${proxyPort}`;
    child = spawn(process.execPath, ["scripts/serve.mjs"], {
      env: {
        ...serverEnv,
        PORT: String(proxyPort),
        BETTER_AUTH_URL: proxyBase,
        TRUSTED_ORIGINS: proxyBase,
        PRISM_TRUSTED_PROXY_HEADER: "x-real-ip",
        PRISM_TRUSTED_PROXY_IPS: "127.0.0.1",
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (await waitFor(proxyBase, 30_000)) {
      await proxyRateChecks(proxyBase);
      await diskChecks(proxyBase, accounts, serverEnv);
    } else check("proxy-mode server answers within 30 seconds", false);

    // Boot refusals: a mis-configured server must stop, not serve.
    await bootRefusal(
      "no BETTER_AUTH_SECRET",
      { PRISM_DATA_DIR: dataDir },
      ["BETTER_AUTH_SECRET"],
      "BETTER_AUTH_SECRET",
    );
    await bootRefusal(
      "data directory inside the repo",
      { PRISM_DATA_DIR: path.join(process.cwd(), ".prism-smoke-data"), BETTER_AUTH_SECRET: randomBytes(32).toString("hex") },
      [],
      "PRISM_DATA_DIR",
    );
    check("in-repo data directory was not created", !fs.existsSync(path.join(process.cwd(), ".prism-smoke-data")));
  } else {
    if (args.includes("--password")) {
      console.error("passwords are never taken on the command line; use --password-file <mode-600 file>");
      process.exit(2);
    }
    const email = flagValue("--email");
    const passwordFile = flagValue("--password-file");
    if (!email || !passwordFile) {
      console.error("--base mode needs --email and --password-file for an account seeded elsewhere");
      process.exit(2);
    }
    // --forwarded-for <ip>: send this X-Forwarded-For on every request, to prove the
    // deployment never records a client-sent address (session-ip-check on the VM).
    const forwardedFor = flagValue("--forwarded-for");
    if (forwardedFor) {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (url, init = {}) => realFetch(url, { ...init, headers: { ...init.headers, "x-forwarded-for": forwardedFor } });
    }
    const target = { email, password: readPasswordFile(passwordFile) };
    await assertions(base.replace(/\/$/, ""), target);
    if (target.cookie) await deployChecks(base.replace(/\/$/, ""), target.cookie);
  }
} catch (err) {
  check("smoke run completed", false, err instanceof Error ? err.message : String(err));
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
