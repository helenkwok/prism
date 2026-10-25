// D-69: deploy dist/client to Cloudflare Pages with the cf CLI (never wrangler), and never a fixture build.
// Refuses before anything runs: a page carrying the synthetic-data banner, or a build without _headers.
// Known open point for 06-08: cf 1.0.0-beta.20's `pages deploy` exits 1 with "Legacy Pages is not supported in cf"
// and points to `cf deploy` (Pages on Workers); the deploy route is decided there, not here.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const out = resolve(import.meta.dirname, '../dist/client')
const refuse = reason => { console.log(`DEPLOY REFUSED: ${reason}`); process.exit(1) }
if (!existsSync(out)) refuse('no build')
const html = readdirSync(out, { recursive: true }).filter(f => f.endsWith('.html'))
if (html.some(f => readFileSync(resolve(out, f), 'utf8').includes('data-fixture-banner'))) refuse('fixture release')
if (!existsSync(resolve(out, '_headers'))) refuse('no _headers')

const command = ['pages', 'deploy', 'dist/client']
// cf's help lists no project-name option, so the Pages project (prism-findings, D-69) is not passed here.
console.log(`DEPLOY: cf ${command.join(' ')}`)
const run = spawnSync('cf', command, { cwd: resolve(import.meta.dirname, '..'), stdio: 'inherit' })
process.exit(run.status ?? 1)
