// Browser tests against the built app (run `npm run build` first). e2e/serve.mjs
// seeds a throwaway server; specs read the seeded credentials from E2E_DIR.
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 4317);
// Exported so e2e/serve.mjs (webServer) and the test workers agree on one directory.
process.env.E2E_PORT = String(port);
process.env.E2E_DIR ??= path.join(os.tmpdir(), `prism-e2e-${port}`);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "e2e",
  // One seeded server and better-auth's sign-in rate limit: run specs one at a time.
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  use: { baseURL },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/serve.mjs",
    url: `${baseURL}/sign-in`,
    reuseExistingServer: false,
    timeout: 60_000,
    // SIGTERM (not the default SIGKILL) so serve.mjs can stop the server and remove E2E_DIR.
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    stdout: "pipe",
    stderr: "pipe",
  },
});
