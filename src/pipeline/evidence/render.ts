// The rendered text of one page, from a headless browser (agent-browser), for pages whose HTML
// carries no text until JavaScript runs (single-page apps). Used where a page's own text is
// needed and the raw HTML is thin: stage 2 screening, and the bulk-run render stage (D-55).
// A throwaway session per call, no profile, one browser at a time (the caller runs these
// sequentially or behind pLimit(1)). Never throws: "" on any failure.

import { execFile, execFileSync as syncExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RenderImpl = (url: string) => string;
export type RenderImplAsync = (url: string) => Promise<string>;

export const renderText: RenderImpl = (url) => {
  const env = { ...process.env, AGENT_BROWSER_SESSION: `prism-render-${process.pid}-${Date.now()}` };
  const ab = (args: string[], timeout = 30000) =>
    syncExecFile("agent-browser", args, { env, timeout, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
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

/** Same agent-browser steps as renderText, async so concurrent pipeline work is not stalled (Pitfall 3). */
export const renderTextAsync: RenderImplAsync = async (url) => {
  const env = { ...process.env, AGENT_BROWSER_SESSION: `prism-render-${process.pid}-${Date.now()}` };
  const ab = async (args: string[], timeout = 30000) => {
    const { stdout } = await execFileAsync("agent-browser", args, { env, timeout, encoding: "utf8" });
    return stdout;
  };
  try {
    await ab(["open", url], 45000);
    try {
      await ab(["wait", "--load", "networkidle"], 20000);
    } catch {
      await ab(["wait", "3000"]);
    }
    await ab(["wait", "1500"]);
    for (let i = 0; i < 6; i++) {
      await ab(["scroll", "down", "900"]);
      await ab(["wait", "300"]);
    }
    const raw = (await ab(["eval", "document.body ? document.body.innerText : ''"])).trim();
    const v = JSON.parse(raw);
    return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  } catch {
    return "";
  } finally {
    try {
      await ab(["close"]);
    } catch {
      // already closed
    }
  }
};
