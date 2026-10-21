// D-66 free own-site collector — mock fetch only, never live network.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { deriveBoundary } from "../../src/pipeline/evidence/boundary.ts";
import {
  collectOwnSitePages,
  extractLinks,
  pageText,
  parseSitemapLocs,
} from "../../src/pipeline/evidence/own-site.ts";

const PUBLIC = async () => ["93.184.216.34"];

function mockFetch(map) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    const key = String(url);
    const entry = map[key] ?? map["*"];
    if (!entry) {
      return {
        status: 404,
        headers: { get: () => null },
        body: { cancel: async () => {}, getReader: () => ({ read: async () => ({ done: true }) }) },
      };
    }
    if (entry.redirect) {
      return {
        status: 302,
        headers: { get: (h) => (h.toLowerCase() === "location" ? entry.redirect : null) },
        body: { cancel: async () => {} },
      };
    }
    const body = entry.body ?? "";
    const enc = new TextEncoder().encode(body);
    let offset = 0;
    return {
      status: entry.status ?? 200,
      headers: { get: () => null },
      body: {
        cancel: async () => {},
        getReader: () => ({
          read: async () => {
            if (offset >= enc.length) return { done: true };
            const value = enc.subarray(offset);
            offset = enc.length;
            return { done: false, value };
          },
          cancel: async () => {},
        }),
      },
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

describe("own-site helpers", () => {
  test("pageText strips tags", () => {
    assert.equal(pageText("<p>Hello <b>world</b></p>"), "Hello world");
  });

  test("pageText keeps block newlines (D-67)", () => {
    const t = pageText("<div><p>First block</p><p>Second block</p></div>");
    assert.match(t, /First block\nSecond block/);
    assert.ok(!t.includes("First block Second block"));
  });

  test("extractLinks resolves relative hrefs", () => {
    const links = extractLinks('<a href="/about">x</a><a href="https://other.example/">y</a>', "https://ex.example/");
    assert.ok(links.includes("https://ex.example/about"));
    assert.ok(links.includes("https://other.example/"));
  });

  test("parseSitemapLocs", () => {
    const locs = parseSitemapLocs("<urlset><url><loc>https://ex.example/a</loc></url><url><loc>https://ex.example/b</loc></url></urlset>");
    assert.deepEqual(locs, ["https://ex.example/a", "https://ex.example/b"]);
  });
});

describe("collectOwnSitePages", () => {
  test("robots-first: disallowed page is never fetched", async () => {
    const fetchImpl = mockFetch({
      "https://blocked.example/robots.txt": {
        status: 200,
        body: "User-agent: *\nDisallow: /\n",
      },
      "https://blocked.example/sitemap.xml": { status: 404, body: "" },
      "https://blocked.example/sitemap_index.xml": { status: 404, body: "" },
      "https://blocked.example/": { status: 200, body: "<html>secret</html>" },
    });
    const boundary = deriveBoundary("https://blocked.example/");
    const result = await collectOwnSitePages({
      boundary,
      startUrl: "https://blocked.example/",
      fetchImpl,
      resolver: PUBLIC,
    });
    assert.equal(result.pages.length, 0);
    assert.equal(result.creditsSpent, 0);
    assert.ok(fetchImpl.calls.some((u) => String(u).includes("/robots.txt")));
    assert.ok(!fetchImpl.calls.some((u) => String(u) === "https://blocked.example/"));
  });

  test("homepage + in-boundary link + sitemap, capped, creditsSpent 0", async () => {
    const fetchImpl = mockFetch({
      "https://ok.example/robots.txt": { status: 404, body: "" },
      "https://ok.example/sitemap.xml": {
        status: 200,
        body: "<urlset><url><loc>https://ok.example/from-map</loc></url></urlset>",
      },
      "https://ok.example/sitemap_index.xml": { status: 404, body: "" },
      "https://ok.example/": {
        status: 200,
        body: '<html><body>Home <a href="/about">About</a></body></html>',
      },
      "https://ok.example/about": {
        status: 200,
        body: "<html><body>About page text here</body></html>",
      },
      "https://ok.example/from-map": {
        status: 200,
        body: "<html><body>From sitemap</body></html>",
      },
    });
    const boundary = deriveBoundary("https://ok.example/");
    const result = await collectOwnSitePages({
      boundary,
      startUrl: "https://ok.example/",
      fetchImpl,
      resolver: PUBLIC,
      pageCap: 20,
    });
    assert.equal(result.creditsSpent, 0);
    const urls = result.pages.map((p) => p.url).sort();
    assert.ok(urls.includes("https://ok.example/"));
    assert.ok(urls.includes("https://ok.example/about"));
    assert.ok(urls.includes("https://ok.example/from-map"));
    assert.ok(result.pages.every((p) => p.rawText.length > 0));
    // Never hits api.tavily.com
    assert.ok(!fetchImpl.calls.some((u) => String(u).includes("tavily")));
  });

  test("pageCap stops crawl", async () => {
    const map = {
      "https://cap.example/robots.txt": { status: 404, body: "" },
      "https://cap.example/sitemap.xml": { status: 404, body: "" },
      "https://cap.example/sitemap_index.xml": { status: 404, body: "" },
      "https://cap.example/": {
        status: 200,
        body: '<a href="/1">1</a><a href="/2">2</a><a href="/3">3</a>',
      },
    };
    for (const n of [1, 2, 3]) {
      map[`https://cap.example/${n}`] = { status: 200, body: `<html>page ${n}</html>` };
    }
    const fetchImpl = mockFetch(map);
    const result = await collectOwnSitePages({
      boundary: deriveBoundary("https://cap.example/"),
      startUrl: "https://cap.example/",
      fetchImpl,
      resolver: PUBLIC,
      pageCap: 2,
    });
    assert.equal(result.pages.length, 2);
  });
});
