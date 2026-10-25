#!/usr/bin/env node
// Plan 07-14 Task 3: the judge view in production, checked from the Mac after the load.
//   node scripts/prod-judge-check.mjs --base https://prism.helenkwok.dev --views <local real-views.sqlite>
//        [--key-file <judge.key>] [--own <projectId>]...
// Signs in as the shared judge login (password read from its mode-600 key file, never printed) and checks:
// no fixture notice; every /p/ link on the list is an own project; a sampled project's identifiable URL is a
// 403; three /j/ pages answer 200 and their text holds no URL and no sampled project's non-vocabulary name
// (dictionaries built locally from the private views); /method answers 200 with released rows.
// Prints PASS/FAIL lines and counts only, never a name or a quote.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import Database from "better-sqlite3";

import { buildDocumentFrequency, dictionaryOf, isVocabulary } from "../src/report/deidentify.ts";

const { values } = parseArgs({ options: { base: { type: "string" }, views: { type: "string" }, "key-file": { type: "string" }, own: { type: "string", multiple: true, default: [] } } });
if (!values.base || !values.views) {
  console.error("usage: prod-judge-check.mjs --base <url> --views <local real-views.sqlite> [--key-file <file>] [--own <projectId>]...");
  process.exit(2);
}
const base = values.base.replace(/\/$/, "");
const keyFile = values["key-file"] ?? path.join(os.homedir(), "Library/Application Support/prism/judge.key");
const password = fs.readFileSync(keyFile, "utf8").trim();
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base },
  body: JSON.stringify({ email: "prism-judge@helenkwok.dev", password }),
});
check("judge sign-in returns 200", signIn.status === 200, `status ${signIn.status}`);
const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const get = (p) => fetch(`${base}${p}`, { headers: { cookie }, redirect: "manual" });
const text = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ");

const home = await get("/");
const homeHtml = await home.text();
check("judge list answers 200", home.status === 200, `status ${home.status}`);
check("no fixture notice", !/data-notice="fixture"/.test(homeHtml));
const pLinks = [...new Set([...homeHtml.matchAll(/href="\/p\/([^"]+)"/g)].map((m) => decodeURIComponent(m[1])))];
const jLinks = [...new Set([...homeHtml.matchAll(/href="\/j\/([^"]+)"/g)].map((m) => decodeURIComponent(m[1])))];
check("every identifiable link is an own project", pLinks.every((p) => values.own.includes(p)), `${pLinks.length} links`);
check("de-identified links listed", jLinks.length >= 3, `${jLinks.length} links`);

const db = new Database(values.views, { readonly: true, fileMustExist: true });
const views = db.prepare("SELECT json FROM app_report_view WHERE view = 'identifiable'").all().map((r) => JSON.parse(r.json));
const sampleId = views[0]?.projectRef;
const refused = await get(`/p/${encodeURIComponent(sampleId)}`);
check("a sampled project's identifiable page is refused", refused.status === 403, `status ${refused.status}`);

const corpus = buildDocumentFrequency(views);
const terms = views.flatMap((v) => dictionaryOf(v).terms.filter((t) => !isVocabulary(t.text, corpus)).map((t) => t.text.toLowerCase()));
const word = (t) => new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{M}\\p{N}])`, "iu");
const res = terms.map(word);
const picks = [jLinks[0], jLinks[Math.floor(jLinks.length / 2)], jLinks[jLinks.length - 1]];
for (const [i, j] of picks.entries()) {
  const r = await get(`/j/${encodeURIComponent(j)}`);
  const body = text(await r.text());
  const hits = res.filter((re) => re.test(body)).length;
  const urls = (body.match(/\bhttps?:\/\/\S+/gi) ?? []).filter((u) => !u.startsWith(base)).length;
  check(`de-identified page ${i + 1} answers 200`, r.status === 200, `status ${r.status}`);
  check(`de-identified page ${i + 1} names no sampled project and holds no URL`, hits === 0 && urls === 0, `name hits ${hits}, urls ${urls}`);
}

const method = await get("/method");
const methodHtml = await method.text();
check("method audit answers 200", method.status === 200, `status ${method.status}`);
check("method audit shows released agreement rows", /released/i.test(text(methodHtml)) && !/data-notice="fixture"/.test(methodHtml));

console.log(`JUDGE-CHECK ${failed === 0 ? "PASS" : "FAIL"} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
