// Bundles node-server.tsx into one minified ESM file for plain Node (the container probe), so it
// runs on a stock Node image with no npm install. Rendered with React's Node build.
import { builtinModules } from "node:module";
import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

export default defineConfig({
  plugins: [pluginReact()],
  source: { entry: { "probe-server": "./scripts/probes/worker-cpu/node-server.tsx" } },
  output: {
    target: "node",
    module: true,
    distPath: { root: "scripts/probes/worker-cpu/.build/node", js: "" },
    filename: { js: "[name].mjs" },
    cleanDistPath: true,
    minify: true,
    sourceMap: false,
    // Node built-ins (bare or node:) stay ESM imports.
    externals: [
      ({ request }, callback) => {
        const name = request?.replace(/^node:/, "");
        return name && builtinModules.includes(name) ? callback(undefined, `node:${name}`, "module") : callback();
      },
    ],
  },
  performance: { chunkSplit: { strategy: "all-in-one" } },
  tools: {
    rspack: {
      output: { asyncChunks: false },
      externalsPresets: { node: false },
    },
  },
});
