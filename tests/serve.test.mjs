// T-07-63: scripts/serve.mjs serves files from dist/client only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CLIENT_IP_HEADER, clientIp, proxyConfig, requestHeaders, requestScheme, staticFile } from "../scripts/serve.mjs";

test("staticFile resolves inside the client directory and refuses everything else", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prism-serve-"));
  const base = path.join(tmp, "client");
  fs.mkdirSync(path.join(base, "assets"), { recursive: true });
  fs.writeFileSync(path.join(base, "assets", "app.js"), "x");
  fs.writeFileSync(path.join(tmp, "secret.txt"), "s");
  fs.mkdirSync(path.join(tmp, "client-evil"));
  fs.writeFileSync(path.join(tmp, "client-evil", "x.js"), "e");
  try {
    assert.equal(staticFile("/assets/app.js", base), path.join(base, "assets", "app.js"));
    for (const p of [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
      "/..%5csecret.txt",
      "/../client-evil/x.js",
      "/assets/app.js%00.png",
      "/%E0%A4%A",
      "/",
      "/assets",
      "/missing.js",
    ]) {
      assert.equal(staticFile(p, base), null, p);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Rate-limit keying (07-08a follow-up): better-auth buckets sign-ins by the
// x-forwarded-for value serve.mjs sets. It comes from the socket peer and
// always replaces whatever the client sent.
test("the client IP is the socket peer by default; a client-sent header is ignored", () => {
  assert.equal(CLIENT_IP_HEADER, "x-forwarded-for");
  const spoof = { "x-forwarded-for": "192.0.2.99", "x-real-ip": "192.0.2.98" };
  assert.equal(clientIp("203.0.113.5", spoof, null), "203.0.113.5");
  assert.equal(clientIp("::ffff:127.0.0.1", spoof, null), "127.0.0.1");
  assert.notEqual(clientIp("203.0.113.5", {}, null), clientIp("203.0.113.6", {}, null));
  assert.equal(clientIp(undefined, spoof, null), null);
});

test("requestHeaders always overwrites the client IP header", () => {
  const headers = requestHeaders({ "x-forwarded-for": ["192.0.2.99", "192.0.2.98"], cookie: "a=b", accept: "text/html" }, "203.0.113.5");
  assert.deepEqual(headers.filter(([k]) => k === "x-forwarded-for"), [["x-forwarded-for", "203.0.113.5"]]);
  assert.deepEqual(headers.filter(([k]) => k === "cookie"), [["cookie", "a=b"]]);
  assert.deepEqual(requestHeaders({ "x-forwarded-for": "192.0.2.99" }, null), []);
});

test("behind a trusted proxy the client IP comes from the proxy's header, and only from that peer", () => {
  assert.equal(proxyConfig({}), null);
  assert.throws(() => proxyConfig({ PRISM_TRUSTED_PROXY_HEADER: "x-real-ip" }), /PRISM_TRUSTED_PROXY_IPS/);
  assert.throws(() => proxyConfig({ PRISM_TRUSTED_PROXY_IPS: "10.0.0.2" }), /PRISM_TRUSTED_PROXY_HEADER/);
  assert.throws(() => proxyConfig({ PRISM_TRUSTED_PROXY_HEADER: "x-real-ip", PRISM_TRUSTED_PROXY_IPS: "10.0.0.0/8" }), /not an IP address/);
  const proxy = proxyConfig({ PRISM_TRUSTED_PROXY_HEADER: "X-Real-IP", PRISM_TRUSTED_PROXY_IPS: "10.0.0.2, ::1" });
  // From the trusted proxy: the header's value; for a list, the last hop the proxy appended.
  assert.equal(clientIp("10.0.0.2", { "x-real-ip": "198.51.100.7" }, proxy), "198.51.100.7");
  assert.equal(clientIp("::ffff:10.0.0.2", { "x-real-ip": "198.51.100.7" }, proxy), "198.51.100.7");
  assert.equal(clientIp("::1", { "x-real-ip": "192.0.2.1, 198.51.100.8" }, proxy), "198.51.100.8");
  // From any other peer the header is ignored.
  assert.equal(clientIp("203.0.113.5", { "x-real-ip": "198.51.100.7" }, proxy), "203.0.113.5");
  // A missing or malformed value falls back to the socket peer.
  assert.equal(clientIp("10.0.0.2", {}, proxy), "10.0.0.2");
  assert.equal(clientIp("10.0.0.2", { "x-real-ip": "not-an-ip" }, proxy), "10.0.0.2");
});

// 07-12c: behind Caddy the app must see its own requests as https.
test("x-forwarded-proto is honoured only from the trusted proxy and only as exactly https", () => {
  const proxy = proxyConfig({ PRISM_TRUSTED_PROXY_HEADER: "x-forwarded-for", PRISM_TRUSTED_PROXY_IPS: "172.30.0.2" });
  assert.equal(requestScheme("172.30.0.2", { "x-forwarded-proto": "https" }, proxy), "https");
  assert.equal(requestScheme("::ffff:172.30.0.2", { "x-forwarded-proto": "https" }, proxy), "https");
  assert.equal(requestScheme("172.30.0.2", { "x-forwarded-proto": "http, https" }, proxy), "https");
  assert.equal(requestScheme("172.30.0.2", { "x-forwarded-proto": "https, http" }, proxy), "http");
  assert.equal(requestScheme("172.30.0.2", { "x-forwarded-proto": "HTTPS" }, proxy), "http");
  assert.equal(requestScheme("172.30.0.2", { "x-forwarded-proto": "https2" }, proxy), "http");
  assert.equal(requestScheme("172.30.0.2", {}, proxy), "http");
  // Any other peer, or no proxy configured: always http.
  assert.equal(requestScheme("203.0.113.5", { "x-forwarded-proto": "https" }, proxy), "http");
  assert.equal(requestScheme("172.30.0.2", { "x-forwarded-proto": "https" }, null), "http");
  assert.equal(requestScheme(undefined, { "x-forwarded-proto": "https" }, proxy), "http");
});
