#!/usr/bin/env node
// Fail-fast validator for the WhaleGirlBot dual-version manifest (versions.json).
//
// Checks field completeness for product / runtime / bridge / voice / memory,
// that the baseline tag object and dereferenced commit agree with the recorded
// baseline, that recorded artifacts carry a sha256 (and match the file when it
// is present), and that the pinned runtime version matches the checkout that
// builds the product. It never upgrades, writes, or mutates anything.
//
// Usage:
//   node tools/upstream-sync/check-versions.mjs [options]
//     --manifest <path>      manifest to validate (default <project-root>/versions.json)
//     --project-root <dir>   project root (default: WG_PROJECT_ROOT or the repo above this tool)
//     --no-git               skip git cross-checks (offline / candidate checkout lint)
//     --no-hash              skip artifact sha256 content verification
//     --strict               treat warnings as failures (release gate)
//     --json                 machine-readable output on stdout
//     --quiet                only failures + summary
//
// Exit: 0 = PASS, 1 = validation failure, 2 = usage/manifest/environment failure.
import { existsSync } from 'node:fs'
import { EXIT, defaultManifestPath, loadManifest, resolveProjectRoot, validateManifest } from './lib/manifest.mjs'

function parseArgs(argv) {
  const options = { json: false, quiet: false, strict: false, checkGit: true, checkArtifactHash: true }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--manifest': options.manifest = argv[++i]; break
      case '--project-root': options.projectRoot = argv[++i]; break
      case '--no-git': options.checkGit = false; break
      case '--no-hash': options.checkArtifactHash = false; break
      case '--strict': options.strict = true; break
      case '--json': options.json = true; break
      case '--quiet': options.quiet = true; break
      case '-h':
      case '--help':
        console.log('usage: node tools/upstream-sync/check-versions.mjs [--manifest path] [--project-root dir] [--no-git] [--no-hash] [--strict] [--json] [--quiet]')
        process.exit(EXIT.PASS)
        break
      default:
        console.error(`unknown argument: ${arg}`)
        process.exit(EXIT.USAGE)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const projectRoot = resolveProjectRoot(options.projectRoot)
const manifestPath = options.manifest ? resolvePath(options.manifest) : defaultManifestPath(projectRoot)

function resolvePath(value) {
  return value.startsWith('/') ? value : new URL(value, `file://${process.cwd()}/`).pathname
}

function main() {
  if (!existsSync(manifestPath)) {
    console.error(`FAIL manifest: not found at ${manifestPath}`)
    return { exitCode: EXIT.USAGE }
  }
  let loaded
  try {
    loaded = loadManifest(manifestPath)
  } catch (error) {
    console.error(`FAIL manifest: ${error.message}`)
    return { exitCode: EXIT.USAGE }
  }

  const validation = validateManifest(loaded.manifest, {
    manifestPath,
    projectRoot,
    checkGit: options.checkGit,
    checkArtifactHash: options.checkArtifactHash,
    strict: options.strict,
  })

  const product = loaded.manifest.product ?? {}
  const dsh = loaded.manifest.runtime?.dsh ?? {}
  const payload = {
    schema: 'whalegirl.manifest-check/1',
    checkedAt: new Date().toISOString(),
    manifestPath,
    projectRoot,
    ok: validation.ok,
    productVersion: product.version ?? null,
    runtimeVersion: dsh.version ?? null,
    runtimeTag: dsh.upstreamTag ?? null,
    strict: options.strict,
    checkGit: options.checkGit,
    checkArtifactHash: options.checkArtifactHash,
    errors: validation.errors,
    warnings: validation.warnings,
    info: validation.info,
  }

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2))
    return { exitCode: validation.ok ? EXIT.PASS : EXIT.VALIDATION, payload }
  }

  const lines = []
  if (!options.quiet) {
    lines.push('== WhaleGirlBot manifest check (versions.json) ==')
    lines.push(`manifest: ${manifestPath}`)
    lines.push(`product:  ${product.name ?? '?'} ${product.version ?? '?'} (dataFormat v${product.dataFormatVersion ?? '?'})`)
    lines.push(`runtime:  ${dsh.package ?? '?'}@${dsh.version ?? '?'} pinned to ${dsh.upstreamTag ?? '?'}`)
    for (const entry of validation.info) lines.push(`PASS ${entry}`)
  }
  for (const warning of validation.warnings) lines.push(`WARN ${warning}`)
  for (const error of validation.errors) lines.push(`FAIL ${error}`)
  const result = validation.ok ? 'PASS' : 'FAIL'
  lines.push(`RESULT ${result}  (${validation.info.length} checks, ${validation.warnings.length} warnings, ${validation.errors.length} errors)`)
  console.log(lines.join('\n'))

  return { exitCode: validation.ok ? EXIT.PASS : EXIT.VALIDATION, payload }
}

const { exitCode } = main()
process.exit(exitCode)
