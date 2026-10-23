// D-83 Addendum A11: process figures outside the k = 10 rule. Mirrors src/pipeline/signoff/a9.ts.
// PROCESS_FIGURES is the only exception list the export uses; a test keeps it equal to the A11 text.
// (Planned as A10; A10 was already taken by the 2026-10-23 budget corrections, so this is A11.)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveDataDir } from "../app/server/db.ts";

export const ADDENDUM = "A11";

export const A11_ITEMS = ["A11.1 Process figures outside the k = 10 rule"] as const;

/** D-83: the four figures that describe the instrument, not any launch, published in full. */
export const PROCESS_FIGURES = [
  { id: "screening-audit", reason: "screening error of the audited exclusions: a property of the screener, not of any launch" },
  { id: "collection-recall", reason: "supported and raw collection recall: a property of the collector, not of any launch" },
  { id: "person-edits", reason: "the count of labels edited by a person: a property of the process, not of any launch" },
  { id: "confirmation-total", reason: "the total share of proposed positives changed at confirmation: a property of the coder and confirmer, not of any launch" },
] as const;

export function a11Section(protocolText: string): string {
  const lines = protocolText.split("\n");
  const start = lines.findIndex((l) => /^## Addendum .+ \(A11\)\s*$/.test(l));
  if (start < 0) return "";
  const next = lines.findIndex((l, i) => i > start && /^## Addendum /.test(l));
  return lines.slice(start, next < 0 ? lines.length : next).join("\n");
}

/** Figure ids named in the A11 section (backticked ids on its list lines). */
export function a11FigureIds(protocolText: string): string[] {
  return a11Section(protocolText)
    .split("\n")
    .filter((l) => /^- `/.test(l))
    .map((l) => /^- `([^`]+)`/.exec(l)![1]!);
}

function records(signoffPath: string) {
  return fs
    .readFileSync(signoffPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function a11Signed({ protocolPath, signoffPath }: { protocolPath: string; signoffPath: string }): boolean {
  try {
    assertA11Signed({ protocolPath, signoffPath });
    return true;
  } catch {
    return false;
  }
}

/** Throws unless A11 exists and every item is approved for the current section digest. */
export function assertA11Signed(opts?: { protocolPath?: string; signoffPath?: string }): void {
  const protocolPath = opts?.protocolPath ?? path.join(process.cwd(), "protocol", "PROTOCOL.md");
  const signoffPath = opts?.signoffPath ?? path.join(resolveDataDir(), "decisions", "signoff.jsonl");
  const section = a11Section(fs.readFileSync(protocolPath, "utf8"));
  if (!section) throw new Error("A11: protocol addendum A11 missing");
  const digest = crypto.createHash("sha256").update(section).digest("hex");
  if (!fs.existsSync(signoffPath)) throw new Error(`A11: sign-off file missing: ${signoffPath}`);
  const all = records(signoffPath);
  for (const name of A11_ITEMS) {
    const forItem = all.filter((r) => r.item === name && r.docDigest === digest);
    if (forItem.some((r) => r.decision === "rejected")) throw new Error(`A11: item rejected — ${name}`);
    if (!forItem.some((r) => r.decision === "approved")) throw new Error(`A11: item not approved (digest-bound) — ${name}`);
  }
}
