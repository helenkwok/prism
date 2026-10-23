// Runs the Rsbuild production build on Node (TanStack Start hosting guide: serve
// dist/client as static files, send every other request to the server entry's
// fetch). Node built-ins only. PORT and HOST as before; PORT=0 picks a free port.
import fs from "node:fs";
import http from "node:http";
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

/** The file under dist/client for a URL path, or null (no file, a directory, or outside dist/client). */
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
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

async function main() {
  // Importing the entry runs the start-up checks (src/app/server.ts); a failed
  // check exits the process before it listens.
  const { default: entry } = await import(pathToFileURL(path.join(root, "dist", "server", "index.js")).href);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const file = (req.method === "GET" || req.method === "HEAD") && staticFile(url.pathname);
      if (file) {
        res.writeHead(200, {
          "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
          "x-content-type-options": "nosniff",
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
      const request = new Request(new URL(req.url ?? "/", `http://${host}`), {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([k, v]) =>
          v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]],
        ),
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
