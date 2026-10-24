// APP-04 / SC3 / 07-UI-SPEC: the report reads gate first, in evidence language,
// with every quote linked to its archived snapshot and its live page.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "@playwright/test";
import { openEvidence, stateFor } from "./helpers.ts";

test.use({ storageState: ({}, use) => stateFor("admin").then(use) });

const BANNED = /\b(lack|missing|fail|non-compliant|blocked|compliant|certified|score)/i;
const DECISION_ORDER = ["explore", "rely", "operate", "measure-outcome", "scale-renew-stop"];
const card = (page: import("@playwright/test").Page, checkId: string) => page.locator(`[data-check="${checkId}"]`);

test("disclaimer precedes the Decisions block, which precedes the first check card; rows in gate order", async ({ page }) => {
  await page.goto("/p/P01");
  const order = await page.evaluate(() => {
    const before = (a: Element | null, b: Element | null) => !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const disclaimer = document.querySelector("[data-scope-disclaimer]");
    const decisions = document.querySelector("#decisions");
    const firstCard = document.querySelector("[data-check-card]");
    const firstVerdict = document.querySelector("[data-verdict-row]");
    return { a: before(disclaimer, decisions), b: before(decisions, firstCard), c: before(disclaimer, firstVerdict) };
  });
  expect(order).toEqual({ a: true, b: true, c: true });
  expect(await page.locator("[data-verdict-row]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-decision")))).toEqual(
    DECISION_ORDER,
  );
});

test("J1: each decision leads with its verdict and what would change it; the evidence follows, closed", async ({ page }) => {
  for (const id of ["P01", "P03", "P08", "P10"]) {
    await page.goto(`/p/${id}`);
    const rows = await page.locator("[data-verdict-row]").evaluateAll((rows) =>
      rows.map((r) => {
        const after = (a: Element | null, b: Element | null) => !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        const action = r.querySelector("[data-action]");
        const details = r.querySelector("details[data-evidence]") as HTMLDetailsElement | null;
        const cards = [...r.querySelectorAll("[data-check-card]")];
        return {
          decision: r.getAttribute("data-decision"),
          verdictBeforeAction: after(r.querySelector("[data-verdict-head] h3"), action),
          actionBeforeEvidence: !!details && cards.length > 0 && cards.every((c) => after(action, c) && details.contains(c)),
          closed: details?.open === false,
          // Every action item names a required check of this decision that is not publicly evidenced.
          actions: [...r.querySelectorAll("[data-action-item]")].map((a) => a.getAttribute("data-action-item")),
          notPass: [...document.querySelectorAll("[data-check-card]")].filter((c) => c.getAttribute("data-state") !== "pass").map((c) => c.getAttribute("data-check")),
        };
      }),
    );
    expect(rows.length).toBe(5);
    for (const r of rows) {
      expect(r.verdictBeforeAction, `${id} ${r.decision}`).toBe(true);
      expect(r.actionBeforeEvidence, `${id} ${r.decision}`).toBe(true);
      expect(r.closed, `${id} ${r.decision}`).toBe(true);
      for (const a of r.actions) expect(r.notPass, `${id} ${r.decision}`).toContain(a);
    }
  }
});

test("evaluative text uses evidence language; raw gate statuses only in data-gate-status", async ({ page }) => {
  for (const id of ["P01", "P03", "P08", "P10"]) {
    await page.goto(`/p/${id}`);
    const texts = await page.locator("[data-evaluative]").allInnerTexts();
    expect(texts.length).toBeGreaterThan(10);
    for (const t of texts) expect(t, `${id}: ${t}`).not.toMatch(BANNED);
    // The app's own visible text. Stored text is left out: quotes, and the gap block, which
    // until the 07-13 approval is the codebook pass rule verbatim (it names "gate result was PASS").
    const visible = await page.evaluate(() => {
      const main = document.querySelector("main")!.cloneNode(true) as HTMLElement;
      main.querySelectorAll("[data-gap], [data-action-gap], blockquote").forEach((e) => e.remove());
      return main.textContent ?? "";
    });
    expect(visible).not.toMatch(/\b(PASS|BLOCKED|INSUFFICIENT_EVIDENCE)\b/);
    // The app's own row text: the stored gap text (the codebook pass rule until approval) is left out.
    const rowTexts = await page.locator("[data-verdict-row]").evaluateAll((rows) =>
      rows.map((r) => {
        const c = r.cloneNode(true) as HTMLElement;
        c.querySelectorAll("[data-gap], [data-action-gap], blockquote").forEach((e) => e.remove());
        return c.textContent ?? "";
      }),
    );
    for (const row of rowTexts) expect(row).not.toMatch(/PASS|BLOCKED|INSUFFICIENT/);
    const statuses = await page.locator("[data-verdict-row]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-gate-status")));
    expect(statuses.every((s) => ["PASS", "BLOCKED", "INSUFFICIENT_EVIDENCE"].includes(s ?? ""))).toBe(true);
  }
  // P08 has a check its own page shows as not met.
  await page.goto("/p/P08");
  await expect(page.locator('[data-state="fail"]').first()).toContainText("own page shows the check is not met");
});

test("crosswalk chips name the standard once: the locator's leading word (or its singular) is not repeated", async ({ page }) => {
  await page.goto("/p/P01");
  await openEvidence(page);
  const chips = await page.locator("[data-chip]").allInnerTexts();
  expect(chips.length).toBeGreaterThan(0);
  for (const c of chips) {
    expect(c, c).not.toMatch(/\b(\w+) \1\b/);
    expect(c, c).not.toMatch(/\b(\w+)s \1\b/i); // "Principles Principle"
    expect(c, c).toMatch(/\S · \S/);
  }
  expect(chips.some((c) => c.startsWith("GAICC AIMS artefact: "))).toBe(true);
  expect(chips.some((c) => c.startsWith("OECD AI Principles 1.3 · "))).toBe(true);
  expect(chips.some((c) => c.startsWith("ISO/IEC 42001 "))).toBe(true);
});

test("quote cards: URL as truncated text with title, snapshot link with #span-, live link rel and target", async ({ page }) => {
  await page.goto("/p/P01");
  await openEvidence(page);
  const q = card(page, "output-reproducible").locator("[data-quote-card]").first();
  const url = q.locator("[data-quote-url]");
  await expect(url).toHaveText("https://p01.example/");
  await expect(url).toHaveAttribute("title", "https://p01.example/");
  expect(await url.evaluate((e) => getComputedStyle(e).textOverflow + " " + getComputedStyle(e).whiteSpace)).toBe("ellipsis nowrap");
  const snap = q.getByRole("link", { name: "Open archived snapshot" });
  await expect(snap).toHaveAttribute("href", /^\/p\/P01\/snapshot\/[0-9a-f]{64}\?check=output-reproducible#span-s001$/);
  const live = q.getByRole("link", { name: "Live page" });
  await expect(live).toHaveAttribute("href", "https://p01.example/");
  await expect(live).toHaveAttribute("rel", "noopener noreferrer nofollow");
  await expect(live).toHaveAttribute("target", "_blank");
});

test("no-quote line, gap text only off pass, awaiting confirmation", async ({ page }) => {
  await page.goto("/p/P01");
  await expect(card(page, "deliverable-gate-passed").locator("[data-no-quote]")).toHaveText(
    "No quote: no public evidence for this check was found on the collected pages.",
  );
  await expect(card(page, "deliverable-gate-passed").locator("[data-quote-card]")).toHaveCount(0);
  await expect(card(page, "output-reproducible").locator("[data-gap]")).toHaveCount(0);
  const gap = card(page, "failure-modes-tested").locator("[data-gap]");
  await expect(gap).toContainText("What would close this gap");
  await expect(card(page, "outcome-measure-defined").locator("[data-gap]")).toHaveCount(1);
  // Every non-pass card carries the gap block; no pass card does.
  const states = await page.locator("[data-check-card]").evaluateAll((cs) =>
    cs.map((c) => [c.getAttribute("data-state"), c.querySelector("[data-gap]") !== null]),
  );
  for (const [s, hasGap] of states) expect(hasGap).toBe(s !== "pass");
  const awaiting = card(page, "acceptance-criteria-met");
  await expect(awaiting).toHaveAttribute("data-state", "awaiting");
  await expect(awaiting).toContainText("awaiting confirmation");
  await expect(page.locator('[data-decision="rely"]')).toContainText("1 awaiting confirmation");
});

test("a quote holding markup characters renders literally", async ({ page }) => {
  await page.goto("/p/P01");
  const q = card(page, "output-reproducible").locator('[data-span="s012"] blockquote');
  await expect(q).toHaveText('Paste <script>alert("x")</script> & <b>bold</b> into the box; it is shown as text.');
  await expect(q.locator("script, b")).toHaveCount(0);
});

test("injection notice on the flagged quote; stale basis line", async ({ page }) => {
  await page.goto("/p/P03");
  const c = card(page, "intended-use-defined");
  await expect(c.locator('[data-span="s004"] [data-injection]')).toHaveText(
    "This page contained text addressed to an AI model. It was treated as page text and ignored as an instruction.",
  );
  await expect(c.locator('[data-span="s003"] [data-injection]')).toHaveCount(0);
  await expect(c.locator("[data-basis]")).toHaveText(
    "Confirmation is out of date: the collected evidence changed after it was confirmed.",
  );
});

test("not-rendered notice: count, and the server-wide reason", async ({ page }) => {
  await page.goto("/p/P01");
  await expect(page.locator("[data-not-rendered]")).toHaveText(
    "1 of 3 pages were collected without rendering, so text that a page loads with scripts may not have been captured.",
  );
  await page.goto("/p/P06");
  await expect(page.locator("[data-not-rendered]")).toHaveText(
    "This server collects pages without rendering, so text that a page loads with scripts may not have been captured.",
  );
  await page.goto("/p/P04");
  await expect(page.locator("[data-not-rendered]")).toHaveCount(0);
  await expect(page.getByText("· 0 pages")).toBeVisible();
});

test("fixture notice above the h1; robots meta noindex, nofollow", async ({ page }) => {
  await page.goto("/p/P01");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
  const above = await page.evaluate(() => {
    const n = document.querySelector('[data-notice="fixture"]');
    const h1 = document.querySelector("h1");
    return !!n && !!h1 && !!(n.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(above).toBe(true);
});

test("the Synthetic fixture label shows for fixture data and never for a real project", async ({ page }) => {
  await page.goto("/p/P09");
  await expect(page.locator('[data-notice="fixture"] [data-fixture-label]')).toHaveText("Synthetic fixture");
  // The same report stored as a real project (fixture false): no label, no notice.
  const db = new Database(path.join(process.env.E2E_DIR ?? "", "data", "prism.sqlite"));
  const row = db.prepare("select json from app_report_view where project_ref = 'P09' and view = 'identifiable'").get() as { json: string };
  try {
    db.prepare("update app_report_view set json = ? where project_ref = 'P09' and view = 'identifiable'").run(JSON.stringify({ ...JSON.parse(row.json), fixture: false }));
    await page.goto("/p/P09");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("[data-fixture-label]")).toHaveCount(0);
    await expect(page.getByText("Synthetic fixture")).toHaveCount(0);
  } finally {
    db.prepare("update app_report_view set json = ? where project_ref = 'P09' and view = 'identifiable'").run(row.json);
    db.close();
  }
});

// Snapshot view (Task 3). The unmatched-span case is the unit test tests/report/marks.test.mjs:
// every span in the synthetic corpus is found in its archived text.
const corpus = JSON.parse(fs.readFileSync("tests/fixtures/report/synthetic-corpus.json", "utf8"));
const pagesOf = (id: string): { url: string; snapshotHash: string }[] =>
  corpus.projects.find((p: { projectId: string }) => p.projectId === id).pages;

test("a quote's snapshot link lands on its marked span, focused, with the meta block and back links", async ({ page }) => {
  await page.goto("/p/P01");
  // A reader opens the evidence under the decision first.
  await page.locator('[data-verdict-row]:has([data-check="output-reproducible"]) details[data-evidence] > summary').click();
  await card(page, "output-reproducible").locator('[data-span="s012"]').getByRole("link", { name: "Open archived snapshot" }).click();
  await expect(page).toHaveURL(/\/p\/P01\/snapshot\/[0-9a-f]{64}\?check=output-reproducible#span-s012$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Archived page");
  const mark = page.locator("mark#span-s012");
  await expect(mark).toHaveText('Paste <script>alert("x")</script> & <b>bold</b> into the box; it is shown as text.');
  await expect(mark).toBeFocused();
  await expect(page.locator("[data-snapshot-text] script, [data-snapshot-text] b, iframe")).toHaveCount(0);
  const hash = pagesOf("P01")[2].snapshotHash;
  const meta = page.locator("[data-snapshot-meta]");
  await expect(meta).toContainText("https://p01.example/pricing");
  await expect(meta).toContainText("2026-10-11");
  await expect(meta).toContainText(hash.slice(0, 12));
  await expect(meta).not.toContainText(hash.slice(0, 13));
  await expect(meta.getByRole("link")).toHaveCount(0);
  await expect(page.locator('[data-notice="info"]')).toHaveText("Archived text as collected. Links, images and scripts are not reproduced.");
  const back = page.locator("[data-back]");
  await expect(back).toHaveCount(2);
  for (const href of await back.evaluateAll((as) => as.map((a) => a.getAttribute("href")))) expect(href).toBe("/p/P01#check-output-reproducible");
  // Every span the report cites on this page is marked; nothing else is.
  const p01 = corpus.projects.find((p: { projectId: string }) => p.projectId === "P01");
  const cited = new Set(Object.values(p01.cites as Record<string, string[]>).flat());
  const expected = Object.entries(p01.spans as Record<string, { snapshotHash: string }>)
    .filter(([id, s]) => cited.has(id) && s.snapshotHash === hash)
    .map(([id]) => `span-${id}`)
    .sort();
  expect(expected).toContain("span-s012");
  expect(await page.locator("mark").evaluateAll((ms) => ms.map((m) => m.id).sort())).toEqual(expected);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
});

test.describe("company A on snapshots", () => {
  test.use({ storageState: ({}, use) => stateFor("companyA").then(use) });

  test("opens its own snapshot; gets 403 on P02's and on P02's hash under its own project", async ({ page }) => {
    const own = pagesOf("P01")[0].snapshotHash;
    const other = pagesOf("P02")[0].snapshotHash;
    expect((await page.goto(`/p/P01/snapshot/${own}`))?.status()).toBe(200);
    expect((await page.goto(`/p/P02/snapshot/${other}`))?.status()).toBe(403);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Not available to your account");
    expect((await page.goto(`/p/P01/snapshot/${other}`))?.status()).toBe(403);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Not available to your account");
    await expect(page.locator("[data-snapshot-text]")).toHaveCount(0);
  });
});
