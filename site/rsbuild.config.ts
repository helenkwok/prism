import { resolve } from 'node:path'
import { defineConfig } from '@rsbuild/core'
import { pluginReact } from '@rsbuild/plugin-react'
import { tanstackStart } from '@tanstack/react-start/plugin/rsbuild'
import { releaseDir } from './scripts/release-dir.mjs'
import { BASE_PREFIX } from '../base-path.mjs'

// The site sees public data only through @public-data (PUB-06): the highest v<N> under PUBLIC_DATA_DIR,
// or, with no release, a stub whose kind "none" renders the empty state.
const release = releaseDir()
const alias: Record<string, string> = release
  ? { '@public-data': release }
  : {
      '@public-data/release.json$': resolve(import.meta.dirname, 'src/no-release.json'),
      '@public-data/manifest.json$': resolve(import.meta.dirname, 'src/no-release.json'),
    }

// Every route is prerendered to static HTML; nothing runs on a server at run time (D-68).
export default defineConfig({
  resolve: { alias },
  // Where the private app lives on the same host (../base-path.mjs), for the header link.
  source: { define: { 'import.meta.env.PRISM_APP_PATH': JSON.stringify(`${BASE_PREFIX}/`) } },
  plugins: [pluginReact(), tanstackStart({
    prerender: { enabled: true, crawlLinks: true, concurrency: 1, failOnError: true, filter: ({ path }) => !path.includes('#') && !/\.[a-z0-9]+$/i.test(path) && !path.startsWith(`${BASE_PREFIX}/`) },
  })],
})
