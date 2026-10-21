// VAL-06 / A7.11: collection recall gatherer (own sources, no Tavily).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { SCREENER_MODEL } from "../../src/pipeline/select/screen-model.ts";
import { ROLE_CONFIG } from "../../src/pipeline/validate/providers.ts";
import { isPageLike } from "../../src/pipeline/evidence/tavily.ts";
import {
  EmptyItemsError,
  gatherOwnSources,
  isBoilerplateQuote,
  listItems,
  matchItems,
  normalise,
  parseItems,
  RecallParseError,
  recallFigure,
  verifyItems,
  widenedRemeasure,
} from "../../src/pipeline/validate/recall.ts";

function tmpCache() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prism-recall-"));
}

function fakeClient(replies) {
  const seen = [];
  let i = 0;
  return {
    seen,
    request: async (_p, init) => {
      seen.push(init.body);
      const content = typeof replies === "function" ? replies(i++, init.body) : replies[i++] ?? replies[replies.length - 1];
      return { ok: true, status: 200, json: { choices: [{ message: { content } }] } };
    },
  };
}

const PUBLIC = async () => ["93.184.216.34"];

const entry = {
  n: 1,
  hn_id: "1",
  entry_url: "https://example.com/",
  final_url: "https://example.com/",
  boundary: { host: "example.com" },
  type_class: "own-domain",
};

/** Match own-site.test.mjs Response shape for followRedirects. */
function mockFetch(map) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const key = String(url);
    let entry = map[key] ?? map["*"];
    if (!entry && typeof map.resolve === "function") entry = map.resolve(key);
    if (!entry) {
      return new Response("", { status: 404 });
    }
    if (entry.redirect) {
      return new Response("", { status: 302, headers: { location: entry.redirect } });
    }
    return new Response(entry.body ?? "", { status: entry.status ?? 200 });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const codebook = {
  codebookVersion: "v1.0",
  relationTypes: [],
  checks: {
    "check.a": {
      decision: "d",
      label: "A",
      operationalDefinition: "def a",
      passRule: "pass a",
      failRule: "fail a",
      claimedRule: "claimed a",
      notApplicableNote: "",
      anchors: { positive: [], negative: [] },
      crosswalk: {},
    },
  },
};

describe("gatherOwnSources", () => {
  test("robots first; disallowed URL never reaches fetchImpl; only own-boundary URLs", async () => {
    const fetchImpl = mockFetch({
      "https://example.com/robots.txt": {
        status: 200,
        body: "User-agent: *\nDisallow: /secret\n",
      },
      "https://example.com/": {
        status: 200,
        body: `<html><body><a href="/about">About</a><a href="/secret">Nope</a><a href="https://evil.com/x">off</a><p>Hello world product page ${"with enough characters to skip render. ".repeat(20)}</p></body></html>`,
      },
      "https://example.com/about": {
        status: 200,
        body: `<html><body><p>About page ${"with enough text here for gatherer. ".repeat(20)}</p></body></html>`,
      },
      "https://example.com/secret": {
        status: 200,
        body: "should never be fetched",
      },
    });

    const pages = await gatherOwnSources({
      entry,
      fetchImpl,
      resolver: PUBLIC,
      renderImpl: async () => assert.fail("should not render long pages"),
    });

    assert.ok(fetchImpl.calls.some((u) => u.includes("robots.txt")), "robots.txt first");
    assert.ok(fetchImpl.calls[0].includes("robots.txt"), "robots before pages");
    assert.ok(!fetchImpl.calls.some((u) => u.includes("/secret")), "disallowed never fetched");
    assert.ok(!fetchImpl.calls.some((u) => u.includes("evil.com")), "off-boundary never fetched");
    assert.ok(!fetchImpl.calls.some((u) => u.includes("api.tavily.com")), "no collector API");
    for (const p of pages) {
      assert.ok(p.url.startsWith("https://example.com"), p.url);
    }
    assert.ok(pages.some((p) => p.text.includes("Hello")));
    assert.ok(pages.some((p) => p.url.includes("about") || p.text.includes("About")));
  });

  test("thin page uses renderImpl", async () => {
    const fetchImpl = mockFetch({
      "https://example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/": { status: 200, body: "<html><body>tiny</body></html>" },
    });
    let rendered = false;
    const pages = await gatherOwnSources({
      entry,
      fetchImpl,
      resolver: PUBLIC,
      renderImpl: async () => {
        rendered = true;
        return "rendered content with plenty of characters from the SPA shell after hydration.";
      },
    });
    assert.equal(rendered, true);
    assert.equal(pages[0]?.rendered, true);
    assert.ok(pages[0]?.text.includes("rendered content"));
  });
});

describe("listItems / verify / match / figure", () => {
  test("listItems prompt has codebook + pages only; assertIndependent gatherer", async () => {
    const client = fakeClient([
      JSON.stringify({
        items: [{ checkId: "check.a", url: "https://example.com/", quote: "Hello world product", state: "pass" }],
      }),
    ]);
    const pages = [
      {
        url: "https://example.com/",
        text: "Hello world product page with enough characters.",
        fetchedAt: "2026-10-21T00:00:00.000Z",
        rendered: false,
      },
    ];
    const items = await listItems({
      client,
      role: ROLE_CONFIG.gatherer,
      codebook,
      checkIds: ["check.a"],
      pages,
      cacheDir: tmpCache(),
      projectId: "t1",
    });
    assert.equal(items.length, 1);
    const msg = JSON.stringify(client.seen[0].messages);
    assert.ok(msg.includes("def a"));
    assert.ok(msg.includes("Hello world product"));
    assert.ok(!msg.includes("filtered_state"));
    assert.ok(!msg.includes("pipeline_check_states"));
    assert.ok(!msg.includes("publishedStates"));

    await assert.rejects(
      () =>
        listItems({
          client,
          role: { provider: "token-factory", model: SCREENER_MODEL, reasoning: false },
          codebook,
          checkIds: ["check.a"],
          pages,
          cacheDir: tmpCache(),
          projectId: "t2",
        }),
      /A6/,
    );
  });

  test("verifyItems drops non-verbatim; matchItems redacts email and tags misses", () => {
    const pages = [
      {
        url: "https://example.com/",
        text: "Contact us at alice@example.com for license details.",
        fetchedAt: "2026-10-21T00:00:00.000Z",
        rendered: false,
      },
    ];
    const { kept, droppedNonVerbatim } = verifyItems(
      [
        { checkId: "check.a", url: "https://example.com/", quote: "alice@example.com for license", state: "pass" },
        { checkId: "check.a", url: "https://example.com/", quote: "hallucinated quote nowhere", state: "claimed" },
      ],
      pages,
    );
    assert.equal(droppedNonVerbatim, 1);
    assert.equal(kept.length, 1);

    const matchedEmail = matchItems(kept, {
      collectedText: "Contact us at [email redacted] for license details.",
      snapshotUrls: ["https://example.com/"],
    });
    assert.equal(matchedEmail[0].found, true);

    const caseWs = matchItems(
      [{ ...kept[0], quote: "ALICE@EXAMPLE.COM   for   license" }],
      {
        collectedText: "Contact us at [email redacted] for license details.",
        snapshotUrls: ["https://example.com/"],
      },
    );
    // After redactText on the quote, email becomes placeholder; normalise matches corpus.
    assert.equal(caseWs[0].found, true);

    const missedPage = matchItems(kept, {
      collectedText: "something else entirely",
      snapshotUrls: ["https://example.com/other"],
    });
    assert.equal(missedPage[0].found, false);
    assert.equal(missedPage[0].missKind, "missedPage");

    const changed = matchItems(kept, {
      collectedText: "page edited away the quote",
      snapshotUrls: ["https://example.com/"],
    });
    assert.equal(changed[0].found, false);
    assert.equal(changed[0].missKind, "changedText");
  });

  test("normalise collapses case whitespace punctuation", () => {
    assert.equal(normalise("Hello,  WORLD!"), normalise("hello world"));
  });

  test("recallFigure pools with wilson and 0.70 bar", () => {
    const fig = recallFigure([
      { hnId: "1", projectN: 1, items: 5, found: 4, droppedNonVerbatim: 0 },
      { hnId: "2", projectN: 2, items: 5, found: 3, droppedNonVerbatim: 1 },
    ]);
    assert.equal(fig.projects, 2);
    assert.equal(fig.contributing, 2);
    assert.equal(fig.items, 10);
    assert.equal(fig.found, 7);
    assert.equal(fig.recall, 0.7);
    assert.equal(fig.withinThreshold, true);
    assert.equal(fig.acceptanceMet, false); // only 2 < 8
    assert.equal(fig.bar, 0.7);
    assert.equal(fig.wilson95.length, 2);
    assert.equal(fig.droppedNonVerbatim, 1);

    const under = recallFigure([{ hnId: "1", projectN: 1, items: 10, found: 6, droppedNonVerbatim: 0 }]);
    assert.equal(under.withinThreshold, false);

    const withFails = recallFigure(
      Array.from({ length: 8 }, (_, i) => ({
        hnId: String(i),
        projectN: i,
        items: 1,
        found: 1,
        droppedNonVerbatim: 0,
      })),
      2,
    );
    assert.equal(withFails.projects, 10);
    assert.equal(withFails.gatherFailed, 2);
    assert.equal(withFails.contributing, 8);
    assert.equal(withFails.acceptanceMet, true);
  });

  test("parseItems accepts bare arrays; empty vs prose errors", () => {
    const ids = new Set(["check.a"]);
    const bare = parseItems(
      JSON.stringify([{ checkId: "check.a", url: "https://example.com/", quote: "Hello", state: "pass" }]),
      ids,
    );
    assert.equal(bare.length, 1);
    const wrapped = parseItems(
      JSON.stringify({ items: [{ checkId: "check.a", url: "https://example.com/", quote: "Hello", state: "pass" }] }),
      ids,
    );
    assert.equal(wrapped.length, 1);
    assert.throws(() => parseItems("[]", ids), EmptyItemsError);
    assert.throws(() => parseItems('{"items":[]}', ids), EmptyItemsError);
    assert.throws(() => parseItems("## Evidence found\nnothing", ids), RecallParseError);
  });

  test("listItems accepts repeated empty [] as zero items", async () => {
    const client = fakeClient(["[]", "[]"]);
    const pages = [
      {
        url: "https://example.com/",
        text: "Hello world product page with enough characters.",
        fetchedAt: "2026-10-21T00:00:00.000Z",
        rendered: false,
      },
    ];
    const items = await listItems({
      client,
      role: ROLE_CONFIG.gatherer,
      codebook,
      checkIds: ["check.a"],
      pages,
      cacheDir: tmpCache(),
      projectId: "empty-ok",
    });
    assert.equal(items.length, 0);
    assert.equal(client.seen.length, 2);
  });

  test("isBoilerplateQuote catches CTAs", () => {
    assert.equal(isBoilerplateQuote("Go to app Demo Book a demo Install"), true);
    assert.equal(isBoilerplateQuote("Start for Free"), true);
    assert.equal(isBoilerplateQuote("Our API returns signed manifests for every run."), false);
  });

  test("isPageLike drops _next/static and css/js", () => {
    assert.equal(isPageLike("https://a.example/docs"), true);
    assert.equal(isPageLike("https://a.example/_next/static/chunks/main.js"), false);
    assert.equal(isPageLike("https://a.example/assets/app.css"), false);
    assert.equal(isPageLike("https://a.example/static/css/main.abc.css"), false);
  });

  test("listItems accepts bare-array reply", async () => {
    const client = fakeClient([
      JSON.stringify([{ checkId: "check.a", url: "https://example.com/", quote: "Hello world product", state: "pass" }]),
    ]);
    const pages = [
      {
        url: "https://example.com/",
        text: "Hello world product page with enough characters.",
        fetchedAt: "2026-10-21T00:00:00.000Z",
        rendered: false,
      },
    ];
    const items = await listItems({
      client,
      role: ROLE_CONFIG.gatherer,
      codebook,
      checkIds: ["check.a"],
      pages,
      cacheDir: tmpCache(),
      projectId: "bare1",
    });
    assert.equal(items.length, 1);
  });
});

describe("widenedRemeasure (D-66 free collector)", () => {
  test("writes only under recall-widened/", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-recall-data-"));
    const bulkSnap = path.join(dataDir, "pipeline", "snapshots");
    fs.mkdirSync(bulkSnap, { recursive: true });
    fs.writeFileSync(path.join(bulkSnap, "keep.json"), "{}");

    const fetchImpl = mockFetch({
      "https://example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/sitemap.xml": { status: 404, body: "" },
      "https://example.com/sitemap_index.xml": { status: 404, body: "" },
      "https://example.com/": {
        status: 200,
        body: "<html><body><p>Widened page with the license quote we need for rematch.</p></body></html>",
      },
    });

    const verifiedByHn = new Map([
      [
        "1",
        [
          {
            checkId: "check.a",
            url: "https://example.com/",
            quote: "license quote we need",
            state: "pass",
            pageUrl: "https://example.com/",
          },
        ],
      ],
    ]);

    const { action, outDir } = await widenedRemeasure({
      dataDir,
      entries: [entry],
      verifiedByHn,
      pageCap: 5,
      fetchImpl,
      resolver: PUBLIC,
    });

    assert.equal(action.kind, "widened-remeasure");
    assert.equal(action.creditsSpent, 0);
    assert.ok(outDir.includes("recall-widened"));
    assert.ok(fs.existsSync(path.join(outDir, "remeasure.json")));
    // Bulk snapshots untouched.
    assert.equal(fs.readFileSync(path.join(bulkSnap, "keep.json"), "utf8"), "{}");
    // No writes outside recall-widened under validation.
    const validation = path.join(dataDir, "validation");
    for (const name of fs.readdirSync(validation)) {
      assert.equal(name, "recall-widened");
    }
  });
});
