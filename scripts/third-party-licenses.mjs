#!/usr/bin/env node
/**
 * THIRD_PARTY_LICENSES.txt for the offline bundle (SPEC §14): name, version, license and the
 * license text of every package in <dir>/node_modules. Usage: node scripts/third-party-licenses.mjs <dir>
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? '.'
const seen = new Map()

function visit(dir) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (!statSync(path).isDirectory()) continue
    if (name.startsWith('@')) {
      visit(path)
      continue
    }
    const manifest = join(path, 'package.json')
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      const id = `${pkg.name}@${pkg.version}`
      if (!seen.has(id)) {
        const file = readdirSync(path).find((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f))
        const license = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'UNKNOWN')
        seen.set(id, { license, text: file ? readFileSync(join(path, file), 'utf8').trim() : '(no license file in the package)' })
      }
    }
    visit(join(path, 'node_modules'))
  }
}

visit(join(root, 'node_modules'))
const out = [...seen.entries()]
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([id, { license, text }]) => `${'='.repeat(78)}\n${id} — ${license}\n${'='.repeat(78)}\n${text}\n`)
process.stdout.write(`Third-party software bundled with theloop\n\n${out.join('\n')}`)
