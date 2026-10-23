// APP-04 / SC3 / 07-UI-SPEC: the report reads gate first, in evidence language,
// with every quote linked to its archived snapshot and its live page.
import { expect, test } from "@playwright/test";
import { stateFor } from "./helpers.ts";

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
      main.querySelectorAll("[data-gap], blockquote").forEach((e) => e.remove());
      return main.textContent ?? "";
    });
    expect(visible).not.toMatch(/\b(PASS|BLOCKED|INSUFFICIENT_EVIDENCE)\b/);
    for (const row of await page.locator("[data-verdict-row]").allInnerTexts()) expect(row).not.toMatch(/PASS|BLOCKED|INSUFFICIENT/);
    const statuses = await page.locator("[data-verdict-row]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-gate-status")));
    expect(statuses.every((s) => ["PASS", "BLOCKED", "INSUFFICIENT_EVIDENCE"].includes(s ?? ""))).toBe(true);
  }
  // P08 has a check its own page shows as not met.
  await page.goto("/p/P08");
  await expect(page.locator('[data-state="fail"]').first()).toContainText("own page shows the check is not met");
});

test("quote cards: URL as truncated text with title, snapshot link with #span-, live link rel and target", async ({ page }) => {
  await page.goto("/p/P01");
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
