import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [tanstackStart({ srcDirectory: "src/app" }), nitro({ plugins: [fileURLToPath(new URL("./src/app/server/boot.ts", import.meta.url))] }), viteReact()],
});
