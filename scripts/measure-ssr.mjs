#!/usr/bin/env node
// D-78 (b): server CPU per route on the built app (`npm run build` first).
//   node scripts/measure-ssr.mjs
// Seeds a judge and an admin (random passwords through --password-stdin, never
// printed), materialises the synthetic corpus as e2e/serve.mjs does, starts
// scripts/serve.mjs with MEASURE_CPU=1, then requests each route 31 times one at
// a time (1 cold, 30 warm), reading the full body each time, and pairs each
// request with the server's own "MEASURE request" line. Prints one line per route:
//   MEASURE ssr route=<r> n=31 cold_ms=<first> p50_ms p95_ms max_ms (over the 30 warm)
// Every request carries its own client address through a trusted-proxy header, so
// better-auth's per-IP sign-in limit (3 per 10 s) never answers 429 instead of
// doing the work. Synthetic data only; the temp directory is removed at exit.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

const N = 31;
const CORPUS = "tests/fixtures/report/synthetic-corpus.json";
if (!fs.existsSync("dist/server/index.js")) {
  console.error("measure-ssr: run `npm run build` first");
  process.exit(2);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-measure-ssr-"));
fs.chmodSync(dir, 0o700);
const dataDir = path.join(dir, "data");
fs.mkdirSync(dataDir, { mode: 0o700 });
let child;
const cleanup = () => {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  fs.rmSync(dir, { recursive: true, force: true });
};
process.on("exit", cleanup);
const fail = (m) => {
  console.error(`measure-ssr: ${m}`);
  process.exit(1);
};

const port = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const { port: p } = s.address();
    s.close(() => resolve(p));
  });
});
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  NODE_ENV: "production",
  PORT: String(port),
  HOST: "127.0.0.1",
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  BETTER_AUTH_URL: base,
  TRUSTED_ORIGINS: base,
  PRISM_DATA_DIR: dataDir,
  PRISM_LIVE_RUNNER: "fixture",
  PRISM_LIVE_RUN_CAP_USD: "1.00",
  PRISM_TRUSTED_PROXY_HEADER: "x-measure-client",
  PRISM_TRUSTED_PROXY_IPS: "127.0.0.1",
  MEASURE_CPU: "1",
};

const accounts = { admin: { role: "admin" }, judge: { role: "judge" } };
for (const [key, a] of Object.entries(accounts)) {
  a.email = `${key}-${randomBytes(4).toString("hex")}@measure.example`;
  a.password = randomBytes(16).toString("hex");
  const seed = spawnSync(process.execPath, ["src/app/server/seed-account.ts", "--email", a.email, "--role", a.role, "--password-stdin"], { env, encoding: "utf8", input: `${a.password}\n` });
  if (seed.status !== 0) fail(`seeding ${key} failed (exit ${seed.status})`);
}
const keyFile = path.join(dir, "pseudonym.key");
fs.writeFileSync(keyFile, randomBytes(24).toString("hex"), { mode: 0o600 });
const dbFile = path.join(dataDir, "prism.sqlite");
const mat = spawnSync(process.execPath, ["scripts/materialize-views.mjs", "--fixture", CORPUS, "--db", dbFile, "--js-gate", "--deidentify", "--key-file", keyFile], { env, encoding: "utf8" });
if (mat.status !== 0 || !mat.stdout.includes("DEID scan hits=0")) fail(`materialising the synthetic corpus failed (exit ${mat.status})`);

const sq = new Database(dbFile, { readonly: true });
const pseudonym = sq.prepare("select pseudonym from app_project_access where project_id = 'P01'").get()?.pseudonym;
const hash = sq.prepare("select hash from app_snapshot where project_ref = 'P01' limit 1").get()?.hash;
sq.close();
if (!pseudonym || !hash) fail("no pseudonym or snapshot for P01 in the materialised store");

// Server lines: MEASURE request ... -> queue; anything else is passed through to stderr.
const measured = [];
child = spawn(process.execPath, ["scripts/serve.mjs"], { env, stdio: ["ignore", "pipe", "inherit"] });
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const m = /^MEASURE request method=(\S+) path=(\S+) status=(\d+) cpu_ms=([\d.]+)$/.exec(line);
    if (m) measured.push({ method: m[1], path: m[2], status: Number(m[3]), cpuMs: Number(m[4]) });
    else process.stderr.write(`${line}\n`);
  }
});
child.once("exit", (code) => code !== null && code !== 0 && fail(`server exited ${code}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let t = Date.now(); ; ) {
  try {
    await fetch(`${base}/sign-in`);
    break;
  } catch {
    if (Date.now() - t > 30_000) fail("server did not answer within 30 s");
    await sleep(250);
  }
}

// Let the readiness probe's own MEASURE line land, then start from an empty record.
await sleep(200);
measured.length = 0;

let ipN = 0;
const nextIp = () => {
  ipN += 1;
  return `10.${(ipN >> 16) & 255}.${(ipN >> 8) & 255}.${ipN & 255}`;
};

/** One request, body read to the end, paired with the server's MEASURE line for it. */
async function timed(method, urlPath, { cookie, body } = {}) {
  const before = measured.length;
  const res = await fetch(`${base}${urlPath}`, {
    method,
    redirect: "manual",
    headers: { "x-measure-client": nextIp(), origin: base, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  await res.arrayBuffer();
  const want = urlPath.split("?")[0];
  let m;
  for (let t = Date.now(); !(m = measured.slice(before).find((x) => x.path === want && x.method === method)); ) {
    if (Date.now() - t > 5000) fail(`no MEASURE line for ${method} ${urlPath}`);
    await sleep(2);
  }
  if (measured.length - before !== 1) fail(`${measured.length - before} MEASURE lines during one request to ${urlPath}`);
  if (res.status !== 200) fail(`${method} ${urlPath} returned ${res.status}`);
  return { res, cpuMs: m.cpuMs };
}

const cookieOf = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const report = (name, cpu) => {
  const warm = cpu.slice(1).sort((a, b) => a - b);
  const f = (x) => x.toFixed(1);
  console.log(`MEASURE ssr route=${name} n=${cpu.length} cold_ms=${f(cpu[0])} p50_ms=${f(pct(warm, 50))} p95_ms=${f(pct(warm, 95))} max_ms=${f(warm.at(-1))}`);
};

// Sign-in first, so its cold request is the server's first; its first session is the judge's.
const signInBody = (a) => ({ body: { email: a.email, password: a.password } });
const signInCpu = [];
let judge;
for (let i = 0; i < N; i += 1) {
  const { res, cpuMs } = await timed("POST", "/api/auth/sign-in/email", signInBody(accounts.judge));
  if (i === 0) judge = cookieOf(res);
  signInCpu.push(cpuMs);
}
report("sign-in-POST", signInCpu);
const admin = cookieOf((await timed("POST", "/api/auth/sign-in/email", signInBody(accounts.admin))).res);

const routes = [
  ["/", "/", judge],
  ["/p/<id>", "/p/P01", judge],
  ["/j/<pseudonym>", `/j/${pseudonym}`, judge],
  ["/method", "/method", judge],
  ["/p/<id>/snapshot/<hash>", `/p/P01/snapshot/${hash}`, judge],
  ["/run", "/run", admin],
];
for (const [name, urlPath, cookie] of routes) {
  const cpu = [];
  for (let i = 0; i < N; i += 1) cpu.push((await timed("GET", urlPath, { cookie })).cpuMs);
  report(name, cpu);
}
child.kill("SIGTERM");
