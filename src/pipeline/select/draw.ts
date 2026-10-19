// DSC-02 + D-42: a screened, seeded draw (protocol section 2, addendum A5). Walks the frame in
// seeded draw order and screens each candidate as it is reached: duplicate host, stage 1 (title
// and URL), preflight (reachable, robots, boundary), stage 2 (the page's own text). Stops at
// targetN inclusions. Every walked candidate gets one recorded outcome, so the PRISMA counts
// cover exactly the records screened.

import { deriveBoundary } from "../evidence/boundary.ts";
import { sortPilotCandidates } from "./pilot-draw.ts";
import type { ModelReasonCode, ScreenDecision } from "./screen-model.ts";

/** Below this many characters of page text, stage 2 does not decide (A5): too little to judge. */
export const MIN_STAGE2_CHARS = 500;

export type Outcome =
  | { kind: "included"; stage2: "screened" | "insufficient-text"; textSource?: "html" | "rendered" }
  | { kind: "excluded"; stage: 1 | 2; reasonCode: ModelReasonCode | "duplicate" | "unreachable-at-screening" }
  /** Not a screening exclusion: the candidate cannot be collected within its terms or boundary. */
  | { kind: "not-collectable"; detail: "robots-blocked" | "redirected-off-boundary" };

export interface FramePost {
  id: string;
  title: string;
  url: string;
  created_at: string;
}

export interface PreflightResult {
  entry_url: string;
  final_url: string;
  boundary: unknown;
  type_class: string;
  page_text?: string;
  preflight: { robots_blocked: boolean; boundary_ok: boolean };
}

export interface DrawEntry {
  n: number;
  hn_id: string;
  title: string;
  entry_url: string;
  final_url: string;
  boundary: unknown;
  type_class: string;
  created_at: string;
  draw_rank: number;
  stage2: "screened" | "insufficient-text";
  textSource: "html" | "rendered";
}

/** The project's identity for duplicate detection: its ownership boundary, so two repositories on
 * github.com are two projects, while two posts of one site are one. */
function projectKey(url: string): string | null {
  try {
    const b = deriveBoundary(url);
    return `${b.host}${b.pathPrefix ?? ""}`;
  } catch {
    return null;
  }
}

export async function drawScreened({
  posts,
  seed,
  targetN,
  screen1,
  preflight,
  screen2,
  render = () => "",
}: {
  posts: FramePost[];
  seed?: string;
  targetN: number;
  screen1: (post: FramePost) => Promise<ScreenDecision>;
  preflight: (post: FramePost) => Promise<PreflightResult | null>;
  screen2: (post: FramePost, finalUrl: string, text: string) => Promise<ScreenDecision>;
  /** Rendered page text, tried when the HTML's own text is too thin (single-page apps). */
  render?: (finalUrl: string) => string | Promise<string>;
}) {
  const log: { id: string; rank: number; outcome: Outcome }[] = [];
  const entries: DrawEntry[] = [];
  const hosts = new Set<string>();
  let rank = 0;

  for (const post of sortPilotCandidates(posts, seed)) {
    if (entries.length === targetN) break;
    rank += 1;
    const record = (outcome: Outcome) => log.push({ id: post.id, rank, outcome });

    const host = projectKey(post.url);
    if (host && hosts.has(host)) {
      record({ kind: "excluded", stage: 1, reasonCode: "duplicate" });
      continue;
    }
    const s1 = await screen1(post);
    if (!s1.include) {
      record({ kind: "excluded", stage: 1, reasonCode: s1.reasonCode! });
      continue;
    }
    const p = await preflight(post);
    if (!p) {
      record({ kind: "excluded", stage: 2, reasonCode: "unreachable-at-screening" });
      continue;
    }
    if (p.preflight.robots_blocked || !p.preflight.boundary_ok) {
      record({ kind: "not-collectable", detail: p.preflight.robots_blocked ? "robots-blocked" : "redirected-off-boundary" });
      continue;
    }
    let text = p.page_text ?? "";
    let textSource: "html" | "rendered" = "html";
    if (text.length < MIN_STAGE2_CHARS) {
      const rendered = await render(p.final_url);
      if (rendered.length > text.length) {
        text = rendered;
        textSource = "rendered";
      }
    }
    let stage2: "screened" | "insufficient-text" = "insufficient-text";
    if (text.length >= MIN_STAGE2_CHARS) {
      const s2 = await screen2(post, p.final_url, text);
      if (!s2.include) {
        record({ kind: "excluded", stage: 2, reasonCode: s2.reasonCode! });
        continue;
      }
      stage2 = "screened";
    }
    record({ kind: "included", stage2, textSource });
    if (host) hosts.add(host);
    entries.push({
      n: entries.length + 1,
      hn_id: post.id,
      title: post.title,
      entry_url: p.entry_url,
      final_url: p.final_url,
      boundary: p.boundary,
      type_class: p.type_class,
      created_at: post.created_at,
      draw_rank: rank,
      stage2,
      textSource,
    });
  }

  return { entries, log, counts: prismaCounts(log) };
}

/** PRISMA counts over the walked records: screened, excluded per stage and reason, included. */
export function prismaCounts(log: { outcome: Outcome }[]) {
  const counts: Record<string, number> = { screened: log.length, included: 0, "included-insufficient-text": 0 };
  for (const { outcome: o } of log) {
    const k =
      o.kind === "included" ? (o.stage2 === "screened" ? "included" : "included-insufficient-text")
      : o.kind === "excluded" ? `stage${o.stage}:${o.reasonCode}`
      : `not-collectable:${o.detail}`;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}
