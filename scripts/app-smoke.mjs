// Smoke check for the built app. Node built-ins only.
//   node scripts/app-smoke.mjs --spawn        start .output/server/index.mjs and check it
//   node scripts/app-smoke.mjs --base <url> [--email <e> --password <p>]
//                                             check an already running server; the
//                                             credentials must already be seeded there
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
    anon.status >= 300 && anon.status < 400 && location.endsWith("/sign-in"),
    `status ${anon.status} location ${location}`,
  );

  // Skeleton PDF: read SQLite first, then takumi renders.
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
    // The seed script is the only account path: random credentials, never printed.
    creds = randomCreds();
    const seed = spawnSync(
      process.execPath,
      ["src/app/server/seed-account.ts", "--email", creds.email, "--role", "admin", "--password", creds.password],
      { env: serverEnv, encoding: "utf8" },
    );
    check("seed script created the account", seed.status === 0, (seed.stderr ?? "").trim());
    child = spawn(process.execPath, [".output/server/index.mjs"], {
      env: serverEnv,
      stdio: ["ignore", "inherit", "inherit"],
    });
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    const up = await waitFor(base, 30_000);
    check("built server answers within 30 seconds", up && !exited);
    if (up && !exited && seed.status === 0) await assertions(base, creds);
  } else {
    const email = flagValue("--email");
    const password = flagValue("--password");
    if (!email || !password) {
      console.error("--base mode needs --email and --password for an account seeded elsewhere");
      process.exit(2);
    }
    await assertions(base.replace(/\/$/, ""), { email, password });
  }
} catch (err) {
  check("smoke run completed", false, err instanceof Error ? err.message : String(err));
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
