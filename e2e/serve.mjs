// Seeded server for the Playwright specs (playwright.config.ts webServer). Node built-ins only.
// 1. E2E_DIR (mode 700) holds a fresh data dir, the pseudonym key and creds.json (mode 600).
// 2. Seeds admin, judge, companyA (grant P01) and companyB (grant P02) with random
//    passwords through --password-stdin: never on argv, never printed.
// 3. Materialises the synthetic corpus with the JS gate; --deidentify also writes one
//    access row per project from its access block (basis, sponsor hold, in-sample, live boundary).
// 4. Starts the built server (scripts/serve.mjs) and removes E2E_DIR when it stops.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const port = process.env.E2E_PORT;
const dir = process.env.E2E_DIR;
if (!port || !dir) {
  console.error("e2e/serve.mjs: E2E_PORT and E2E_DIR come from playwright.config.ts");
  process.exit(2);
}
const base = `http://127.0.0.1:${port}`;
const CORPUS = "tests/fixtures/report/synthetic-corpus.json";

let child;
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  fs.rmSync(dir, { recursive: true, force: true });
}
process.on("exit", cleanup);
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    // Stop the server first; its exit handler below removes E2E_DIR and exits.
    if (child && child.exitCode === null && child.signalCode === null) child.kill(sig);
    else process.exit(0);
  });
}

function fail(message) {
  console.error(`e2e/serve.mjs: ${message}`);
  process.exit(1);
}

// A leftover directory from a killed run is replaced, never reused.
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { mode: 0o700 });
fs.chmodSync(dir, 0o700);
const dataDir = path.join(dir, "data");
fs.mkdirSync(dataDir, { mode: 0o700 });

const env = {
  ...process.env,
  NODE_ENV: "production",
  PORT: port,
  HOST: "127.0.0.1",
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  BETTER_AUTH_URL: base,
  TRUSTED_ORIGINS: base,
  PRISM_DATA_DIR: dataDir,
  PRISM_LIVE_RUNNER: "fixture",
  PRISM_LIVE_RUN_CAP_USD: "1.00",
};

const accounts = {
  admin: { role: "admin" },
  judge: { role: "judge" },
  companyA: { role: "company", grant: "P01" },
  companyB: { role: "company", grant: "P02" },
};
for (const [key, a] of Object.entries(accounts)) {
  a.email = `${key.toLowerCase()}-${randomBytes(4).toString("hex")}@e2e.example`;
  a.password = randomBytes(16).toString("hex");
  const argv = ["src/app/server/seed-account.ts", "--email", a.email, "--role", a.role, "--password-stdin"];
  if (a.grant) argv.push("--grant", a.grant);
  const seed = spawnSync(process.execPath, argv, { env, encoding: "utf8", input: `${a.password}\n` });
  if (seed.status !== 0) fail(`seeding ${key} failed (exit ${seed.status})`);
}

const keyFile = path.join(dir, "pseudonym.key");
fs.writeFileSync(keyFile, randomBytes(24).toString("hex"), { mode: 0o600 });
const mat = spawnSync(
  process.execPath,
  ["scripts/materialize-views.mjs", "--fixture", CORPUS, "--db", path.join(dataDir, "prism.sqlite"), "--js-gate", "--deidentify", "--key-file", keyFile],
  { env, encoding: "utf8" },
);
if (mat.status !== 0 || !mat.stdout.includes("DEID scan hits=0")) fail(`materialising the synthetic corpus failed (exit ${mat.status})`);

fs.writeFileSync(path.join(dir, "creds.json"), JSON.stringify(accounts, null, 2), { mode: 0o600 });
fs.chmodSync(path.join(dir, "creds.json"), 0o600);

child = spawn(process.execPath, ["scripts/serve.mjs"], { env, stdio: ["ignore", "inherit", "inherit"] });
child.once("exit", (code, signal) => {
  cleanup();
  process.exit(signal ? 0 : (code ?? 0));
});
