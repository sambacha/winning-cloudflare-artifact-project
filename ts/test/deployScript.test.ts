import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
// @ts-expect-error -- plain .mjs script without type declarations
import { RUNTIME_PACKAGES, installedVersion, missingPackages, runtimePackages } from "../scripts/deploy.mjs"

const root = join(import.meta.dirname, "..")

describe("scripts/deploy.mjs", () => {
  it("covers every bare package imported by the Worker entry that is not a declared dependency", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])
    const src = readFileSync(join(root, "src/workers/edge.ts"), "utf8")
    const imported = [...src.matchAll(/from\s+"([^".][^"]*)"/g)].map((m) => m[1]!)
      .filter((s) => !s.startsWith("cloudflare:") && !s.startsWith("node:"))
      .map((s) => (s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]!))
    const covered = new Set((RUNTIME_PACKAGES as Array<{ name: string }>).map((p) => p.name))
    for (const name of imported) expect(declared.has(name) || covered.has(name), name).toBe(true)
    expect(declared.has("@cloudflare/sandbox") || covered.has("@cloudflare/sandbox")).toBe(true)
  })

  it("reports a package as missing until it is present in node_modules", () => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-script-"))
    expect(missingPackages(dir).map((p: { name: string }) => p.name)).toContain("@cloudflare/sandbox")
    mkdirSync(join(dir, "node_modules/@cloudflare/sandbox"), { recursive: true })
    writeFileSync(join(dir, "node_modules/@cloudflare/sandbox/package.json"), JSON.stringify({ version: "1.2.3" }))
    expect(installedVersion("@cloudflare/sandbox", dir)).toBe("1.2.3")
    expect(missingPackages(dir)).toEqual([])
  })

  it("stops installing a package once package.json declares it", () => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-script-"))
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@cloudflare/sandbox": "0.4.0" } }))
    expect(runtimePackages(dir)).toEqual([])
    expect(missingPackages(dir)).toEqual([])
  })

  it("is what `npm run deploy` runs", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    expect(pkg.scripts.deploy).toBe("node scripts/deploy.mjs")
  })
})
