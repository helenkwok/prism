// The rendered text of one page, from a headless browser (agent-browser), for pages whose HTML
// carries no text until JavaScript runs (single-page apps). Used where a page's own text is
// needed and the raw HTML is thin: stage 2 screening. A throwaway session per call, no profile,
// one browser at a time (the caller runs these sequentially). Never throws: "" on any failure.

import { execFileSync } from "node:child_process";

export type RenderImpl = (url: string) => string;

export const renderText: RenderImpl = (url) => {
  const env = { ...process.env, AGENT_BROWSER_SESSION: `prism-render-${process.pid}-${Date.now()}` };
  const ab = (args: string[], timeout = 30000) => execFileSync("agent-browser", args, { env, timeout, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    ab(["open", url], 45000);
    try {
      ab(["wait", "--load", "networkidle"], 20000);
    } catch {
      ab(["wait", "3000"]);
    }
    // Text can land after network idle (vect.pro: 0 characters at idle, 15,917 1.5 s later).
    ab(["wait", "1500"]);
    // Lazy sections render on scroll.
    for (let i = 0; i < 6; i++) {
      ab(["scroll", "down", "900"]);
      ab(["wait", "300"]);
    }
    const raw = ab(["eval", "document.body ? document.body.innerText : ''"]).trim();
    const v = JSON.parse(raw);
    return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  } catch {
    return "";
  } finally {
    try {
      ab(["close"]);
    } catch {
      // already closed
    }
  }
};
