import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name));

describe("licence files", () => {
  const licence = read("LICENSE");
  const text = licence.toString("utf8");
  const lines = text.split("\n").map((l) => l.trim());
  const firstIdx = lines.findIndex((l) => l !== "");

  test("LICENSE opens with the Apache License 2.0 header", () => {
    assert.equal(lines[firstIdx], "Apache License");
    assert.ok(lines[firstIdx + 1].includes("Version 2.0, January 2004"));
  });

  test("LICENSE carries the canonical section markers", () => {
    for (const marker of [
      "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION",
      "END OF TERMS AND CONDITIONS",
      "APPENDIX: How to apply the Apache License to your work.",
    ]) {
      assert.ok(text.includes(marker), `missing marker: ${marker}`);
    }
  });

  test("LICENSE byte length is in the unmodified range", () => {
    assert.ok(licence.length >= 10_900 && licence.length <= 11_700, `bytes: ${licence.length}`);
  });

  test("NOTICE names PRISM and the copyright year", () => {
    const notice = read("NOTICE").toString("utf8");
    assert.ok(notice.includes("PRISM"));
    assert.ok(notice.includes("Copyright 2026"));
  });

  test("README states Apache-2.0", () => {
    assert.ok(read("README.md").toString("utf8").includes("Apache-2.0"));
  });
});
