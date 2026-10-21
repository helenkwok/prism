// D-67: re-segment all sample projects from existing snapshot redactedText.
// Updates spans in place (same content-addressed hash = same redactedText).
// Does not delete snapshot files. Clears segment stage-cache entries so the
// next run rebuilds prefixed span lists from the new spans.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDataDir } from "../../app/server/db.ts";
import { defaultCacheDir } from "../cache/stage-cache.ts";
import { MAX_SPAN_CHARS, segmentText } from "./segment.ts";

export type ResegmentResult = {
  projects: number;
  snapshotsUpdated: number;
  maxSpanCharsBefore: number;
  maxSpanChars: number;
  spansOverCapBefore: number;
  spansOverCapAfter: number;
};

export function resegmentProjects({
  dataDir,
  projectsPath,
}: {
  dataDir: string;
  projectsPath: string;
}): ResegmentResult {
  const projects = JSON.parse(fs.readFileSync(projectsPath, "utf8")) as { n: number; hnId?: string }[];
  const snapshotsDir = path.join(dataDir, "pipeline", "snapshots");
  const manifestsDir = path.join(dataDir, "pipeline", "manifests");
  const cacheDir = defaultCacheDir();

  let snapshotsUpdated = 0;
  let maxSpanCharsBefore = 0;
  let maxSpanChars = 0;
  let spansOverCapBefore = 0;
  let spansOverCapAfter = 0;
  const seenHashes = new Set<string>();

  for (const p of projects) {
    const manifestPath = path.join(manifestsDir, `${p.n}.json`);
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      snapshotHashesInCollectionOrder?: string[];
      hnId?: string;
    };
    const hashes = manifest.snapshotHashesInCollectionOrder ?? [];
    for (const hash of hashes) {
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);
      const file = path.join(snapshotsDir, `${hash}.json`);
      if (!fs.existsSync(file)) continue;
      const snap = JSON.parse(fs.readFileSync(file, "utf8")) as {
        spans: { id: string; text: string }[];
        redactedText: string;
        [k: string]: unknown;
      };
      for (const s of snap.spans ?? []) {
        if (s.text.length > MAX_SPAN_CHARS) spansOverCapBefore += 1;
        if (s.text.length > maxSpanCharsBefore) maxSpanCharsBefore = s.text.length;
      }
      const newSpans = segmentText(snap.redactedText ?? "");
      for (const s of newSpans) {
        if (s.text.length > MAX_SPAN_CHARS) spansOverCapAfter += 1;
        if (s.text.length > maxSpanChars) maxSpanChars = s.text.length;
      }
      snap.spans = newSpans;
      fs.writeFileSync(file, JSON.stringify(snap), { mode: 0o600 });
      snapshotsUpdated += 1;
    }
  }

  // Drop segment stage cache files so run.ts rebuilds prefixed spans from updated snapshots.
  // Cache keys are opaque hashes; safest is to remove files whose JSON mentions "segment" stage
  // — actually keys don't store stage name in file. Delete all cache entries that look like
  // segment outputs (have snapshotHashesInCollectionOrder), or wipe cacheDir segment by scanning.
  if (fs.existsSync(cacheDir)) {
    for (const name of fs.readdirSync(cacheDir)) {
      if (!name.endsWith(".json")) continue;
      const full = path.join(cacheDir, name);
      try {
        const v = JSON.parse(fs.readFileSync(full, "utf8"));
        if (v && typeof v === "object" && Array.isArray(v.spans) && Array.isArray(v.snapshotHashesInCollectionOrder)) {
          fs.unlinkSync(full);
        }
      } catch {
        // ignore unreadable
      }
    }
  }

  return {
    projects: projects.length,
    snapshotsUpdated,
    maxSpanCharsBefore,
    maxSpanChars,
    spansOverCapBefore,
    spansOverCapAfter,
  };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]) === "resegment.ts" &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const i = process.argv.indexOf("--projects");
  const dataDir = resolveDataDir();
  const projectsPath =
    i >= 0 && process.argv[i + 1]
      ? process.argv[i + 1]
      : path.join(dataDir, "pipeline", "sample-projects.json");
  const result = resegmentProjects({ dataDir, projectsPath });
  process.stdout.write(`RESEGMENT: ${JSON.stringify(result)}\n`);
  if (result.spansOverCapAfter > 0) {
    process.stderr.write(`resegment: ${result.spansOverCapAfter} spans still over ${MAX_SPAN_CHARS}\n`);
    process.exitCode = 1;
  }
}
