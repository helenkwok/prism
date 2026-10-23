// APP-05 (Helen's 07-03 choice P2, D-73 method): scripts/report-pdf.mjs prints the signed-in
// report offline into PRISM_DATA_DIR/exports/reports and refuses any path inside the repository.
// Exports go to a throwaway PRISM_DATA_DIR under the OS temp dir, never a real data directory.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { readCreds } from "./helpers.ts";
import type { Role } from "./helpers.ts";

const run = promisify(execFile);
const base = () => `http://127.0.0.1:${process.env.E2E_PORT}`;
const repoRoot = path.resolve(import.meta.dirname, "..");

test.describe("offline report PDF (scripts/report-pdf.mjs)", () => {
  let tmp: string;
  test.beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prism-pdf-"));
  });
  test.afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  async function reportPdf(role: Role, project: string, extra: string[] = []) {
    const { email, password } = readCreds()[role];
    const pw = path.join(tmp, `${role}.pw`);
    fs.writeFileSync(pw, password, { mode: 0o600 });
    const argv = ["scripts/report-pdf.mjs", "--base", base(), "--project", project, "--email", email, "--password-file", pw, ...extra];
    const env = { ...process.env, PRISM_DATA_DIR: path.join(tmp, "data") };
    try {
      const r = await run(process.execPath, argv, { cwd: repoRoot, env, timeout: 60_000 });
      return { code: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (err) {
      const e = err as { code: number; stdout: string; stderr: string };
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  }
  const exportsDir = () => path.join(tmp, "data", "exports", "reports");

  test("admin: writes PRISM_DATA_DIR/exports/reports/P01-<date>.pdf, mode 600, starting %PDF-", async () => {
    test.setTimeout(90_000);
    const r = await reportPdf("admin", "P01");
    expect(r.code, r.stderr).toBe(0);
    const file = path.join(exportsDir(), `P01-${new Date().toISOString().slice(0, 10)}.pdf`);
    expect(r.stdout).toContain(`PDF ${fs.realpathSync(file)}`);
    expect(fs.readFileSync(file).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  test("an --out inside the repository is refused and nothing is written there", async () => {
    const inside = path.join(repoRoot, "dist", "P01-refused.pdf");
    const r = await reportPdf("admin", "P01", ["--out", inside]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("inside the repository");
    expect(fs.existsSync(inside)).toBe(false);
  });

  test("company B gets no PDF of P01: the report's own guard refuses it", async () => {
    test.setTimeout(90_000);
    const out = path.join(tmp, "companyB-P01.pdf");
    const r = await reportPdf("companyB", "P01", ["--out", out]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("HTTP 403");
    expect(fs.existsSync(out)).toBe(false);
  });

  test("a password file readable by others is refused before sign-in", async () => {
    const pw = path.join(tmp, "loose.pw");
    fs.writeFileSync(pw, "x", { mode: 0o644 });
    const argv = ["scripts/report-pdf.mjs", "--base", base(), "--project", "P01", "--email", "a@e2e.example", "--password-file", pw];
    const err = await run(process.execPath, argv, { cwd: repoRoot, env: { ...process.env, PRISM_DATA_DIR: path.join(tmp, "data") } }).catch(
      (e) => e as { code: number; stderr: string },
    );
    expect((err as { code: number }).code).toBe(1);
    expect((err as { stderr: string }).stderr).toContain("mode 600");
  });
});
