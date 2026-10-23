// D-67 Addendum A9: span fix + spending guards + host defaults + archive policy.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveDataDir } from "../../app/server/db.ts";

export const A9_ITEMS = [
  "A9.1 Span fix (collector, 1500-char cap, resegment)",
  "A9.2 Spending guards (20k token cap, per-run dollar budget, BUDGET lines)",
  "A9.3 Host defaults (Ollama bulk; Token Factory only with budget flag)",
  "A9.4 Whole-page-spans archive is exploratory only",
] as const;

export function a9Section(protocolText: string): string {
  const lines = protocolText.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^## Addendum .+ \(A9\)\s*$/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## Addendum /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export async function a9Signed({
  protocolPath,
  signoffPath,
}: {
  protocolPath: string;
  signoffPath: string;
}): Promise<boolean> {
  const section = a9Section(fs.readFileSync(protocolPath, "utf8"));
  if (!section) return false;
  const digest = crypto.createHash("sha256").update(section).digest("hex");
  if (!fs.existsSync(signoffPath)) return false;
  const records = fs
    .readFileSync(signoffPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  for (const name of A9_ITEMS) {
    const forItem = records.filter((r) => r.item === name && r.docDigest === digest);
    if (forItem.some((r) => r.decision === "rejected")) return false;
    if (!forItem.some((r) => r.decision === "approved")) return false;
  }
  return true;
}

/** Throws if A9 is missing or not fully approved for the current PROTOCOL.md digest. */
export function assertA9Signed(opts?: { protocolPath?: string; signoffPath?: string }): void {
  const protocolPath = opts?.protocolPath ?? path.join(process.cwd(), "protocol", "PROTOCOL.md");
  const signoffPath = opts?.signoffPath ?? path.join(resolveDataDir(), "decisions", "signoff.jsonl");
  const section = a9Section(fs.readFileSync(protocolPath, "utf8"));
  if (!section) throw new Error("A9: protocol addendum A9 missing — refuse post-fix coding counts");
  const digest = crypto.createHash("sha256").update(section).digest("hex");
  if (!fs.existsSync(signoffPath)) throw new Error(`A9: sign-off file missing: ${signoffPath}`);
  const records = fs
    .readFileSync(signoffPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  for (const name of A9_ITEMS) {
    const forItem = records.filter((r) => r.item === name && r.docDigest === digest);
    if (forItem.some((r) => r.decision === "rejected")) {
      throw new Error(`A9: item rejected — ${name}`);
    }
    if (!forItem.some((r) => r.decision === "approved")) {
      throw new Error(`A9: item not approved (digest-bound) — ${name}`);
    }
  }
}
