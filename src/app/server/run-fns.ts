// APP-02: the live run's server functions. Each opens with requireRole("admin")
// (T-07-35); the work is in live-run.ts, loaded here on the server only so the
// client bundle never reaches the queue, the database or DNS.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { AccessError, requireRole } from "./access.ts";

async function deps() {
  const { getDb } = await import("./db.ts");
  const live = await import("./live-run.ts");
  return { db: getDb(), live };
}

// BYOK: keys arrive only in this POST body. They go into the job object in memory and nowhere
// else (no database, no log, no URL); live-run.ts validates their shape and the allow-listed ids.
type StartInput = { url: string; modelKey?: string; tavilyKey?: string; provider?: string; collector?: string };
export const startLiveRun = createServerFn({ method: "POST" })
  .validator((d: StartInput) => {
    const { url, ...options } = (d ?? {}) as StartInput;
    return { url: typeof url === "string" ? url : "", options };
  })
  .handler(async ({ data }) => {
    const session = await requireRole("admin");
    const { getRequestHeaders, setResponseStatus } = await import("@tanstack/react-start/server");
    const { db, live } = await deps();
    const { runner } = live.runnerFromEnv();
    const resolver = process.env.PRISM_LIVE_RUNNER === "fixture" ? live.fixtureResolver : undefined;
    try {
      return await live.startLiveRunCore(session, getRequestHeaders() as unknown as Headers, data.url, { db, runner, resolver }, data.options);
    } catch (err) {
      if (err instanceof AccessError) setResponseStatus(err.status);
      throw err;
    }
  });

export const getRunStatus = createServerFn({ method: "GET" })
  .validator((d: { jobId: number | string }) => ({ jobId: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).parse(d.jobId) }))
  .handler(async ({ data }) => {
    await requireRole("admin");
    const { db, live } = await deps();
    const status = await live.readRunStatus(db, data.jobId);
    if (!status) {
      // Admin-only, so saying a job does not exist leaks nothing.
      const { setResponseStatus } = await import("@tanstack/react-start/server");
      setResponseStatus(404);
    }
    return status;
  });

export const listRecentRuns = createServerFn({ method: "GET" }).handler(async () => {
  await requireRole("admin");
  const { db, live } = await deps();
  return { runs: await live.readRecentRuns(db), budget: await live.readBudgetSummary(db) };
});
