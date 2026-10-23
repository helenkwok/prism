import { builtinModules } from "node:module";
import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/rsbuild";

// The client bundle reaches server-only imports it never runs: access.ts's lazy
// server imports (auth, db, @tanstack/react-start/server) and the Node file
// loaders in contract.ts, which the browser also uses for PROPOSED_STATES. Vite
// stubbed these in the client build; this does the same with an empty object.
const builtins = new Set(builtinModules);
const clientOnlyStub = (request: string) =>
  request.startsWith("node:") || builtins.has(request) || request === "@tanstack/react-start/server";

// TanStack Start's official Rsbuild build: `rsbuild build` writes dist/client and
// dist/server; scripts/serve.mjs runs them on Node.
export default defineConfig({
  plugins: [pluginReact(), tanstackStart({ srcDirectory: "src/app" })],
  environments: {
    // Both load a binary relative to their own package (better-sqlite3's native
    // binding, takumi-pdf's WASM), so the server bundle imports them from
    // node_modules at run time instead of inlining them.
    ssr: { output: { externals: ["better-sqlite3", "takumi-pdf"] } },
    client: {
      output: {
        externals: [
          ({ request }, callback) =>
            request && clientOnlyStub(request) ? callback(undefined, "{}", "var") : callback(),
        ],
      },
    },
  },
});
