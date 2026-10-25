// The one place that decides which public-data release the site reads (D-68, PUB-06).
// PUBLIC_DATA_DIR (default ../public-data, relative to site/) -> its highest v<N> directory, or null.
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

export function publicDataDir() {
  return resolve(import.meta.dirname, '..', process.env.PUBLIC_DATA_DIR || '../public-data')
}

export function releaseDir(root = publicDataDir()) {
  if (!existsSync(root)) return null
  const versions = readdirSync(root).filter(name => /^v\d+$/.test(name)).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))
  return versions.length ? resolve(root, versions[0]) : null
}
