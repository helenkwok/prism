// D-69 (host changed by Helen, 2026-10-24): deploy dist/client as static files to the Oracle VM, served by
// prism-caddy at findings.helenkwok.dev from a read-only mount. Never a fixture build.
//
//   node scripts/deploy.mjs <sha7>
//
// <sha7> is a commit whose tracked tree is already at /srv/prism/src-<sha7> on the VM (07-DEPLOY.md); its
// deploy/Caddyfile and scripts/vm-deploy.sh are used. The build goes to /srv/prism/findings/releases/<sha7>,
// the relative symlink /srv/prism/findings/current is swapped to it, then `vm-deploy.sh caddy <sha7>` reloads
// (or recreates) Caddy. The previous release stays on the VM, so a rollback is the same command with its sha7.
// Refuses before anything runs: a page carrying the synthetic-data banner, or a build without its headers.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const VM = 'ubuntu@149.118.68.57'
const KEY = '/Users/helen/.ssh/oci_prism'
const HOSTS = '/Users/helen/.ssh/known_hosts_oci_prism'
const SSH = ['-i', KEY, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${HOSTS}`, '-o', 'ConnectTimeout=10']

const dist = resolve(import.meta.dirname, '../dist')
const out = resolve(dist, 'client')
const refuse = reason => { console.log(`DEPLOY REFUSED: ${reason}`); process.exit(1) }
const sha = process.argv[2] ?? ''
if (!/^[0-9a-f]{7,40}$/.test(sha)) refuse('usage: node scripts/deploy.mjs <sha7>')
if (!existsSync(out)) refuse('no build')
const html = readdirSync(out, { recursive: true }).filter(f => f.endsWith('.html'))
if (html.some(f => readFileSync(resolve(out, f), 'utf8').includes('data-fixture-banner'))) refuse('fixture release')
if (!existsSync(resolve(out, '_headers'))) refuse('no _headers')
if (!existsSync(resolve(dist, 'caddy-headers'))) refuse('no caddy-headers')

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.status !== 0) { console.log(`DEPLOY FAILED: ${cmd} exited ${r.status}`); process.exit(1) }
}
const ssh = remote => run('ssh', [...SSH, VM, remote])
const rsync = (from, to) => run('rsync', ['-a', '--delete', '-e', ['ssh', ...SSH].join(' '), from, `${VM}:${to}`])

const rel = `/srv/prism/findings/releases/${sha}`
ssh(`test -d /srv/prism/src-${sha} && sudo install -d -o ubuntu -g ubuntu -m 755 /srv/prism/findings /srv/prism/findings/releases ${rel}`)
rsync(`${out}/`, `${rel}/client/`)
rsync(resolve(dist, 'caddy-headers'), `${rel}/caddy-headers`)
ssh(`cd /srv/prism/findings && ln -sfn releases/${sha} current.next && mv -T current.next current`)
ssh(`sudo bash /srv/prism/src-${sha}/scripts/vm-deploy.sh caddy ${sha}`)
console.log(`DEPLOY: findings.helenkwok.dev <- ${sha}`)
