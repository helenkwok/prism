import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "../../app/server/db.ts";

export const A10_ITEMS = ["A10.1 Primary recode budget correction", "A10.2 Paired confirmer settings correction"] as const;

export function a10Section(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex(line => /^## Addendum .+ \(A10\)\s*$/.test(line));
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^## Addendum /.test(lines[i])) { end = i; break; }
  return lines.slice(start, end).join("\n");
}

export function assertA10Signed(opts?: { protocolPath?: string; signoffPath?: string }) {
  const section = a10Section(fs.readFileSync(opts?.protocolPath ?? path.resolve("protocol/PROTOCOL.md"), "utf8"));
  if (!section) throw new Error("A10 proposal missing");
  const digest = crypto.createHash("sha256").update(section).digest("hex");
  const file = opts?.signoffPath ?? path.join(resolveDataDir(), "decisions", "signoff.jsonl");
  const records = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  for (const item of A10_ITEMS) {
    const matches = records.filter(row => row.item === item && row.docDigest === digest);
    if (!matches.some(row => row.decision === "approved") || matches.some(row => row.decision === "rejected")) throw new Error(`A10 not approved: ${item}`);
  }
}
