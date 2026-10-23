import fs from "node:fs";
import path from "node:path";

export type RepairMetadata = { baseDigest: string; lastValidationStage: "json_parse" | "zod" | "span_resolve"; model?: string; stage?: string };

/** Routing metadata contains no response payloads; raw diagnostics are append-only. */
export function readRepairIndex(dataDir: string): Record<string, RepairMetadata> {
  const file = path.join(dataDir, "validation", "coding-repair-index.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

export function recordRepairMetadata(dataDir: string, metadata: RepairMetadata): void {
  const file = path.join(dataDir, "validation", "coding-repair-index.json");
  const index = readRepairIndex(dataDir);
  index[metadata.baseDigest] = metadata;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.next`, JSON.stringify(index), { mode: 0o600 });
  fs.renameSync(`${file}.next`, file);
}
