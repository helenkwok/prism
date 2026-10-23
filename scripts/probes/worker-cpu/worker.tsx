// Plan 07-11a: throwaway CPU probe for Cloudflare Workers Free (D-79). Synthetic data only:
// a fixed synthetic password and the synthetic P01 ReportView. No bindings, no secrets.
//   GET /health  trivial 200, body "prism-cpu-probe ok" (no CPU work)
//   GET /hash    better-auth's own hashPassword (on workerd its "workerd" export picks
//                node:crypto scrypt, N=16384 r=16, the code path sign-in takes; Pitfall 4)
//   GET /render  the identifiable report page's markup (ReportPage in routes/p.$projectId.tsx:
//                notice, kicker, title, ReportBody) through React's streaming SSR, as TanStack
//                Start renders on this runtime, read to the end
// /hash and /render return their own wall time (on workerd the clock only moves across I/O);
// Cloudflare's telemetry gives the CPU time. Built by build.mjs; excluded from tsconfig because
// it imports the generated .build/p01-view.json.
import { renderToReadableStream } from "react-dom/server.edge";
import { hashPassword } from "better-auth/crypto";
import { FIXTURE_NOTICE, Notice } from "../../../src/app/components/Notice";
import { ReportBody } from "../../../src/app/components/report/report";
import type { ReportView } from "../../../src/report/view.ts";
import p01 from "./.build/p01-view.json";

const view = p01 as unknown as ReportView;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Same markup as ReportPage in src/app/routes/p.$projectId.tsx.
function ReportPage() {
  return (
    <article data-report="identifiable">
      {view.fixture ? (
        <Notice variant="fixture" className="mb-8">
          <span data-evaluative="">{FIXTURE_NOTICE}</span>
        </Notice>
      ) : null}
      <p className="text-[0.8125rem] font-semibold tracking-[0.12em] text-accent-ink uppercase">PRISM · Private report</p>
      <h1 className="mt-2 text-[2rem] leading-[1.15] font-semibold">{view.title}</h1>
      <ReportBody view={view} />
    </article>
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
    if (pathname === "/health") return new Response("prism-cpu-probe ok", { headers: { "cache-control": "no-store" } });
    if (pathname === "/hash") {
      const t0 = Date.now();
      const hash = await hashPassword("synthetic-probe-password-42");
      return json({ route: "hash", ok: hash.includes(":"), wall_ms: Date.now() - t0 });
    }
    if (pathname === "/render") {
      const t0 = Date.now();
      const stream = await renderToReadableStream(<ReportPage />);
      await stream.allReady;
      const html = await new Response(stream).text();
      return json({ route: "render", ok: html.includes('data-report="identifiable"'), bytes: html.length, wall_ms: Date.now() - t0 });
    }
    return new Response("not found", { status: 404 });
  },
};
