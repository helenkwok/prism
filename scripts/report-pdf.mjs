// Per-project report PDF, offline (APP-05 as amended: Helen's 07-03 choice P2, the D-73 method).
// Runs on Helen's Mac only: Playwright is a dev dependency and the server image has no browser.
//
//   node scripts/report-pdf.mjs --base http://127.0.0.1:3000 --project P01 \
//     --email admin@example.org --password-file ~/.config/prism/admin.pw [--out /abs/file.pdf]
//
// Signs in through the auth API (password read from a mode-600 file, never argv), opens the
// signed-in report /p/<id> in print emulation and writes page.pdf() to
// PRISM_DATA_DIR/exports/reports/<id>-<YYYY-MM-DD>.pdf. Any output path inside the repository is
// refused, and nothing is written unless the report page itself answered 200: a user the app
// refuses gets no PDF.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, request } from "@playwright/test";
import { assertOutsideRepo, resolvePrivateDir, resolveRepoRoot } from "./check-data-dir.mjs";

function fail(message, code = 1) {
  process.stderr.write(`report-pdf: ${message}\n`);
  process.exit(code);
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      base: { type: "string" },
      project: { type: "string" },
      email: { type: "string" },
      "password-file": { type: "string" },
      out: { type: "string" },
    },
  }));
} catch (err) {
  fail(err.message, 2);
}
const { base, project, email } = args;
if (!base || !project || !email || !args["password-file"]) {
  fail("usage: --base <url> --project <id> --email <email> --password-file <file> [--out <file.pdf>]", 2);
}
let origin;
try {
  const u = new URL(base);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
  origin = u.origin;
} catch {
  fail(`--base must be an http(s) URL`, 2);
}
// The id becomes a URL segment and a file name.
if (!/^[A-Za-z0-9_-]{1,64}$/.test(project)) fail("--project must be letters, digits, _ or -", 2);

// Output path first, so a refused path never costs a sign-in.
const repoRoot = resolveRepoRoot();
let out;
try {
  if (args.out) {
    if (!path.isAbsolute(args.out)) fail("--out must be an absolute path", 2);
    out = path.join(assertOutsideRepo(path.dirname(args.out), repoRoot), path.basename(args.out));
  } else {
    const dir = assertOutsideRepo(path.join(resolvePrivateDir(process.env, repoRoot), "exports", "reports"), repoRoot);
    out = path.join(dir, `${project}-${new Date().toISOString().slice(0, 10)}.pdf`);
  }
} catch (err) {
  fail(err.code === "DATA_DIR_INSIDE_REPO" ? "refused: the output path is inside the repository" : err.message);
}
if (!out.endsWith(".pdf")) fail("--out must end in .pdf", 2);

const pwFile = args["password-file"].replace(/^~(?=\/)/, process.env.HOME ?? "~");
let stat;
try {
  stat = fs.statSync(pwFile);
} catch {
  fail("cannot read the password file");
}
if ((stat.mode & 0o077) !== 0) fail("the password file must be mode 600 (chmod 600 <file>)");
const password = fs.readFileSync(pwFile, "utf8").replace(/\r?\n$/, "");

const api = await request.newContext({ baseURL: origin });
const signIn = () =>
  api.post("/api/auth/sign-in/email", {
    data: { email, password },
    headers: { origin },
  });
let res = await signIn();
if (res.status() === 429) {
  // better-auth's sign-in limit (3 per 10 s per client): wait out the window once.
  const wait = Math.min(Number(res.headers()["x-retry-after"]) || 10, 30);
  await new Promise((r) => setTimeout(r, wait * 1000 + 250));
  res = await signIn();
}
if (res.status() !== 200) fail(`sign-in refused (HTTP ${res.status()})`);
const storageState = await api.storageState();
await api.dispose();

const browser = await chromium.launch();
let refused = null;
try {
  const page = await (await browser.newContext({ storageState, baseURL: origin })).newPage();
  const resp = await page.goto(`/p/${project}`, { waitUntil: "networkidle" });
  const landed = new URL(page.url()).pathname;
  if (!resp || resp.status() !== 200 || landed !== `/p/${project}`) {
    refused = `report not available to this account (HTTP ${resp?.status() ?? "none"}, ${landed}); no PDF written`;
  } else {
    await page.emulateMedia({ media: "print", colorScheme: "light" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });
    fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    fs.writeFileSync(out, pdf, { mode: 0o600 });
    fs.chmodSync(out, 0o600);
    process.stdout.write(`PDF ${out} bytes=${pdf.length}\n`);
  }
} finally {
  await browser.close();
}
if (refused) fail(refused);
