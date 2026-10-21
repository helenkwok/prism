// D-66 (Helen 2026-10-21): never delete or overwrite the Tavily-142 archive.
// Basename match + path-inside-tree refuse. OS chmod a-w is defence in depth;
// this module is the code path that must still refuse even if permissions change.

import fs from "node:fs";
import path from "node:path";

/** Exact backup directory basenames that must never be written or deleted. */
export const PROTECTED_BACKUP_BASENAMES: ReadonlySet<string> = new Set([
  "2026-10-21-tavily-142",
]);

/**
 * Throws if `backupDir` is a protected archive basename, or resolves inside a
 * protected backup tree. Call before any mkdir/write/rm of a backup path.
 */
export function assertBackupWritable(backupDir: string): void {
  const resolved = path.resolve(backupDir);
  const base = path.basename(resolved);
  if (PROTECTED_BACKUP_BASENAMES.has(base)) {
    throw new Error(
      `protected backup (D-66): refusing write/overwrite of ${base}: ${resolved}`,
    );
  }

  // Also refuse paths nested under a protected tree (e.g. …/2026-10-21-tavily-142/foo).
  for (const name of PROTECTED_BACKUP_BASENAMES) {
    const needle = `${path.sep}${name}${path.sep}`;
    if (resolved.includes(needle) || resolved.endsWith(`${path.sep}${name}`)) {
      throw new Error(
        `protected backup (D-66): refusing write inside ${name}: ${resolved}`,
      );
    }
  }

  // If the path already exists as a realpath that lands on a protected tree.
  try {
    if (fs.existsSync(resolved)) {
      const real = fs.realpathSync.native(resolved);
      const realBase = path.basename(real);
      if (PROTECTED_BACKUP_BASENAMES.has(realBase)) {
        throw new Error(
          `protected backup (D-66): refusing write/overwrite of ${realBase}: ${real}`,
        );
      }
      for (const name of PROTECTED_BACKUP_BASENAMES) {
        const needle = `${path.sep}${name}${path.sep}`;
        if (real.includes(needle) || real.endsWith(`${path.sep}${name}`)) {
          throw new Error(
            `protected backup (D-66): refusing write inside ${name}: ${real}`,
          );
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("protected backup")) throw err;
    // realpath failures (dangling) — basename checks above already ran
  }
}
