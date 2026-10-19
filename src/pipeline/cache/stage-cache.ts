// COD-06 resumability: a content-addressed, project-scoped stage cache.
//
// Every pipeline stage's output is keyed by sha256(projectId, stage, input).
// projectId and stage are mandatory, separate parameters — never folded into
// `input` by a caller — so two different projects' otherwise-identical stage
// input can never collide into the same key. A cache lookup is existence-
// based (does the keyed file exist), never truthiness-based, so a stage
// whose real output is `[]` or `{}` is still a cache hit on resume.
//
// Pattern generalized from contract.ts's loadGateFile() (hashes a file's
// content and uses the hash as the record of what ran) and
// vendor/ai-output-to-value/PIN.json (the same convention for pinned files).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveDataDir } from "../../app/server/db.ts";

/** Every caller's default cache directory convention (COD-06). */
export function defaultCacheDir(): string {
  return path.join(resolveDataDir(), "pipeline", "cache");
}

export function stageCacheKey(projectId: string, stage: string, input: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify({ projectId, stage, input })).digest("hex");
}

export type CacheLookup<T> = { hit: true; value: T } | { hit: false };

/** Existence-based lookup: the file's presence is the only miss/hit signal. */
export function readCached<T>(cacheDir: string, key: string): CacheLookup<T> {
  const file = path.join(cacheDir, `${key}.json`);
  if (!fs.existsSync(file)) return { hit: false };
  return { hit: true, value: JSON.parse(fs.readFileSync(file, "utf8")) as T };
}

export function writeCached(cacheDir: string, key: string, value: unknown): void {
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cacheDir, `${key}.json`), JSON.stringify(value), { mode: 0o600 });
}

/**
 * Compute-or-serve: on a cache hit, returns the cached value without calling
 * `compute`; on a miss, calls `compute()`, writes the result, and returns it.
 */
export async function withStageCache<T>(
  cacheDir: string,
  projectId: string,
  stage: string,
  input: unknown,
  compute: () => Promise<T>,
  /** Return false to leave a computed value uncached (e.g. a fallback that a re-run should retry). */
  shouldCache: (value: T) => boolean = () => true,
): Promise<{ value: T; fromCache: boolean }> {
  const key = stageCacheKey(projectId, stage, input);
  const cached = readCached<T>(cacheDir, key);
  if (cached.hit) return { value: cached.value, fromCache: true };
  const value = await compute();
  if (shouldCache(value)) writeCached(cacheDir, key, value);
  return { value, fromCache: false };
}
