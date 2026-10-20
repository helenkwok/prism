// The screened pilot draw (D-42, DSC-02, A5) as one command:
//   node src/pipeline/select/draw-pilot.ts [--target 20] [--out pilot-projects.json]
// Writes PRISM_DATA_DIR/pipeline/<out> and screening-log.json (one outcome per walked record,
// plus PRISMA counts). Every screening call is cached, so a re-run costs nothing.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveDataDir } from "../../app/server/db.ts";
import { withStageCache, defaultCacheDir } from "../cache/stage-cache.ts";
import { createClient, PINNED_BASE_URL } from "../coding/nebius-client.ts";
import { readKey } from "../run.ts";
import { renderText } from "../evidence/render.ts";
import { drawScreened, type FramePost } from "./draw.ts";
import { PILOT_DRAW_SEED } from "./pilot-draw.ts";
import { screenCandidate, screenMessages, SCREENER_MODEL, STAGE1_THINKING } from "./screen-model.ts";
import { preflightCandidate } from "../../../scripts/spikes/pick-projects.mjs";

/** Stage 2 reads at most this much page text (about 3k tokens). */
const STAGE2_TEXT_CAP = 12000;

const hash = (v: unknown) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** Cached screen1 / preflight / render / screen2 closures shared by the pilot and the 300 draw.
 * `preflightVersion` is part of the cache key: 1 = legacy (page then robots), 2 = robots-first. */
export function makeScreeners({
  client,
  cacheDir,
  preflightVersion,
}: {
  client: { request: (p: string, init: { method: string; body: unknown }) => Promise<{ ok: boolean; status: number; json: unknown }> };
  cacheDir: string;
  preflightVersion: number;
}) {
  const cached = (id: string, stage: string, input: unknown, compute: () => Promise<any>) =>
    withStageCache(cacheDir, id, stage, input, compute).then((r) => r.value);

  return {
    screen1: (p: FramePost) => {
      const c = { title: p.title, url: p.url };
      return cached(p.id, "screen1", { model: SCREENER_MODEL, thinking: STAGE1_THINKING, req: hash(screenMessages(1, c)) }, () =>
        screenCandidate(client as any, 1, c, { thinking: STAGE1_THINKING }),
      );
    },
    preflight: (p: FramePost) =>
      cached(p.id, "preflight", { url: p.url, v: preflightVersion }, () =>
        preflightCandidate({ id: p.id, title: p.title, url: p.url, created_at: p.created_at }),
      ),
    render: (finalUrl: string) => cached(finalUrl, "render-text", { v: 1 }, async () => renderText(finalUrl)),
    screen2: (p: FramePost, finalUrl: string, text: string) => {
      const c = { title: p.title, url: finalUrl, text: text.slice(0, STAGE2_TEXT_CAP) };
      return cached(p.id, "screen2", { model: SCREENER_MODEL, thinking: true, req: hash(screenMessages(2, c)) }, () =>
        screenCandidate(client as any, 2, c, { thinking: true }),
      );
    },
  };
}

export async function drawPilot({ targetN = 20, out = "pilot-projects.json", seed = PILOT_DRAW_SEED } = {}) {
  const dataDir = resolveDataDir();
  const cacheDir = defaultCacheDir();
  const posts: FramePost[] = JSON.parse(fs.readFileSync(path.join(dataDir, "pipeline", "frame.json"), "utf8")).posts;
  const client = createClient({ baseUrl: PINNED_BASE_URL, apiKey: readKey("NEBIUS_API_KEY", "nebius.key")! });

  // Pilot keeps preflightVersion 1 so it still reproduces from its cached v1 entries.
  const screeners = makeScreeners({ client, cacheDir, preflightVersion: 1 });

  const result = await drawScreened({
    posts,
    seed,
    targetN,
    ...screeners,
  });

  const dir = path.join(dataDir, "pipeline");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, out), JSON.stringify(result.entries, null, 2), { mode: 0o600 });
  fs.writeFileSync(
    path.join(dir, "screening-log.json"),
    JSON.stringify({ seed, targetN, model: SCREENER_MODEL, stage1Thinking: STAGE1_THINKING, counts: result.counts, log: result.log }, null, 2),
    { mode: 0o600 },
  );
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  // No top-level await: the acceptance script require()s this module.
  drawPilot({ targetN: Number(arg("--target") ?? 20), out: arg("--out") ?? "pilot-projects.json" })
    .then((r) => {
      console.log("PRISMA:", JSON.stringify(r.counts));
      if (r.entries.length < Number(arg("--target") ?? 20)) {
        console.error(`frame exhausted: ${r.entries.length} included`);
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error(err?.stack ?? err);
      process.exitCode = 1;
    });
}
