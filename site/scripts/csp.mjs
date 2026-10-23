// After `rsbuild build`: write dist/client/_headers (D-69). Assets are immutable; every page gets a strict policy
// that runs only this site's scripts plus the prerendered inline scripts by hash, and connects nowhere.
// Cloudflare reads _headers; scripts/serve.mjs applies it locally for the checks.
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { releaseDir } from './release-dir.mjs'

const out = resolve(import.meta.dirname, '../dist/client')
const pages = readdirSync(out, { recursive: true }).filter(f => f === 'index.html' || f.endsWith('/index.html'))
const hashes = new Set()
for (const file of pages) {
  const html = await readFile(resolve(out, file), 'utf8')
  for (const [, code] of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) hashes.add(`'sha256-${createHash('sha256').update(code).digest('base64')}'`)
}
const policy = [
  "default-src 'none'",
  `script-src 'self' ${[...hashes].sort().join(' ')}`.trim(),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')
await writeFile(resolve(out, '_headers'), `/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n/*\n  Content-Security-Policy: ${policy}\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n`)
console.log(`CSP: ${pages.length} pages, ${hashes.size} inline scripts allowed by hash`)
// Runs in the same environment as the build, so it records which release the build read, for check.mjs's
// digest check. Written beside dist/client, never deployed.
await writeFile(resolve(out, '../data-source.json'), JSON.stringify({ releaseDir: releaseDir() }) + '\n')
