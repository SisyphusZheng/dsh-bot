// Shared manifest loader/validator for the WhaleGirlBot upstream-sync toolchain.
//
// `versions.json` is the single source of truth for the product version
// (WhaleGirlBot) and the pinned DSH runtime version. Build/packaging flows read
// it and fail fast on drift. This module never writes the manifest or the
// product source tree; all git access is read-only.
//
// Exit-code contract shared by the toolchain (mirrors m4/preflight.mjs):
//   0 = PASS, 1 = validation failure, 2 = usage/environment failure,
//   3 = product/compat failure, 4 = environment failure.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const EXIT = { PASS: 0, VALIDATION: 1, USAGE: 2, API_FAILURE: 3, ENV_FAILURE: 4 }

/** Project root defaults to two levels above tools/upstream-sync; override with WG_PROJECT_ROOT. */
export function resolveProjectRoot(explicit) {
  if (explicit) return resolve(explicit)
  if (process.env.WG_PROJECT_ROOT) return resolve(process.env.WG_PROJECT_ROOT)
  const here = dirname(new URL(import.meta.url).pathname)
  return resolve(here, '../../..')
}

export function defaultManifestPath(projectRoot) {
  return join(projectRoot, 'versions.json')
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SHA_RE = /^[0-9a-f]{7,40}$/
const SHA256_RE = /^[0-9a-f]{64}$/

export function isSemver(value) {
  return typeof value === 'string' && SEMVER_RE.test(value)
}

/** Compares dotted semver-ish versions, ordering prereleases below their release. */
export function compareVersions(a, b) {
  const parse = (value) => {
    const [core, pre = ''] = String(value).split('+')[0].split('-', 2)
    const nums = core.split('.').map((n) => Number.parseInt(n, 10))
    return { nums, pre }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.nums[i] || 0) - (right.nums[i] || 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (left.pre === right.pre) return 0
  if (left.pre === '') return 1
  if (right.pre === '') return -1
  return left.pre > right.pre ? 1 : -1
}

export function loadManifest(manifestPath = defaultManifestPath(resolveProjectRoot())) {
  if (!existsSync(manifestPath)) {
    throw Object.assign(new Error(`manifest not found: ${manifestPath}`), { code: 'MANIFEST_MISSING' })
  }
  const raw = readFileSync(manifestPath, 'utf8')
  try {
    return { manifest: JSON.parse(raw), manifestPath, raw }
  } catch (error) {
    throw Object.assign(new Error(`manifest is not valid JSON: ${manifestPath}: ${error.message}`), { code: 'MANIFEST_PARSE' })
  }
}

export function git(repository, args, { timeout = 60_000 } = {}) {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  }).trim()
}

export function gitTolerant(repository, args) {
  try {
    return { ok: true, value: git(repository, args) }
  } catch (error) {
    return { ok: false, error: String(error?.stderr || error?.message || error).trim() }
  }
}

export function sha256File(filePath) {
  const hash = createHash('sha256')
  hash.update(readFileSync(filePath))
  return hash.digest('hex')
}

function requireString(fail, path, value, { pattern, semver = false } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${path}: missing or empty string`)
    return false
  }
  if (semver && !isSemver(value)) {
    fail(`${path}: "${value}" is not a semver version`)
    return false
  }
  if (pattern && !pattern.test(value)) {
    fail(`${path}: "${value}" does not match ${pattern}`)
    return false
  }
  return true
}

function requireObject(fail, path, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path}: missing object`)
    return false
  }
  return true
}

/**
 * Validates the dual-version manifest.
 *
 * Structural checks always run. Git cross-checks run when the pinned repository
 * is present on this host (baseline tag object and dereferenced commit, fork
 * distance, ancestry, and the runtime version reported by the checkout).
 * `strict` turns warnings into failures (used by the release gate).
 */
export function validateManifest(manifest, {
  manifestPath = '',
  projectRoot = resolveProjectRoot(),
  checkGit = true,
  checkArtifactHash = true,
  strict = false,
} = {}) {
  const errors = []
  const warnings = []
  const info = []
  const fail = (message) => errors.push(message)
  const warn = (message) => warnings.push(message)
  const note = (message) => info.push(message)

  if (!requireObject(fail, 'manifest', manifest)) {
    return { ok: false, errors, warnings, info, checks: [] }
  }

  if (manifest.schemaVersion !== 1) fail('schemaVersion: expected 1')
  requireString(fail, 'generatedAt', manifest.generatedAt)

  // ---- product ----
  const product = manifest.product ?? {}
  requireString(fail, 'product.name', product.name)
  requireString(fail, 'product.displayName', product.displayName)
  requireString(fail, 'product.version', product.version, { semver: true })
  requireString(fail, 'product.bundleId', product.bundleId)
  requireString(fail, 'product.channel', product.channel)
  if (!Number.isInteger(product.dataFormatVersion) || product.dataFormatVersion < 1) {
    fail('product.dataFormatVersion: expected integer >= 1')
  }

  // ---- source / baseline identity ----
  const source = manifest.source ?? {}
  requireString(fail, 'source.repository', source.repository)
  requireString(fail, 'source.baselineTag', source.baselineTag)
  requireString(fail, 'source.baselineTagObject', source.baselineTagObject, { pattern: SHA_RE })
  requireString(fail, 'source.baselineCommit', source.baselineCommit, { pattern: SHA_RE })
  requireString(fail, 'source.forkBaseTag', source.forkBaseTag)
  if (!Array.isArray(source.postBaselineCommits)) {
    fail('source.postBaselineCommits: expected array')
  } else {
    source.postBaselineCommits.forEach((sha, index) => {
      if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
        fail(`source.postBaselineCommits[${index}]: "${sha}" is not a commit sha`)
      }
    })
  }
  if (!Number.isInteger(source.forkCommitsAheadOfBase) || source.forkCommitsAheadOfBase < 0) {
    fail('source.forkCommitsAheadOfBase: expected integer >= 0')
  }

  // ---- runtime.dsh ----
  const runtime = manifest.runtime ?? {}
  const dsh = runtime.dsh ?? {}
  requireString(fail, 'runtime.dsh.package', dsh.package)
  requireString(fail, 'runtime.dsh.version', dsh.version, { semver: true })
  requireString(fail, 'runtime.dsh.upstreamTag', dsh.upstreamTag)
  requireString(fail, 'runtime.dsh.upgradePolicy', dsh.upgradePolicy)
  if (isSemver(dsh.version) && typeof dsh.upstreamTag === 'string' && dsh.upstreamTag !== `dsh-v${dsh.version}`) {
    fail(`runtime.dsh.upstreamTag: "${dsh.upstreamTag}" does not encode pinned version "${dsh.version}"`)
  }

  // ---- host integration / bridge ----
  const hostIntegration = runtime.hostIntegration ?? {}
  requireString(fail, 'runtime.hostIntegration.plugin', hostIntegration.plugin)
  requireString(fail, 'runtime.hostIntegration.version', hostIntegration.version, { semver: true })
  requireString(fail, 'runtime.hostIntegration.contractVersion', hostIntegration.contractVersion)
  requireString(fail, 'runtime.hostIntegration.bridgeProtocol', hostIntegration.bridgeProtocol)
  const g2Bridge = runtime.g2Bridge ?? {}
  requireString(fail, 'runtime.g2Bridge.plugin', g2Bridge.plugin)
  requireString(fail, 'runtime.g2Bridge.version', g2Bridge.version, { semver: true })
  requireString(fail, 'runtime.g2Bridge.transport', g2Bridge.transport)

  // ---- voice ----
  const voice = runtime.voice ?? {}
  requireString(fail, 'runtime.voice.worker', voice.worker)
  requireString(fail, 'runtime.voice.pipecat', voice.pipecat, { semver: true })
  requireString(fail, 'runtime.voice.aiortc', voice.aiortc, { semver: true })
  requireString(fail, 'runtime.voice.av', voice.av, { semver: true })
  requireString(fail, 'runtime.voice.clientJs', voice.clientJs, { semver: true })
  requireString(fail, 'runtime.voice.smallWebrtcTransport', voice.smallWebrtcTransport, { semver: true })

  // ---- memory ----
  const memory = runtime.memory ?? {}
  requireString(fail, 'runtime.memory.backend', memory.backend)
  requireString(fail, 'runtime.memory.hindsightVersion', memory.hindsightVersion, { semver: true })
  requireString(fail, 'runtime.memory.adapterVersion', memory.adapterVersion, { semver: true })
  requireString(fail, 'runtime.memory.delivery', memory.delivery)

  // ---- artifacts ----
  const artifacts = manifest.artifacts ?? {}
  const artifactNames = Object.keys(artifacts)
  if (artifactNames.length === 0) fail('artifacts: expected at least one artifact entry')
  for (const name of artifactNames) {
    const artifact = artifacts[name]
    const base = `artifacts.${name}`
    if (!requireObject(fail, base, artifact)) continue
    requireString(fail, `${base}.dmg`, artifact.dmg)
    requireString(fail, `${base}.sha256`, artifact.sha256, { pattern: SHA256_RE })
    requireString(fail, `${base}.appVersion`, artifact.appVersion, { semver: true })
    requireString(fail, `${base}.bundledRuntimeVersion`, artifact.bundledRuntimeVersion, { semver: true })
    requireString(fail, `${base}.dmgPath`, artifact.dmgPath)
    if (isSemver(artifact.appVersion) && isSemver(product.version) && artifact.appVersion !== product.version) {
      fail(`${base}.appVersion: "${artifact.appVersion}" does not match product.version "${product.version}"`)
    }
    if (isSemver(artifact.bundledRuntimeVersion) && isSemver(dsh.version) && artifact.bundledRuntimeVersion !== dsh.version) {
      fail(`${base}.bundledRuntimeVersion: "${artifact.bundledRuntimeVersion}" does not match runtime.dsh.version "${dsh.version}"`)
    }
    if (typeof artifact.dmgPath === 'string' && artifact.dmgPath !== '') {
      if (!isAbsolute(artifact.dmgPath)) {
        fail(`${base}.dmgPath: expected an absolute path`)
      } else if (!existsSync(artifact.dmgPath)) {
        warn(`${base}.dmgPath: not present on this host (${artifact.dmgPath}); sha256 presence checked only`)
      } else if (checkArtifactHash) {
        const actual = sha256File(artifact.dmgPath)
        if (actual === artifact.sha256) {
          note(`artifact ${name}: sha256 verified (${artifact.sha256.slice(0, 12)}…, ${statSync(artifact.dmgPath).size} bytes)`)
        } else {
          fail(`${base}.sha256: recorded ${artifact.sha256.slice(0, 12)}… != actual ${actual.slice(0, 12)}…`)
        }
      } else {
        warn(`${base}: artifact hash verification disabled`)
      }
    }
  }

  // ---- update / rollback ----
  const update = manifest.update ?? {}
  requireString(fail, 'update.targetSource', update.targetSource)
  requireString(fail, 'update.publicStatus', update.publicStatus)
  const rollback = manifest.rollback
  if (rollback === undefined || rollback === null) {
    warn('rollback: no rollback block; release gate cannot prove "previous tested version" (see docs/UPSTREAM-SYNC.md)')
  } else {
    requireString(fail, 'rollback.previousTestedVersion', rollback.previousTestedVersion, { semver: true })
    requireString(fail, 'rollback.artifact', rollback.artifact)
    requireString(fail, 'rollback.dataSnapshot', rollback.dataSnapshot)
  }

  // ---- git cross-checks (read-only) ----
  if (checkGit) {
    const repository = typeof source.repository === 'string' ? source.repository : ''
    if (repository === '' || !existsSync(repository)) {
      warn(`source.repository: "${repository}" is not present on this host; git cross-checks skipped`)
    } else {
      const head = gitTolerant(repository, ['rev-parse', 'HEAD'])
      if (!head.ok) {
        warn(`git: ${repository} is not a usable git repository (${head.error.split('\n')[0]}); cross-checks skipped`)
      } else {
        note(`source repository HEAD ${head.value.slice(0, 10)}`)

        const tagRef = gitTolerant(repository, ['rev-parse', '--verify', `refs/tags/${source.baselineTag}`])
        if (!tagRef.ok) {
          fail(`source.baselineTag: tag "${source.baselineTag}" not found in ${repository}`)
        } else {
          if (tagRef.value !== source.baselineTagObject) {
            fail(`source.baselineTagObject: recorded ${source.baselineTagObject} but tag object is ${tagRef.value}`)
          } else {
            note(`baseline tag object matches (${source.baselineTagObject.slice(0, 10)}…)`)
          }
          const deref = gitTolerant(repository, ['rev-parse', `refs/tags/${source.baselineTag}^{commit}`])
          if (!deref.ok) {
            fail(`source.baselineTag: cannot dereference "${source.baselineTag}" to a commit`)
          } else if (deref.value !== source.baselineCommit) {
            fail(`source.baselineCommit: recorded ${source.baselineCommit} but "${source.baselineTag}" points to ${deref.value}`)
          } else {
            note(`baseline tag -> commit matches (${source.baselineCommit.slice(0, 10)}…)`)
          }
        }

        const ancestor = gitTolerant(repository, ['merge-base', '--is-ancestor', source.baselineCommit, 'HEAD'])
        if (ancestor.ok) note('baseline commit is an ancestor of HEAD')
        else fail('source.baselineCommit: not an ancestor of HEAD')

        const forkBase = gitTolerant(repository, ['rev-parse', `refs/tags/${source.forkBaseTag}^{commit}`])
        if (!forkBase.ok) {
          fail(`source.forkBaseTag: "${source.forkBaseTag}" not resolvable in ${repository}`)
        } else {
          if (source.forkBaseTag === dsh.upstreamTag) {
            note('forkBaseTag equals runtime.dsh.upstreamTag')
          } else {
            fail(`source.forkBaseTag: "${source.forkBaseTag}" != runtime.dsh.upstreamTag "${dsh.upstreamTag}"`)
          }
          const ahead = gitTolerant(repository, ['rev-list', '--count', `${forkBase.value}..HEAD`])
          if (!ahead.ok) {
            warn('source.forkCommitsAheadOfBase: could not compute fork distance')
          } else if (Number.parseInt(ahead.value, 10) !== source.forkCommitsAheadOfBase) {
            fail(`source.forkCommitsAheadOfBase: recorded ${source.forkCommitsAheadOfBase} but git reports ${ahead.value}`)
          } else {
            note(`fork is ${ahead.value} commits ahead of ${source.forkBaseTag}`)
          }
        }

        for (const sha of source.postBaselineCommits ?? []) {
          if (!gitTolerant(repository, ['cat-file', '-e', `${sha}^{commit}`]).ok) {
            fail(`source.postBaselineCommits: commit ${sha} not found in ${repository}`)
            continue
          }
          if (!gitTolerant(repository, ['merge-base', '--is-ancestor', source.baselineCommit, sha]).ok) {
            fail(`source.postBaselineCommits: ${sha} is not after the baseline commit`)
          }
          if (!gitTolerant(repository, ['merge-base', '--is-ancestor', sha, 'HEAD']).ok) {
            fail(`source.postBaselineCommits: ${sha} is not an ancestor of HEAD`)
          }
        }
        if ((source.postBaselineCommits ?? []).length > 0) note('post-baseline commits verified against baseline and HEAD')

        // The checkout that builds the product must report the pinned runtime version.
        const rootManifestPath = join(repository, 'package.json')
        if (existsSync(rootManifestPath)) {
          try {
            const rootManifest = JSON.parse(readFileSync(rootManifestPath, 'utf8'))
            if (rootManifest.version === dsh.version) {
              note(`runtime.dsh.version matches checkout root package.json (${rootManifest.version})`)
            } else {
              fail(`runtime.dsh.version: manifest pins "${dsh.version}" but checkout package.json reports "${rootManifest.version}"`)
            }
          } catch (error) {
            warn(`source.repository: cannot read root package.json (${error.message})`)
          }
        }
      }
    }
  } else {
    warn('git cross-checks disabled (--no-git)')
  }

  if (strict) {
    for (const warning of warnings) errors.push(`strict: ${warning}`)
  }

  return { ok: errors.length === 0, errors, warnings, info, checks: info, manifestPath, projectRoot }
}
