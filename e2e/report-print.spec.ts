// APP-05 (Helen's 07-03 choice P2, D-73 method): scripts/report-pdf.mjs prints the signed-in
// report offline into PRISM_DATA_DIR/exports/reports and refuses any path inside the repository.
// Exports go to a throwaway PRISM_DATA_DIR under the OS temp dir, never a real data directory.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { readCreds, stateFor } from "./helpers.ts";
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
    const argv = [
      "scripts/report-pdf.mjs",
      "--base",
      base(),
      "--project",
      project,
      "--email",
      email,
      "--password-file",
      pw,
      ...extra,
    ];
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
    const argv = [
      "scripts/report-pdf.mjs",
      "--base",
      base(),
      "--project",
      "P01",
      "--email",
      "a@e2e.example",
      "--password-file",
      pw,
    ];
    const err = await run(process.execPath, argv, {
      cwd: repoRoot,
      env: { ...process.env, PRISM_DATA_DIR: path.join(tmp, "data") },
    }).catch((e) => e as { code: number; stderr: string });
    expect((err as { code: number }).code).toBe(1);
    expect((err as { stderr: string }).stderr).toContain("mode 600");
  });
});

// 07-UI-SPEC "Print" with [P6]'s print rules: A4, 14 mm margins, root at 87.5%.
const MM = 96 / 25.4; // CSS px per mm
const A4 = { width: 210, height: 297 };
const MARGIN = 14;
const printable = { width: (A4.width - 2 * MARGIN) * MM, height: (A4.height - 2 * MARGIN) * MM };

test.describe("report print layout (/p/P01, admin)", () => {
  test.use({ storageState: ({}, use) => stateFor("admin").then(use) });
  test.beforeEach(async ({ page }) => {
    // Lay out at the printable width so line wrapping matches the A4 page.
    await page.setViewportSize({ width: Math.floor(printable.width), height: Math.floor(printable.height) });
    await page.goto("/p/P01");
    await page.emulateMedia({ media: "print", colorScheme: "light" });
  });

  test("header nav and skip link are not displayed; the fixture notice is", async ({ page }) => {
    for (const sel of ["header nav", 'a[href="#content"]']) {
      expect(await page.locator(sel).evaluate((e) => getComputedStyle(e).display), sel).toBe("none");
    }
    await expect(page.locator('[data-notice="fixture"]')).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("14px");
  });

  test("the signed-in email and role badge are not printed (shown on screen)", async ({ page }) => {
    const { email } = readCreds().admin;
    const role = page.locator("header").getByText("Admin", { exact: true });
    await page.emulateMedia({ media: "screen" });
    await expect(page.getByText(email)).toBeVisible();
    await expect(role).toBeVisible();
    await page.emulateMedia({ media: "print", colorScheme: "light" });
    await expect(page.getByText(email)).toBeHidden();
    await expect(role).toBeHidden();
  });

  test("interactive-only controls (Show checks, record toggles) are not printed", async ({ page }) => {
    const controls = [page.getByRole("link", { name: "Show checks" }), page.locator("summary")];
    await page.emulateMedia({ media: "screen" });
    for (const c of controls) {
      expect(await c.count()).toBeGreaterThan(0);
      await expect(c.first()).toBeVisible();
    }
    await page.emulateMedia({ media: "print", colorScheme: "light" });
    for (const c of controls) {
      const shown = await c.evaluateAll((els) => els.filter((e) => e.getClientRects().length > 0).length);
      expect(shown).toBe(0);
    }
  });

  test("the scope disclaimer ends within the first A4 page", async ({ page }) => {
    const bottom = await page
      .locator("[data-scope-disclaimer]")
      .evaluate((e) => e.getBoundingClientRect().bottom + window.scrollY);
    expect(bottom).toBeGreaterThan(0);
    expect(bottom).toBeLessThanOrEqual(printable.height);
    test
      .info()
      .annotations.push({
        type: "disclaimer bottom / page height (px)",
        description: `${bottom.toFixed(1)} / ${printable.height.toFixed(1)}`,
      });
  });

  test("every check card, quote card and the decisions block computes break-inside: avoid", async ({ page }) => {
    const values = await page
      .locator("[data-check-card], [data-quote-card], [data-decisions]")
      .evaluateAll((els) =>
        els.map(
          (e) =>
            `${e.getAttribute("data-check-card") !== null ? "check" : e.getAttribute("data-quote-card") !== null ? "quote" : "decisions"}:${getComputedStyle(e).breakInside}`,
        ),
      );
    expect(values.filter((v) => v.startsWith("check")).length).toBeGreaterThan(0);
    expect(values.filter((v) => v.startsWith("quote")).length).toBeGreaterThan(0);
    expect(values.filter((v) => v.startsWith("decisions")).length).toBe(1);
    for (const v of values) expect(v).toMatch(/:avoid$/);
  });

  test("page.pdf A4 gives at least one A4 page", async ({ page }) => {
    const pdf = (await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true })).toString("latin1");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    const pages = pdf.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? [];
    expect(pages.length).toBeGreaterThanOrEqual(1);
    const box = pdf.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
    expect(box).not.toBeNull();
    // A4 in points (72 per inch); Chromium rounds to whole CSS px.
    expect(Math.abs(Number(box![1]) - (A4.width * 72) / 25.4)).toBeLessThan(2);
    expect(Math.abs(Number(box![2]) - (A4.height * 72) / 25.4)).toBeLessThan(2);
    test.info().annotations.push({ type: "pages", description: String(pages.length) });
  });
});
