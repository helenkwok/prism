// Production span segmenter (EVD-04). New file — NOT imported from
// scripts/spikes/lib/segment.mjs, whose own header forbids reuse (it is a
// throwaway, heading-unaware, non-de-duplicating paragraph splitter built
// only to give the FND-05 matrix harness stable span ids).
//
// Pipeline: split on blank-line-delimited blocks -> further split any block
// on a markdown heading line, so a heading is always its own span -> trim
// and collapse intra-line whitespace per block -> drop blocks under 2 chars
// -> collapse consecutive byte-identical blocks (repeated nav/footer
// boilerplate) -> assign ids by final document-order position.

import crypto from "node:crypto";

export interface Span {
  id: string;
  text: string;
}

export interface Snapshot {
  url: string;
  retrievedAt: string;
  visibility: "provider-extracted";
  snapshotHash: string;
  spans: Span[];
}

const HEADING_RE = /^#+ /;

/** Split one blank-line-delimited block on any markdown heading line within it. */
function splitOnHeadings(block: string): string[] {
  const lines = block.split(/\r?\n/);
  const out: string[] = [];
  let buf: string[] = [];
  for (const line of lines) {
    if (HEADING_RE.test(line)) {
      if (buf.length > 0) {
        out.push(buf.join("\n"));
        buf = [];
      }
      out.push(line);
    } else {
      buf.push(line);
    }
  }
  if (buf.length > 0) out.push(buf.join("\n"));
  return out;
}

const cleanBlock = (block: string): string => block.replace(/[ \t]+/g, " ").trim();

/** Deterministic span split: same input text always yields the same ordered span ids and text. */
export function segmentText(text: string): Span[] {
  const rawBlocks = String(text ?? "").split(/\r?\n\s*\r?\n/);
  const subBlocks = rawBlocks.flatMap(splitOnHeadings);
  const cleaned = subBlocks.map(cleanBlock).filter((b) => b.length >= 2);

  const deduped: string[] = [];
  for (const block of cleaned) {
    if (deduped.length > 0 && deduped[deduped.length - 1] === block) continue;
    deduped.push(block);
  }

  return deduped.map((text, i) => ({ id: `s${String(i + 1).padStart(3, "0")}`, text }));
}

/**
 * Build a snapshot from REDACTED text. `redactedText` must always be the
 * OUTPUT of redactText() (never raw fetched text) — this is the one place
 * EVD-07's "redacted before persistence" guarantee is structurally enforced,
 * since the hash and spans are computed only over what redact.ts produced.
 */
export function buildSnapshot(url: string, retrievedAt: string, redactedText: string): Snapshot {
  return {
    url,
    retrievedAt,
    visibility: "provider-extracted",
    snapshotHash: crypto.createHash("sha256").update(redactedText, "utf8").digest("hex"),
    spans: segmentText(redactedText),
  };
}
