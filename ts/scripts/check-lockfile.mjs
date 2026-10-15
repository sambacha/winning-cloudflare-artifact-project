#!/usr/bin/env node
// Fails (exit 1) when ts/package-lock.json's root entry does not declare
// exactly the same dependency ranges as ts/package.json. `npm ci` refuses an
// out-of-sync lockfile; this check reports the exact mismatch first.
// Fix: run `npm install` in ts/ (needs network) and commit the lockfile.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const dir = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"))
const root = (lock.packages && lock.packages[""]) || {}

const diffs = []
for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
  const a = pkg[field] || {}
  const b = root[field] || {}
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[name] !== b[name]) {
      diffs.push(`${field}.${name}: package.json ${a[name] ?? "(absent)"} vs lockfile ${b[name] ?? "(absent)"}`)
    } else if (!(lock.packages && lock.packages[`node_modules/${name}`])) {
      diffs.push(`${field}.${name}: no node_modules/${name} entry in the lockfile`)
    }
  }
}

if (diffs.length > 0) {
  console.error("ts/package-lock.json is out of sync with ts/package.json:")
  for (const d of diffs) console.error(`  - ${d}`)
  console.error("Fix: run `npm install` in ts/ (network needed) and commit ts/package-lock.json.")
  process.exit(1)
}
console.log("ts/package-lock.json is in sync with ts/package.json")
