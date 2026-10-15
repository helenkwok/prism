// DSC-02: screening — applies protocol/PROTOCOL.md section 2's inclusion rule
// and the seven reason codes (five content classes plus register row R13's
// two operational additions, `duplicate` and `unreachable-at-screening`) to a
// frame of candidates, producing PRISMA-ready reason-code counts.
//
// screen.ts works on the raw frame, before boundary.ts's ownership-boundary
// derivation runs (that happens downstream, after inclusion). Duplicate
// detection here therefore uses a cheaper proxy — the candidate URL's
// lowercased, www-stripped hostname — rather than importing boundary.ts.

import type { FramePostLike } from "./slice-projects.ts";

export type ReasonCode =
  | "library-no-product-claim"
  | "model-or-paper"
  | "dataset"
  | "ai-adjacent"
  | "demo-no-site"
  | "duplicate"
  | "unreachable-at-screening";

const REASON_CODES: ReasonCode[] = [
  "library-no-product-claim",
  "model-or-paper",
  "dataset",
  "ai-adjacent",
  "demo-no-site",
  "duplicate",
  "unreachable-at-screening",
];

export interface ScreenCandidate extends FramePostLike {
  reason?: ReasonCode;
}

export interface ScreenResult {
  included: ScreenCandidate[];
  excluded: { post: ScreenCandidate; reasonCode: ReasonCode }[];
  counts: Record<ReasonCode | "included", number>;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function zeroCounts(): Record<ReasonCode | "included", number> {
  const counts = { included: 0 } as Record<ReasonCode | "included", number>;
  for (const code of REASON_CODES) counts[code] = 0;
  return counts;
}

export function screenFrame(frame: { posts: ScreenCandidate[] }): ScreenResult {
  const counts = zeroCounts();
  const included: ScreenCandidate[] = [];
  const excluded: { post: ScreenCandidate; reasonCode: ReasonCode }[] = [];
  const includedHostnames = new Set<string>();

  for (const post of frame.posts) {
    if (post.reason) {
      excluded.push({ post, reasonCode: post.reason });
      counts[post.reason] += 1;
      continue;
    }

    const hostname = hostnameOf(post.url);
    if (hostname && includedHostnames.has(hostname)) {
      excluded.push({ post, reasonCode: "duplicate" });
      counts.duplicate += 1;
      continue;
    }

    included.push(post);
    counts.included += 1;
    if (hostname) includedHostnames.add(hostname);
  }

  return { included, excluded, counts };
}
