#!/usr/bin/env node
/**
 * The offline Node bundle must be platform-independent (SPEC §14): no native addons and no
 * install scripts in the production dependency tree. Usage: node scripts/bundle-check.mjs <dir>
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? '.'
const problems = []

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) walk(path)
    else if (name.endsWith('.node')) problems.push(`native addon: ${path}`)
    else if (name === 'package.json') {
      try {
        const pkg = JSON.parse(readFileSync(path, 'utf8'))
        for (const hook of ['preinstall', 'install', 'postinstall']) {
          if (pkg.scripts?.[hook] && pkg.name) problems.push(`install script (${hook}): ${pkg.name}`)
        }
      } catch {
        // not a package manifest
      }
    }
  }
}

walk(join(root, 'node_modules'))
if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('bundle-check: no native addons, no install scripts')
