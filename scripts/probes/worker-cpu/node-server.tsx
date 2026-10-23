// Plan 07-11a container probe: the Worker probe's three routes on plain Node, for a free container
// host. Synthetic data only. Each /hash and /render response carries x-cpu-ms, the process CPU
// (user + system, all threads, so scrypt's libuv thread counts) used by that request; requests
// must be sequential or the deltas mix (Pitfall 6). Listens on PORT (default 10000).
import { createServer } from "node:http";
import { renderToReadableStream } from "react-dom/server";
import { hashPassword } from "better-auth/crypto";
import { HEALTH_BODY, ReportPage, SYNTHETIC_PASSWORD } from "./page";

async function handle(pathname: string): Promise<{ status: number; type: string; body: string; cpuMs?: number }> {
  if (pathname === "/health") return { status: 200, type: "text/plain", body: HEALTH_BODY };
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  let out: Record<string, unknown>;
  if (pathname === "/hash") {
    const hash = await hashPassword(SYNTHETIC_PASSWORD);
    out = { route: "hash", ok: hash.includes(":") };
  } else if (pathname === "/render") {
    // TanStack Start's renderRouterToStream prefers renderToReadableStream when React offers it.
    const stream = await renderToReadableStream(<ReportPage />);
    await stream.allReady;
    const html = await new Response(stream).text();
    out = { route: "render", ok: html.includes('data-report="identifiable"'), bytes: html.length };
  } else {
    return { status: 404, type: "text/plain", body: "not found" };
  }
  const d = process.cpuUsage(c0);
  const cpuMs = (d.user + d.system) / 1000;
  return { status: 200, type: "application/json", body: JSON.stringify({ ...out, wall_ms: +(performance.now() - t0).toFixed(1), cpu_ms: +cpuMs.toFixed(1) }), cpuMs };
}

createServer((req, res) => {
  if (req.method !== "GET") {
    res.writeHead(405).end("method not allowed");
    return;
  }
  handle(new URL(req.url ?? "/", "http://probe.example").pathname).then(
    (r) => {
      const headers: Record<string, string> = { "content-type": r.type, "cache-control": "no-store" };
      if (r.cpuMs !== undefined) headers["x-cpu-ms"] = r.cpuMs.toFixed(1);
      res.writeHead(r.status, headers).end(r.body);
    },
    () => res.writeHead(500).end("error"),
  );
}).listen(Number(process.env.PORT ?? 10000), "0.0.0.0");
