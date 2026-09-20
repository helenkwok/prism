// The PDF route reads SQLite before it renders (native-module canary): if the
// database cannot be opened the handler must fail, never return a PDF.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const routeUrl = new URL("../src/app/routes/api/report[.]pdf.ts", import.meta.url).href;

async function getHandler() {
  const { Route } = await import(routeUrl);
  return Route.options.server.handlers.GET;
}

test("the report route fails, instead of returning a PDF, when the sqlite file cannot be opened", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prism-canary-"));
  // A regular file where the data directory should be: mkdir and open both fail.
  const blocker = path.join(tmp, "not-a-dir");
  fs.writeFileSync(blocker, "x");
  const saved = process.env.PRISM_DATA_DIR;
  process.env.PRISM_DATA_DIR = path.join(blocker, "data");
  try {
    const GET = await getHandler();
    await assert.rejects(() => GET());
  } finally {
    if (saved === undefined) delete process.env.PRISM_DATA_DIR;
    else process.env.PRISM_DATA_DIR = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
