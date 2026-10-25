// APP-03 / SC4 / D-81: a judge opens identifiable records only where the
// registered rule allows (basis set, no sponsor hold) and the de-identified
// record of every sampled project; the de-identified pages leak no identifier,
// checked by the identifier scan over the rendered HTML (not only the stored JSON).
// The spec reads the harness database read-only to learn which pseudonym is
// which project and to build each project's dictionary; it never computes a pseudonym.
import path from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { dictionaryOf, scanDeidentified } from "../src/report/deidentify.ts";
import type { DeidentifiedView, Dictionary } from "../src/report/deidentify.ts";
import type { ReportView } from "../src/report/view.ts";
import { app, inApp, openEvidence, stateFor } from "./helpers.ts";

const DEID_FIGCAPTION = "Source page and snapshot withheld in de-identified records.";

interface Harness {
  pseudonymOf: Map<string, string>;
  dictionaries: Map<string, Dictionary>;
  titles: Map<string, string>;
  hnIds: string[];
}

let cached: Harness | null = null;
function harness(): Harness {
  if (cached) return cached;
  const db = new Database(path.join(process.env.E2E_DIR ?? "", "data", "prism.sqlite"), { readonly: true });
  const pseudonymOf = new Map<string, string>();
  for (const r of db.prepare("select project_id, pseudonym from app_project_access where in_sample = 1").all() as {
    project_id: string;
    pseudonym: string | null;
  }[]) {
    if (r.pseudonym) pseudonymOf.set(r.project_id, r.pseudonym);
  }
  const dictionaries = new Map<string, Dictionary>();
  const titles = new Map<string, string>();
  for (const r of db.prepare("select json from app_report_view where view = 'identifiable'").all() as { json: string }[]) {
    const v: ReportView = JSON.parse(r.json);
    dictionaries.set(v.projectRef, dictionaryOf(v));
    titles.set(v.projectRef, v.title);
  }
  db.close();
  // HN ids of the synthetic corpus (tests/fixtures/report/synthetic-corpus.json): 90000001 to 90000010.
  const hnIds = [...titles.keys()].map((id) => String(90000000 + Number(id.slice(1))));
  cached = { pseudonymOf, dictionaries, titles, hnIds };
  return cached;
}

const pseud = (projectId: string) => {
  const p = harness().pseudonymOf.get(projectId);
  if (!p) throw new Error(`no pseudonym for ${projectId}`);
  return p;
};

/** The identifier scan over one page's HTML, against every sampled project's dictionary. */
function scanHtml(pages: { pseudonym: string; html: string }[]) {
  const { pseudonymOf, dictionaries } = harness();
  const projectOf = new Map([...pseudonymOf].map(([id, p]) => [p, id]));
  // Every sampled project's dictionary takes part, whether or not its page is in this batch.
  const all = [...pseudonymOf.keys()].map((id) => ({
    view: { projectRef: pseudonymOf.get(id)!, html: "" } as unknown as DeidentifiedView,
    dictionary: dictionaries.get(id)!,
  }));
  for (const pg of pages) {
    all.find((e) => e.view.projectRef === pg.pseudonym)!.view = { projectRef: pg.pseudonym, html: pg.html } as unknown as DeidentifiedView;
    expect(projectOf.has(pg.pseudonym)).toBe(true);
  }
  return scanDeidentified(all);
}

async function html(page: Page, url: string) {
  const res = await page.request.get(url);
  return { status: res.status(), body: await res.text() };
}

test.describe("judge", () => {
  test.use({ storageState: ({}, use) => stateFor("judge").then(use) });

  test("opens a de-identified record from the list: kicker, h1, disclaimer, masking legend", async ({ page }) => {
    const p02 = pseud("P02");
    await page.goto(app("/"));
    const section = page.getByRole("region", { name: "De-identified records" });
    const link = section.getByRole("link", { name: `Project ${p02}` });
    await expect(link).toBeVisible();
    const doc = page.waitForResponse((r) => inApp(r.url()) === `/j/${p02}` && r.request().resourceType() === "document");
    await link.click();
    expect((await doc).status()).toBe(200);
    await expect(page).toHaveURL((u) => inApp(u) === `/j/${p02}`);
    await expect(page.locator("article[data-report=deidentified] > p").first()).toHaveText("PRISM · De-identified record");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`De-identified project ${p02}`);
    await expect(page.locator("[data-scope-disclaimer]")).toHaveText(
      /^De-identified record for the judges\. Do not publish\. It describes what one sampled project's own website and repositories publicly evidenced when they were collected on \d{4}-\d{2}-\d{2}\. Names, web addresses and distinctive wording are masked\. Not publicly evidenced does not mean not done\.$/,
    );
    const legend = page.locator("details[data-masking-legend]");
    await expect(legend.locator("summary")).toHaveText("How this record is masked");
    await expect(page.locator("[data-verdict-row]")).toHaveCount(5);
  });

  test("/p/ of an out-of-rule project is 403 with no /j/ address; its /j/ record is 200", async ({ page }) => {
    const p = await html(page, "/p/P02");
    expect(p.status).toBe(403);
    expect(p.body).toContain("Not available to your account");
    expect(p.body).not.toContain("/j/");
    expect(p.body).not.toContain(pseud("P02"));
    expect((await html(page, `/j/${pseud("P02")}`)).status).toBe(200);
  });

  test("a well-known project under a sponsor hold: /p/ 403 (no /j/ link), /j/ 200; an own project: /p/ 200", async ({ page }) => {
    const held = await html(page, "/p/P03");
    expect(held.status).toBe(403);
    expect(held.body).not.toContain("/j/");
    expect(held.body).not.toContain(pseud("P03"));
    expect((await html(page, `/j/${pseud("P03")}`)).status).toBe(200);
    const own = await page.goto(app("/p/P01"));
    expect(own?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(harness().titles.get("P01")!);
  });

  test("an unknown or malformed pseudonym is the same 403", async ({ page }) => {
    const known = new Set(harness().pseudonymOf.values());
    const unknown = ["ZZZZZ", "00000", "11111"].find((p) => !known.has(p))!;
    expect((await html(page, `/j/${unknown}`)).status).toBe(403);
    expect((await html(page, "/j/not-a-pseudonym")).status).toBe(403);
  });

  test("every de-identified page passes the identifier scan over its rendered HTML (Example Planner included)", async ({ page }) => {
    const { pseudonymOf, titles, hnIds } = harness();
    expect(pseudonymOf.size).toBe(10);
    for (const id of pseudonymOf.keys()) expect(harness().dictionaries.get(id)?.terms.length, id).toBeGreaterThan(0);
    const pages = [];
    for (const [id, p] of pseudonymOf) {
      const r = await html(page, `/j/${p}`);
      expect(r.status, id).toBe(200);
      pages.push({ pseudonym: p, html: r.body });
      // Belt and braces for what the dictionaries do not hold: the HN ids and the raw title.
      for (const hn of hnIds) expect(r.body, `${id} carries an HN id`).not.toContain(hn);
      expect(r.body).not.toContain(titles.get(id)!);
    }
    const hits = scanHtml(pages);
    // Hits name pseudonyms and term indexes only, never the term.
    expect(hits).toEqual([]);
    const planner = pages.find((pg) => pg.pseudonym === pseud("P07"))!.html;
    expect(planner.toLowerCase()).not.toContain("example planner");
  });

  test("the masked render: no URL, host, snapshot or live link; withheld captions; quotes of at most 40 words; visible redactions", async ({ page }) => {
    const res = await page.goto(app(`/j/${pseud("P07")}`));
    expect(res?.status()).toBe(200);
    await openEvidence(page);
    const main = page.locator("main");
    await expect(main.locator("[data-quote-url]")).toHaveCount(0);
    await expect(main.locator('a[href*="/snapshot/"], a[target="_blank"], a[href^="http"]')).toHaveCount(0);
    const captions = main.locator("[data-quote-card] figcaption");
    const n = await captions.count();
    expect(n).toBeGreaterThan(0);
    for (const t of await captions.allTextContents()) expect(t).toBe(DEID_FIGCAPTION);
    for (const q of await main.locator("[data-quote-card] blockquote").allTextContents()) {
      expect(q.trim().split(/\s+/).length).toBeLessThanOrEqual(40);
    }
    // Example Planner's quotes are masked: every placeholder sits in a visible redaction span.
    const redactions = main.locator("[data-quote-card] blockquote .redaction");
    expect(await redactions.count()).toBeGreaterThan(0);
    await expect(redactions.filter({ hasText: "[product]" }).first()).toBeVisible();
    const attrs = await main.evaluate((el) =>
      [...el.querySelectorAll("*")].flatMap((n) => [...n.attributes].map((a) => a.value)).join("\n"),
    );
    expect(attrs).not.toMatch(/https?:\/\/|\.example\b/);
  });
});

test.describe("admin", () => {
  test.use({ storageState: ({}, use) => stateFor("admin").then(use) });

  test("the HTML scan is not vacuous: it finds Example Planner's identifiers in the identifiable page", async ({ page }) => {
    const r = await html(page, "/p/P07");
    expect(r.status).toBe(200);
    const hits = scanHtml([{ pseudonym: pseud("P07"), html: r.body }]);
    expect(hits.filter((h) => h.pseudonym === pseud("P07") && h.termOf === pseud("P07")).length).toBeGreaterThan(0);
  });

  test("admin opens any de-identified record", async ({ page }) => {
    expect((await html(page, `/j/${pseud("P01")}`)).status).toBe(200);
  });
});

test.describe("company A", () => {
  test.use({ storageState: ({}, use) => stateFor("companyA").then(use) });

  test("gets 403 on every /j/ address, its own project's included", async ({ page }) => {
    for (const [id, p] of harness().pseudonymOf) {
      const r = await html(page, `/j/${p}`);
      expect(r.status, id).toBe(403);
      expect(r.body).toContain("Not available to your account");
    }
  });

  test("gets the 403 page on /method (07-03 Q3: hidden from companies)", async ({ page }) => {
    const res = await page.goto(app("/method"));
    expect(res?.status()).toBe(403);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Not available to your account");
    await expect(page.locator("[data-method]")).toHaveCount(0);
  });
});

// ---- Method audit (Task 3) ----

const IDENTIFIABLE_FOR_JUDGE = ["P01", "P05"]; // own and opt-in, no hold (corpus access blocks)

/** Projects whose identifiers (dictionary terms or project id) appear in the HTML; uses the same scan. */
function identifiersIn(body: string, projectIds: string[]) {
  const { dictionaries } = harness();
  const page = { view: { projectRef: "PAGE", html: body } as unknown as DeidentifiedView, dictionary: { projectRef: "PAGE", terms: [] } };
  const others = projectIds.map((id) => ({
    view: { projectRef: id, html: "" } as unknown as DeidentifiedView,
    dictionary: dictionaries.get(id)!,
  }));
  const hits = scanDeidentified([page, ...others]).filter((h) => h.pseudonym === "PAGE").map((h) => (h.termIndex === -1 ? "url" : h.termOf));
  for (const id of projectIds) if (new RegExp(`\\b${id}\\b`).test(body)) hits.push(id);
  return [...new Set(hits)];
}

/** Every page of /method's confirmation records, as HTML and as visible rows. */
async function methodPages(page: Page) {
  const out: { body: string; rows: { project: string; identifiable: string }[] }[] = [];
  let url: string | null = app("/method");
  while (url) {
    const res = await page.goto(url);
    expect(res?.status()).toBe(200);
    const rows = await page.locator("tr[data-confirmation]").evaluateAll((trs) =>
      trs.map((tr) => ({ project: tr.querySelector("td")!.textContent ?? "", identifiable: tr.getAttribute("data-identifiable") ?? "" })),
    );
    out.push({ body: await res!.text(), rows });
    const next = page.getByRole("navigation", { name: "Confirmation record pages" }).getByRole("link", { name: "Next" });
    url = (await next.count()) ? await next.getAttribute("href") : null;
  }
  return out;
}

test.describe("method audit, judge", () => {
  test.use({ storageState: ({}, use) => stateFor("judge").then(use) });

  test("agreement table, selection counts and 24 codebook entries", async ({ page }) => {
    const res = await page.goto(app("/method"));
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Method audit");
    for (const name of ["Agreement with the independent labeller", "How projects were selected", "Codebook", "Confirmation records", "How this report was made"]) {
      await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
    }
    const rows = page.locator("tr[data-agreement]");
    await expect(rows).toHaveCount(24);
    const released = page.locator('tr[data-agreement="output-reproducible"] td');
    await expect(released.nth(1)).toHaveText("0.72 (0.63–0.78)");
    await expect(released.nth(2)).toHaveText("11 of 12");
    await expect(released.nth(3)).toHaveText("zai-org/GLM-5.3, inference.example");
    await expect(page.locator('tr[data-agreement="acceptance-criteria-met"] [data-explicit-state]')).toHaveText(
      "withheld: agreement below the pre-registered threshold",
    );
    for (const t of await page.locator("[data-explicit-state]").allTextContents()) expect(t).not.toMatch(/\d/);
    await expect(page.locator("[data-explicit-state]")).toHaveCount(7);
    await expect(page.locator("tr[data-prisma]")).toHaveCount(6);
    await expect(page.locator("details[data-codebook-entry]")).toHaveCount(24);
    const entry = page.locator('details[data-codebook-entry="intended-use-defined"]');
    await entry.locator("summary").click();
    await expect(entry.locator("[data-chip]").first()).toBeVisible();
    await expect(entry).toContainText("What would close this gap");
  });

  test("confirmation records: projects the judge cannot open show only their pseudonym, on every page and in the HTML", async ({ page }) => {
    const pages = await methodPages(page);
    expect(pages.length).toBe(2); // 89 records, 50 per page
    const rows = pages.flatMap((p) => p.rows);
    const { titles } = harness();
    const shown = new Set(rows.map((r) => r.project));
    // P01 and P05 by title; P02 and the held P03 by pseudonym only.
    for (const id of IDENTIFIABLE_FOR_JUDGE) expect(shown.has(titles.get(id)!), id).toBe(true);
    expect(shown.has(`Project ${pseud("P02")}`)).toBe(true);
    expect(shown.has(`Project ${pseud("P03")}`)).toBe(true);
    for (const r of rows) expect(r.identifiable).toBe(IDENTIFIABLE_FOR_JUDGE.some((id) => titles.get(id) === r.project) ? "true" : "false");
    const hidden = [...titles.keys()].filter((id) => !IDENTIFIABLE_FOR_JUDGE.includes(id));
    for (const p of pages) {
      // No title, host, repo or id of a project the judge may not identify, anywhere in the document (dehydrated data included).
      expect(identifiersIn(p.body, hidden)).toEqual([]);
      // And no pseudonym of a project shown by title, so nothing joins the two.
      for (const id of IDENTIFIABLE_FOR_JUDGE) expect(p.body).not.toContain(pseud(id));
    }
  });
});

test.describe("method audit, admin", () => {
  test.use({ storageState: ({}, use) => stateFor("admin").then(use) });

  test("confirmation records show every project by title", async ({ page }) => {
    const pages = await methodPages(page);
    const rows = pages.flatMap((p) => p.rows);
    expect(rows.length).toBe(89);
    // Control for the judge test: the same check does find P02's identifiers on the admin's pages.
    expect(pages.flatMap((p) => identifiersIn(p.body, ["P02"]))).toContain("P02");
    for (const r of rows) {
      expect(r.identifiable).toBe("true");
      expect(r.project).not.toMatch(/^Project /);
    }
    expect(new Set(rows.map((r) => r.project))).toContain(harness().titles.get("P02")!);
  });

  test("with no method view stored: the not-loaded line, and the codebook still renders", async ({ page }) => {
    const db = new Database(path.join(process.env.E2E_DIR ?? "", "data", "prism.sqlite"));
    const saved = db.prepare("select * from app_method_view").all();
    expect(saved.length).toBe(1);
    db.prepare("delete from app_method_view").run();
    try {
      const res = await page.goto(app("/method"));
      expect(res?.status()).toBe(200);
      await expect(page.locator("[data-not-loaded]")).toHaveText("Agreement figures appear here once validation is complete.");
      await expect(page.locator("tr[data-agreement]")).toHaveCount(0);
      await expect(page.locator("tr[data-confirmation]")).toHaveCount(0);
      await expect(page.locator("details[data-codebook-entry]")).toHaveCount(24);
    } finally {
      const ins = db.prepare("insert into app_method_view (id, json, generated_at, fixture) values (@id, @json, @generated_at, @fixture)");
      for (const r of saved) ins.run(r);
      db.close();
    }
  });
});
