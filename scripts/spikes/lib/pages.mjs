// Deterministic page-corpus loader for the Nebius matrix, escape probe and pin
// scripts (FND-05, D-15, plan 01-10). Reused across nebius-matrix.mjs,
// nebius-escape-probe.mjs and nebius-pin.mjs so the same page carving (first N
// for the matrix, the next 50 distinct pages for the pin streak) is derived
// the same way everywhere instead of copy-pasted three times.

import fs from "node:fs";
import path from "node:path";

// ~6,000 tokens at ~4 chars/token (plan 01-10's page cap).
const CHAR_CAP = 24000;

/**
 * All redacted, non-empty spike pages under dirs.pages (plan 01-06's corpus),
 * sorted by (subdirectory, file) so the same prefix is always "the matrix
 * pages" and the same suffix is always "the streak pages". Returns
 * [{ id: "proj1/001.md", text }, ...].
 */
export function loadPageCorpus(dirs) {
  const out = [];
  if (!fs.existsSync(dirs.pages)) return out;
  const subdirs = fs
    .readdirSync(dirs.pages, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const sub of subdirs) {
    const dir = path.join(dirs.pages, sub);
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      if (text.trim().length === 0) continue;
      out.push({ id: `${sub}/${f}`, text });
    }
  }
  return out;
}

/** Cap page text near 6,000 tokens; returns { text, truncated }. */
export function capPage(text) {
  if (text.length <= CHAR_CAP) return { text, truncated: false };
  return { text: text.slice(0, CHAR_CAP), truncated: true };
}

export { CHAR_CAP };
