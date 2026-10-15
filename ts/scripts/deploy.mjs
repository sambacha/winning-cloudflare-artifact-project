#!/usr/bin/env node
// `npm run deploy`: make sure every package the Worker bundle imports at
// runtime is installed, then run `wrangler deploy`.
//
// Why this exists: `src/workers/edge.ts` imports `@cloudflare/sandbox`, and
// wrangler's bundler (esbuild) must find it in node_modules. The package is
// not in package.json / package-lock.json because it could not be downloaded
// when the lockfile was last refreshed (no network), and adding it to
// package.json without a lockfile entry would break `npm ci`. So it is
// installed here, at deploy time, with `--no-save` (package.json and the
// lockfile stay untouched). Once the package is declared in "dependencies"
// (bash scripts/fix-open-issues.sh does this on a networked machine), it is
// no longer installed here. Wrangler: the local copy is used when it is
// installed (pinned in the lockfile), otherwise `npx wrangler@^4.145.0`.
//
// Usage:
//   npm run deploy                       # install if missing, then deploy
//   npm run deploy -- --check-only       # only report what would be installed
//   CF_SANDBOX_VERSION=0.x.y npm run deploy   # pin the SDK version
// Extra arguments are passed through to `wrangler deploy`.
//
// Keep the SDK version equal to the tag of `docker.io/cloudflare/sandbox` in
// ts/Dockerfile (the Sandbox SDK requires matching versions).
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const dir = join(dirname(fileURLToPath(import.meta.url)), "..")
const WRANGLER = "wrangler@^4.145.0"

/**
 * Packages imported by the Worker bundle that may be missing from
 * package.json. Once one is declared in "dependencies" (scripts/fix-open-issues.sh
 * does that on a networked machine), it is locked by package-lock.json and
 * `npm ci` installs it, so this script stops installing it.
 */
export const CANDIDATE_PACKAGES = [
  { name: "@cloudflare/sandbox", version: process.env.CF_SANDBOX_VERSION || "latest", importedBy: "src/workers/edge.ts" },
]

/** Names declared in package.json (dependencies and devDependencies) under `root`. */
export function declaredPackages(root = dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])
  } catch {
    return new Set()
  }
}

/** Candidates that are not declared in package.json: installed here with --no-save. */
export function runtimePackages(root = dir) {
  const declared = declaredPackages(root)
  return CANDIDATE_PACKAGES.filter((p) => !declared.has(p.name))
}

/** The packages this script installs for the repository's current package.json. */
export const RUNTIME_PACKAGES = runtimePackages()

/** Returns the installed version of `name` under ts/node_modules, or null. */
export function installedVersion(name, root = dir) {
  const manifest = join(root, "node_modules", ...name.split("/"), "package.json")
  if (!existsSync(manifest)) return null
  try {
    return JSON.parse(readFileSync(manifest, "utf8")).version ?? "unknown"
  } catch {
    return null
  }
}

/** Undeclared runtime packages that still need installing. */
export function missingPackages(root = dir) {
  return runtimePackages(root).filter((p) => installedVersion(p.name, root) === null)
}

/** The wrangler command: the locked local copy when installed, otherwise npx. */
export function wranglerCommand(root = dir) {
  const local = join(root, "node_modules", "wrangler", "bin", "wrangler.js")
  return existsSync(local) ? ["node", [local]] : ["npx", ["--yes", WRANGLER]]
}

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(" ")}`)
  const r = spawnSync(cmd, args, { cwd: dir, stdio: "inherit", shell: process.platform === "win32" })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

function main() {
  const args = process.argv.slice(2)
  const checkOnly = args.includes("--check-only")
  const passThrough = args.filter((a) => a !== "--check-only")

  const missing = missingPackages()
  for (const p of runtimePackages()) {
    const v = installedVersion(p.name)
    console.log(v === null
      ? `${p.name}: not installed (imported by ${p.importedBy}); will install ${p.name}@${p.version}`
      : `${p.name}: installed (${v})`)
  }
  if (checkOnly) process.exit(missing.length === 0 ? 0 : 1)

  if (missing.length > 0) {
    run("npm", ["install", "--no-save", "--no-audit", "--no-fund", ...missing.map((p) => `${p.name}@${p.version}`)])
    const still = missingPackages()
    if (still.length > 0) {
      console.error(`still missing after install: ${still.map((p) => p.name).join(", ")}`)
      process.exit(1)
    }
  }
  const [cmd, base] = wranglerCommand()
  run(cmd, [...base, "deploy", ...passThrough])
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
