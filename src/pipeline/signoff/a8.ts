// D-66 Addendum A8: free own-site collector; digest-bound sign-off before coded results count.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveDataDir } from "../../app/server/db.ts";

export const A8_ITEMS = [
  "A8.1 Free own-site collector for bulk coding",
  "A8.2 Tavily-142 archive retained read-only",
  "A8.3 Tavily-vs-free cross-check is exploratory only",
] as const;

export function a8Section(protocolText: string): string {
  const lines = protocolText.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^## Addendum .+ \(A8\)\s*$/.test(lines[i])) {
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

export async function a8Signed({
  protocolPath,
  signoffPath,
}: {
  protocolPath: string;
  signoffPath: string;
}): Promise<boolean> {
  const section = a8Section(fs.readFileSync(protocolPath, "utf8"));
  if (!section) return false;
  const digest = crypto.createHash("sha256").update(section).digest("hex");
  if (!fs.existsSync(signoffPath)) return false;
  const records = fs
    .readFileSync(signoffPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  for (const name of A8_ITEMS) {
    const forItem = records.filter((r) => r.item === name && r.docDigest === digest);
    if (forItem.some((r) => r.decision === "rejected")) return false;
    if (!forItem.some((r) => r.decision === "approved")) return false;
  }
  return true;
}

/** Throws if A8 is missing or not fully approved for the current PROTOCOL.md digest. */
export function assertA8Signed(opts?: { protocolPath?: string; signoffPath?: string }): void {
  const protocolPath = opts?.protocolPath ?? path.join(process.cwd(), "protocol", "PROTOCOL.md");
  const signoffPath = opts?.signoffPath ?? path.join(resolveDataDir(), "decisions", "signoff.jsonl");
  // Sync wrapper: a8Signed is async only for API parity with a7Signed; no I/O awaits needed.
  const section = a8Section(fs.readFileSync(protocolPath, "utf8"));
  if (!section) throw new Error("A8: protocol addendum A8 missing — refuse free-collector coding");
  const digest = crypto.createHash("sha256").update(section).digest("hex");
  if (!fs.existsSync(signoffPath)) throw new Error(`A8: sign-off file missing: ${signoffPath}`);
  const records = fs
    .readFileSync(signoffPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  for (const name of A8_ITEMS) {
    const forItem = records.filter((r) => r.item === name && r.docDigest === digest);
    if (forItem.some((r) => r.decision === "rejected")) {
      throw new Error(`A8: item rejected — ${name}`);
    }
    if (!forItem.some((r) => r.decision === "approved")) {
      throw new Error(`A8: item not approved (digest-bound) — ${name}`);
    }
  }
}
