// Smoke check for the built app. Node built-ins only.
//   node scripts/app-smoke.mjs --spawn        start .output/server/index.mjs and check it
//   node scripts/app-smoke.mjs --base <url>   check an already running server
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const spawnMode = args.includes("--spawn");
const baseIdx = args.indexOf("--base");
const baseArg = baseIdx >= 0 ? args[baseIdx + 1] : undefined;

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

async function assertions(base) {
  const res = await fetch(`${base}/sign-in`);
  const body = await res.text();
  const type = res.headers.get("content-type") ?? "";
  check("GET /sign-in returns 200", res.status === 200, `status ${res.status}`);
  check("GET /sign-in is HTML", type.includes("text/html"), type);
  check("GET /sign-in body contains Sign in", body.includes("Sign in"));
}

let child;
let dataDir;
let base = baseArg;
try {
  if (spawnMode) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-smoke-"));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [".output/server/index.mjs"], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        HOST: "127.0.0.1",
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        PRISM_DATA_DIR: dataDir,
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    const up = await waitFor(base, 30_000);
    check("built server answers within 30 seconds", up && !exited);
    if (up && !exited) await assertions(base);
  } else {
    await assertions(base.replace(/\/$/, ""));
  }
} catch (err) {
  check("smoke run completed", false, err instanceof Error ? err.message : String(err));
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
