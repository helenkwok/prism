// Session IP clean-up (Helen, 2026-10-23): better-auth keeps the client IP on each
// session row; rate limiting needs it only while the session is young. Sessions
// created more than a day ago get ipAddress NULL. Run at boot and hourly (boot.ts).
import type { Kysely } from "kysely";

export const SESSION_IP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Blank session.ipAddress on sessions older than maxAgeMs. Returns the number of
 * rows blanked. better-auth's sqlite adapter stores dates as ISO-8601 UTC strings
 * (supportsDates is false), which compare correctly as text.
 */
export async function blankOldSessionIps(
  db: Kysely<any>,
  now: Date = new Date(),
  maxAgeMs: number = SESSION_IP_MAX_AGE_MS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - maxAgeMs).toISOString();
  const result = await db
    .updateTable("session")
    .set({ ipAddress: null })
    .where("ipAddress", "is not", null)
    .where("createdAt", "<", cutoff)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}
