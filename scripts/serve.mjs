// Runs the Rsbuild production build on Node (TanStack Start hosting guide: serve
// dist/client as static files, send every other request to the server entry's
// fetch). Node built-ins only. PORT and HOST as before; PORT=0 picks a free port.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { Readable, pipeline } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientDir = path.join(root, "dist", "client");

const TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * The file under dist/client for a URL path, or null (no file, a directory, or outside dist/client).
 * A path ending in "/" serves that directory's index.html (the /office editors live at /office-apps/<tool>/).
 */
export function staticFile(urlPath, base = clientDir) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const file = path.resolve(base, `.${path.posix.normalize(`/${decoded}`)}`);
  if (!file.startsWith(base + path.sep)) return null;
  const target = decoded.endsWith("/") ? path.join(file, "index.html") : file;
  try {
    return fs.statSync(target).isFile() ? target : null;
  } catch {
    return null;
  }
}

/**
 * better-auth keys its rate limiter on this header (src/app/server/auth.ts,
 * advanced.ipAddress.ipAddressHeaders). serve.mjs always sets it itself, so a
 * client cannot pick its own bucket by sending one.
 */
export const CLIENT_IP_HEADER = "x-forwarded-for";

const unmap = (ip) => (ip?.toLowerCase().startsWith("::ffff:") && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip);

/**
 * Optional trusted reverse proxy: PRISM_TRUSTED_PROXY_HEADER names the header the
 * proxy sets to the client's address, PRISM_TRUSTED_PROXY_IPS lists the proxy's own
 * addresses (comma-separated IPs). Unset: the socket peer is the client. Half a
 * configuration is refused rather than guessed.
 */
export function proxyConfig(env = process.env) {
  const header = env.PRISM_TRUSTED_PROXY_HEADER?.trim().toLowerCase();
  const ips = (env.PRISM_TRUSTED_PROXY_IPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!header && ips.length === 0) return null;
  if (!header) throw new Error("PRISM_TRUSTED_PROXY_IPS is set without PRISM_TRUSTED_PROXY_HEADER");
  if (ips.length === 0) throw new Error("PRISM_TRUSTED_PROXY_HEADER is set without PRISM_TRUSTED_PROXY_IPS");
  // ponytail: exact addresses only; add CIDR ranges if a host's proxy pool needs them.
  const bad = ips.filter((ip) => !net.isIP(ip));
  if (bad.length) throw new Error(`PRISM_TRUSTED_PROXY_IPS entry is not an IP address: ${bad.join(", ")}`);
  return { header, ips: new Set(ips.map(unmap)) };
}

/**
 * The client address for rate limiting: the socket peer, or, when the peer is the
 * trusted proxy, the last address in the proxy's header (the hop the proxy itself
 * saw). A missing or malformed value falls back to the socket peer.
 */
export function clientIp(socketAddress, headers, proxy) {
  const peer = unmap(socketAddress) ?? null;
  if (!peer || !proxy || !proxy.ips.has(peer)) return peer;
  const raw = headers[proxy.header];
  const last = (Array.isArray(raw) ? raw.join(",") : (raw ?? "")).split(",").map((s) => s.trim()).filter(Boolean).at(-1);
  return last && net.isIP(unmap(last)) ? unmap(last) : peer;
}

/**
 * The scheme the client used: https only when the socket peer is the trusted proxy
 * and the last value of its x-forwarded-proto is exactly "https"; http otherwise.
 * Behind a TLS-terminating proxy the app must see https, or redirects point at http
 * and the CSRF origin check refuses the browser's https Origin.
 */
export function requestScheme(socketAddress, headers, proxy) {
  const peer = unmap(socketAddress) ?? null;
  if (!peer || !proxy || !proxy.ips.has(peer)) return "http";
  const raw = headers["x-forwarded-proto"];
  const last = (Array.isArray(raw) ? raw.join(",") : (raw ?? "")).split(",").map((s) => s.trim()).at(-1);
  return last === "https" ? "https" : "http";
}

/** Node request headers as Fetch header pairs, with CLIENT_IP_HEADER replaced by the resolved client IP. */
export function requestHeaders(nodeHeaders, ip) {
  const pairs = Object.entries(nodeHeaders).flatMap(([k, v]) =>
    v === undefined || k === CLIENT_IP_HEADER ? [] : Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]],
  );
  if (ip) pairs.push([CLIENT_IP_HEADER, ip]);
  return pairs;
}

async function main() {
  const proxy = proxyConfig();

  // Importing the entry runs the start-up checks (src/app/server.ts); a failed
  // check exits the process before it listens.
  const { default: entry } = await import(pathToFileURL(path.join(root, "dist", "server", "index.js")).href);

  // D-78 measurement hook (plan 07-11), off unless MEASURE_CPU=1: this process's
  // CPU (all threads, so scrypt's libuv pool counts) from request start until the
  // response has finished, streamed SSR included. Only meaningful for one request
  // at a time.
  const measure = process.env.MEASURE_CPU === "1";

  const server = http.createServer(async (req, res) => {
    if (measure) {
      const c0 = process.cpuUsage();
      res.once("finish", () => {
        const c = process.cpuUsage(c0);
        const path = (req.url ?? "/").split("?")[0];
        console.log(`MEASURE request method=${req.method} path=${path} status=${res.statusCode} cpu_ms=${((c.user + c.system) / 1000).toFixed(2)}`);
      });
    }
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const file = (req.method === "GET" || req.method === "HEAD") && staticFile(url.pathname);
      if (file) {
        res.writeHead(200, {
          "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
          "x-content-type-options": "nosniff",
          // Static files bypass Start's middleware (src/app/start.ts), so noindex is set here too (APP-04).
          "x-robots-tag": "noindex, nofollow",
          // Hashed names under /assets never change; anything else is revalidated.
          "cache-control": url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store",
        });
        if (req.method === "HEAD") return void res.end();
        // A client that disconnects mid-stream must not crash the server.
        return void pipeline(fs.createReadStream(file), res, () => {});
      }

      const host = req.headers.host ?? "localhost";
      const controller = new AbortController();
      res.once("close", () => controller.abort());
      const scheme = requestScheme(req.socket.remoteAddress, req.headers, proxy);
      const request = new Request(new URL(req.url ?? "/", `${scheme}://${host}`), {
        method: req.method,
        headers: requestHeaders(req.headers, clientIp(req.socket.remoteAddress, req.headers, proxy)),
        body: req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req),
        duplex: "half",
        signal: controller.signal,
      });
      const response = await entry.fetch(request);
      const headers = {};
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie") headers[key] = value;
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) headers["set-cookie"] = cookies;
      headers["x-content-type-options"] ??= "nosniff";
      res.writeHead(response.status, response.statusText || undefined, headers);
      if (!response.body || req.method === "HEAD") return void res.end();
      pipeline(Readable.fromWeb(response.body), res, () => {});
    } catch (err) {
      console.error("[prism] request failed:", err instanceof Error ? err.message : String(err));
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Internal Server Error");
    }
  });

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST || undefined; // unset: every interface, as before
  server.listen(port, host, () => {
    const addr = server.address();
    console.log(`[prism] listening on http://${host ?? "localhost"}:${typeof addr === "object" && addr ? addr.port : port}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
