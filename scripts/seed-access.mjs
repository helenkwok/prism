#!/usr/bin/env node
// Plan 07-13: seed the live run's own and opt-in projects, and the A9 sign-off records, into the app database.
//   node scripts/seed-access.mjs --input <file|-> [--db <sqlite>] [--check]
//   node scripts/seed-access.mjs --a9 <file|-> [--db <sqlite>] [--check]
// --input: a private JSON list [{ projectId, title, basis: "own"|"opt-in", url }]; each live boundary
// comes from deriveBoundary. --a9: sign-off JSONL; only A9 items are kept, and a record holding span or
// snapshot text is refused. --check validates and writes nothing. Output is counts and field names only.
import fs from "node:fs";
import { parseArgs } from "node:util";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import { ensureAccessSchema, upsertProjectAccess } from "../src/app/server/access-store.ts";
import { A9_TABLE, ensureA9Table } from "../src/app/server/live-run.ts";
import { deriveBoundary } from "../src/pipeline/evidence/boundary.ts";
import { A9_ITEMS } from "../src/pipeline/signoff/a9.ts";

const { values } = parseArgs({ options: { input: { type: "string" }, a9: { type: "string" }, db: { type: "string" }, check: { type: "boolean", default: false } } });
const read = (f) => (f === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(f, "utf8"));
const RECORD_FIELDS = new Set(["doc", "item", "decision", "narrowsWhatPasses", "reason", "reviewer", "inputDigest", "docDigest", "decidedAt"]);

function fail(msg) {
  console.error(`SEED REFUSED ${msg}`);
  process.exit(1);
}

let projects = [];
if (values.input) {
  projects = JSON.parse(read(values.input));
  if (!Array.isArray(projects)) fail("input is not a list");
  for (const p of projects) {
    if (typeof p.projectId !== "string" || !["own", "opt-in"].includes(p.basis) || typeof p.url !== "string") fail("a project lacks projectId, basis own|opt-in or url");
    p.boundary = deriveBoundary(p.url);
  }
}
let a9 = [];
if (values.a9) {
  for (const line of read(values.a9).split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    if (!A9_ITEMS.includes(r.item)) continue;
    const extra = Object.keys(r).filter((k) => !RECORD_FIELDS.has(k));
    if (extra.length || /"(spans?|snapshot|redactedText|text)"/.test(line)) fail(`an A9 record holds fields beyond a decision record (${extra.join(",") || "span or snapshot text"})`);
    a9.push(JSON.stringify(r));
  }
}
if (!values.input && !values.a9) fail("pass --input and/or --a9");

if (values.check) {
  console.log(`CHECK projects=${projects.length} a9=${a9.length} fields=${[...new Set(a9.flatMap((l) => Object.keys(JSON.parse(l))))].sort().join(",")}`);
  process.exit(0);
}

const db = values.db
  ? new Kysely({ dialect: new SqliteDialect({ database: new Database(values.db) }) })
  : (await import("../src/app/server/db.ts")).getDb();
await ensureAccessSchema(db);
await ensureA9Table(db);
for (const p of projects) {
  await upsertProjectAccess(db, { projectId: p.projectId, title: p.title ?? null, basis: p.basis, sponsorHold: false, inSample: false, liveBoundaryJson: JSON.stringify([p.boundary]) });
}
for (const line of a9) await db.insertInto(A9_TABLE).values({ line }).onConflict((oc) => oc.doNothing()).execute();
console.log(`SEEDED projects=${projects.length} a9=${a9.length}`);
await db.destroy();
