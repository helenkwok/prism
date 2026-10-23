import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DEADLINE, exitCode, oembedUrl, parseArgs, runChecklist } from "../scripts/check-submission.mjs";

const ALLOWED = new Set(["PASS", "FAIL", "PENDING", "MANUAL"]);

/** Deps with every input absent; override per test. */
function deps(over = {}) {
  return {
    exec: () => ({ status: 0, stdout: "", stderr: "" }),
    read: () => null,
    exists: () => false,
    fetch: async () => ({ status: 200, headers: new Headers() }),
    now: () => new Date("2026-10-24T00:00:00Z"),
    env: {},
    identifierScan: async () => null,
    ...over,
  };
}

const ghRepo = (json) => (cmd, args) =>
  cmd === "gh" && args[0] === "repo"
    ? { status: 0, stdout: JSON.stringify(json), stderr: "" }
    : { status: 0, stdout: "", stderr: "" };

const line = (results, id) => results.find((r) => r.id === id);

describe("check-submission", () => {
  test("absent inputs print PENDING, not FAIL", async () => {
    const r = await runChecklist({}, deps({ exec: ghRepo({ visibility: "PUBLIC", licenseInfo: { key: "apache-2.0" } }) }));
    for (const id of ["R-PUSHED", "R-APP", "R-FINDINGS", "R-PDF", "R-VIDEO", "R-YOUTUBE", "R-WRITEUP", "R-JUDGE", "R-NEBIUS", "R-TAVILY"]) {
      assert.equal(line(r, id).status, "PENDING", id);
    }
    assert.equal(line(r, "R-DATA").status, "PENDING"); // guards clean, identifier scan unavailable
    for (const x of r) assert.ok(ALLOWED.has(x.status), x.id);
    assert.ok(r.some((x) => x.status === "MANUAL"));
  });

  test("R-REPO passes for public apache-2.0", async () => {
    const r = await runChecklist({}, deps({ exec: ghRepo({ visibility: "PUBLIC", licenseInfo: { key: "apache-2.0" } }) }));
    assert.equal(line(r, "R-REPO").status, "PASS");
  });

  test("R-REPO fails for a private repo or a null licence", async () => {
    let r = await runChecklist({}, deps({ exec: ghRepo({ visibility: "PRIVATE", licenseInfo: { key: "apache-2.0" } }) }));
    assert.equal(line(r, "R-REPO").status, "FAIL");
    r = await runChecklist({}, deps({ exec: ghRepo({ visibility: "PUBLIC", licenseInfo: null }) }));
    assert.equal(line(r, "R-REPO").status, "FAIL");
  });

  test("R-YOUTUBE builds the oEmbed URL and maps the status", async () => {
    const link = "https://www.youtube.com/watch?v=abc123";
    assert.equal(oembedUrl(link), `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(link)}`);
    for (const [status, want] of [[200, "PASS"], [401, "FAIL"], [403, "FAIL"], [404, "FAIL"]]) {
      let asked;
      const fetch = async (url) => {
        if (url.includes("oembed")) asked = url;
        return { status, headers: new Headers() };
      };
      const r = await runChecklist({ videoUrl: link }, deps({ fetch }));
      assert.equal(asked, oembedUrl(link));
      assert.equal(line(r, "R-YOUTUBE").status, want, String(status));
    }
  });

  test("R-DEADLINE prints hours left and fails after the instant", async () => {
    const before = await runChecklist({}, deps({ now: () => new Date(Date.parse(DEADLINE) - 10 * 3_600_000) }));
    assert.equal(line(before, "R-DEADLINE").status, "PASS");
    assert.match(line(before, "R-DEADLINE").detail, /^10\.0 h left$/);
    const after = await runChecklist({}, deps({ now: () => new Date(Date.parse(DEADLINE) + 1000) }));
    assert.equal(line(after, "R-DEADLINE").status, "FAIL");
  });

  test("exit status is 1 on any FAIL, else 0", () => {
    assert.equal(exitCode([{ status: "PASS" }, { status: "PENDING" }, { status: "MANUAL" }]), 0);
    assert.equal(exitCode([{ status: "PASS" }, { status: "FAIL" }]), 1);
  });

  test("R-APP needs 200 and a noindex robots header from the deploy URL", async () => {
    const read = (p) => (p.endsWith("07-DEPLOY.md") ? "Deployed: x\nURL: https://app.example\n" : null);
    const fetch = async (url) => ({
      status: url === "https://app.example/sign-in" ? 200 : 404,
      headers: new Headers({ "x-robots-tag": "noindex, nofollow" }),
    });
    let r = await runChecklist({}, deps({ read, fetch }));
    assert.equal(line(r, "R-APP").status, "PASS");
    r = await runChecklist({}, deps({ read, fetch: async () => ({ status: 200, headers: new Headers() }) }));
    assert.equal(line(r, "R-APP").status, "FAIL");
  });

  test("R-DATA fails on a guard failure and reports counts only", async () => {
    const exec = (cmd, args) =>
      args[0] === "scripts/check-forbidden-paths.mjs"
        ? { status: 1, stdout: "", stderr: "refused [office-binary]: a.docx\nrefused [office-binary]: b.docx\n" }
        : { status: 0, stdout: "", stderr: "" };
    const r = await runChecklist({}, deps({ exec, identifierScan: async () => ({ hits: 0, files: 0 }) }));
    const d = line(r, "R-DATA");
    assert.equal(d.status, "FAIL");
    assert.match(d.detail, /forbidden-paths=2/);
    assert.doesNotMatch(d.detail, /docx/);
  });

  test("R-TAVILY is not applicable under t4", async () => {
    const read = (p) => (p.endsWith("08-DECISIONS-HELEN.md") ? "P8-Q4: t4 (no Tavily)\n" : null);
    const r = await runChecklist({}, deps({ read }));
    assert.equal(line(r, "R-TAVILY").status, "PASS");
    assert.match(line(r, "R-TAVILY").detail, /not applicable/);
  });

  test("parseArgs maps flags and rejects unknown ones", () => {
    assert.deepEqual(parseArgs(["--final-sha", "abc", "--video-url", "u"]), { finalSha: "abc", videoUrl: "u" });
    assert.throws(() => parseArgs(["--nope", "x"]));
    assert.throws(() => parseArgs(["--video"]));
  });
});
