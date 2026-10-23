// Bundles worker.tsx into one ESM module for workerd, with the project's own Rsbuild (no new
// package). node: built-ins stay imports (nodejs_compat provides them). The "workerd" condition
// comes first so @better-auth/utils/password and react-dom resolve as they would on Workers.
import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

export default defineConfig({
  // The app's JSX transform (automatic runtime), so report.tsx compiles as it does in the app.
  plugins: [pluginReact()],
  source: { entry: { index: "./scripts/probes/worker-cpu/worker.tsx" } },
  output: {
    target: "node",
    module: true,
    distPath: { root: "scripts/probes/worker-cpu/.build/bundle", js: "" },
    filename: { js: "[name].js" },
    cleanDistPath: true,
    minify: false,
    sourceMap: false,
    // As ESM imports, not Rsbuild's node-target createRequire(), which workerd may not offer.
    externals: [/^node:/],
  },
  performance: { chunkSplit: { strategy: "all-in-one" } },
  tools: {
    rspack: {
      resolve: { conditionNames: ["workerd", "worker", "import", "module", "default"] },
      output: { asyncChunks: false },
      externalsType: "module",
      externalsPresets: { node: false },
    },
  },
});
