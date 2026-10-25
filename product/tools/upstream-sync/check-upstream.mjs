#!/usr/bin/env node
// Upstream release discovery for the pinned DSH runtime.
//
// Compares the version pinned in versions.json against the newest release of
// the DSH upstream on GitHub, then prints a human-readable change report: tags,
// release dates, commit list, file statistics and which top-level packages the
// candidate touches. It NEVER upgrades the pin, never modifies the checkout and
// never pushes; upgrading is a human-approved worktree flow (docs/UPSTREAM-SYNC.md).
//
// Usage:
//   node tools/upstream-sync/check-upstream.mjs [options]
//     --repo <owner/name>       upstream repository (default: parsed from
//                               versions.json source or deepseek-ai/deepseek-harness)
//     --manifest <path>         manifest to read the pin from
//     --reports-dir <dir>       where the JSON evidence is written (default docs/reports)
//     --token <token>           GitHub token (default: GITHUB_TOKEN env)
//     --json                    machine-readable output
//     --no-write                do not write JSON evidence
//     --fail-on-newer           exit 1 when a newer upstream release exists
//     --timeout-ms <n>          per-request timeout (default 30000)
//
// Exit: 0 = pin is current, 10 = newer upstream available (informational),
//       1 = newer upstream available with --fail-on-newer, 2 = usage/env,
//       3 = API/network failure.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT, compareVersions, defaultManifestPath, loadManifest, resolveProjectRoot } from './lib/manifest.mjs'

const DEFAULT_REPO = 'deepseek-ai/deepseek-harness'
const TAG_PREFIX = 'dsh-v'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs(argv) {
  const options = { json: false, write: true, failOnNewer: false, timeoutMs: 30_000 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--repo') options.repo = argv[++i]
    else if (arg === '--manifest') options.manifest = argv[++i]
    else if (arg === '--reports-dir') options.reportsDir = argv[++i]
    else if (arg === '--token') options.token = argv[++i]
    else if (arg === '--json') options.json = true
    else if (arg === '--no-write') options.write = false
    else if (arg === '--fail-on-newer') options.failOnNewer = true
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++i])
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node tools/upstream-sync/check-upstream.mjs [--repo owner/name] [--manifest path] [--reports-dir dir] [--json] [--no-write] [--fail-on-newer]')
      process.exit(EXIT.PASS)
    } else {
      console.error(`unknown argument: ${arg}`)
      process.exit(EXIT.USAGE)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const projectRoot = resolveProjectRoot()
const manifestPath = options.manifest ?? defaultManifestPath(projectRoot)
const reportsDir = options.reportsDir ?? join(projectRoot, 'docs/reports')
const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''

async function api(path) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'whalegirlbot-upstream-sync/1.0',
    'x-github-api-version': '2022-11-28',
  }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(options.timeoutMs) })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { status: response.status, json, text, headers: response.headers }
}

/** Groups changed file paths into package-level buckets for the report. */
function groupByPackage(files) {
  const groups = new Map()
  for (const file of files) {
    const path = typeof file === 'string' ? file : file?.filename
    if (!path) continue
    const segments = path.split('/')
    const key = (segments[0] === 'packages' || segments[0] === 'apps' || segments[0] === 'plugins' || segments[0] === 'extensions') && segments.length > 1
      ? `${segments[0]}/${segments[1]}`
      : segments[0]
    const bucket = groups.get(key) ?? { files: 0, additions: 0, deletions: 0 }
    bucket.files += 1
    bucket.additions += Number(file?.additions ?? 0)
    bucket.deletions += Number(file?.deletions ?? 0)
    groups.set(key, bucket)
  }
  return [...groups.entries()].map(([name, stats]) => ({ name, ...stats })).sort((a, b) => b.files - a.files)
}

/** Files a server-side reviewer must actually read (not UI docs/tests/manifests). */
function classifyFiles(files) {
  const paths = files.map((file) => (typeof file === 'string' ? file : file?.filename)).filter(Boolean)
  const serverish = paths.filter((path) => !path.startsWith('packages/client/')
    && !path.startsWith('apps/web/')
    && !path.startsWith('snapshots/')
    && !path.startsWith('docs/')
    && !path.startsWith('.agents/')
    && !/\.(md|mdx|i18n\.yaml)$/.test(path)
    && !path.endsWith('/package.json')
    && !path.startsWith('packages/client')
    && !/\/tests?\//.test(path)
    && !/\.spec\.[cm]?[jt]sx?$/.test(path)
    && !/\.e2e\.ts$/.test(path))
  return { total: paths.length, serverish }
}

async function main() {
  if (!existsSync(manifestPath)) {
    console.error(`FAIL manifest: not found at ${manifestPath}`)
    return EXIT.USAGE
  }
  let loaded
  try {
    loaded = loadManifest(manifestPath)
  } catch (error) {
    console.error(`FAIL manifest: ${error.message}`)
    return EXIT.USAGE
  }
  const pinTag = String(loaded.manifest.runtime?.dsh?.upstreamTag ?? '')
  const pinVersion = String(loaded.manifest.runtime?.dsh?.version ?? '')
  if (!pinTag.startsWith(TAG_PREFIX)) {
    console.error(`FAIL manifest: runtime.dsh.upstreamTag "${pinTag}" is not a dsh-v* tag`)
    return EXIT.USAGE
  }
  const repo = options.repo ?? DEFAULT_REPO
  const report = {
    schema: 'whalegirl.upstream-check/1',
    checkedAt: new Date().toISOString(),
    repository: repo,
    pinnedTag: pinTag,
    pinnedVersion: pinVersion,
  }

  const releases = await api(`/repos/${repo}/releases?per_page=50`)
  if (releases.status !== 200 || !Array.isArray(releases.json)) {
    const remaining = releases.headers.get('x-ratelimit-remaining')
    console.error(`FAIL github: releases request returned ${releases.status}${remaining === '0' ? ' (rate limit exhausted; set GITHUB_TOKEN)' : ''}: ${releases.text.slice(0, 200)}`)
    return EXIT.API_FAILURE
  }
  const releaseTags = releases.json
    .filter((release) => typeof release.tag_name === 'string' && release.tag_name.startsWith(TAG_PREFIX))
    .map((release) => ({
      tag: release.tag_name,
      version: release.tag_name.slice(TAG_PREFIX.length),
      publishedAt: release.published_at,
      prerelease: Boolean(release.prerelease),
      draft: Boolean(release.draft),
      htmlUrl: release.html_url,
      body: typeof release.body === 'string' ? release.body.slice(0, 600) : '',
    }))
  const latest = releaseTags.find((release) => !release.draft)
  if (!latest) {
    console.error(`FAIL github: no ${TAG_PREFIX}* release found for ${repo}`)
    return EXIT.API_FAILURE
  }
  let pinned = releaseTags.find((release) => release.tag === pinTag)
  if (!pinned) {
    const detail = await api(`/repos/${repo}/releases/tags/${pinTag}`)
    if (detail.status === 200 && detail.json) {
      pinned = {
        tag: pinTag,
        version: detail.json.tag_name.slice(TAG_PREFIX.length),
        publishedAt: detail.json.published_at,
        prerelease: Boolean(detail.json.prerelease),
        htmlUrl: detail.json.html_url,
        body: '',
      }
    } else {
      console.error(`FAIL github: pinned release ${pinTag} not found (${detail.status})`)
      return EXIT.API_FAILURE
    }
  }
  report.pinned = pinned
  report.latest = latest
  const order = compareVersions(latest.version, pinned.version)
  report.relation = order > 0 ? 'newer-upstream-available' : order < 0 ? 'pin-newer-than-latest-release' : 'up-to-date'
  report.newer = order > 0
  report.commits = null
  report.files = null
  report.packages = null
  report.serverish = null

  if (report.newer) {
    const compare = await api(`/repos/${repo}/compare/${pinTag}...${latest.tag}`)
    if (compare.status !== 200 || compare.json === null) {
      console.error(`FAIL github: compare ${pinTag}...${latest.tag} returned ${compare.status}: ${compare.text.slice(0, 200)}`)
      return EXIT.API_FAILURE
    }
    const files = Array.isArray(compare.json.files) ? compare.json.files : []
    report.commits = {
      total: Number(compare.json.total_commits ?? 0),
      list: (compare.json.commits ?? []).map((commit) => ({
        sha: String(commit.sha).slice(0, 12),
        date: commit.commit?.committer?.date ?? null,
        subject: String(commit.commit?.message ?? '').split('\n')[0],
      })),
    }
    report.files = {
      changed: files.length,
      truncated: files.length >= 300,
      additions: files.reduce((sum, file) => sum + Number(file.additions ?? 0), 0),
      deletions: files.reduce((sum, file) => sum + Number(file.deletions ?? 0), 0),
    }
    report.packages = groupByPackage(files)
    report.serverish = classifyFiles(files)
  }

  const lines = []
  lines.push('== WhaleGirlBot upstream sync check ==')
  lines.push(`repository: ${repo}`)
  lines.push(`pin:        ${pinTag} (${pinVersion}) published ${pinned.publishedAt ?? 'unknown'}`)
  lines.push(`latest:     ${latest.tag} published ${latest.publishedAt ?? 'unknown'}${latest.prerelease ? ' [prerelease]' : ''}`)
  lines.push(`relation:   ${report.relation}`)
  if (report.newer) {
    lines.push('')
    lines.push(`changes:    ${report.commits.total} commit(s), ${report.files.changed} file(s)${report.files.truncated ? ' (compare API caps the file list at 300 — real total may be higher; use the worktree diff for exact counts)' : ''}, +${report.files.additions}/-${report.files.deletions}`)
    for (const commit of report.commits.list.slice(0, 20)) lines.push(`  ${commit.sha} ${commit.subject}`)
    if (report.commits.list.length > 20) lines.push(`  … ${report.commits.list.length - 20} more commit(s)`)
    lines.push('')
    lines.push('touched packages (top 15):')
    for (const group of report.packages.slice(0, 15)) {
      lines.push(`  ${String(group.files).padStart(4)} file(s)  ${group.name}`)
    }
    lines.push('')
    lines.push(`server-side source candidates: ${report.serverish.serverish.length}`)
    for (const path of report.serverish.serverish.slice(0, 25)) lines.push(`  ${path}`)
    if (report.serverish.serverish.length > 25) lines.push(`  … ${report.serverish.serverish.length - 25} more`)
    lines.push('')
    lines.push(`release notes (${latest.tag}):`)
    lines.push(latest.body.trim().split('\n').slice(0, 12).map((line) => `  ${line}`).join('\n'))
    lines.push('')
    lines.push('NO UPGRADE PERFORMED. A candidate upgrade requires a /tmp worktree build, the compat suite')
    lines.push('(tools/upstream-sync/compat.mjs), a candidate package and explicit human approval — see docs/UPSTREAM-SYNC.md.')
  } else {
    lines.push('')
    lines.push('The pin is current; nothing to review.')
  }
  console.log(lines.join('\n'))

  if (options.write) {
    mkdirSync(reportsDir, { recursive: true })
    const stamp = report.checkedAt.replaceAll(':', '-')
    const payload = { ...report, exitCode: report.newer ? (options.failOnNewer ? EXIT.VALIDATION : 10) : EXIT.PASS }
    writeFileSync(join(reportsDir, `upstream-check-${stamp}.json`), JSON.stringify(payload, null, 2) + '\n')
    writeFileSync(join(reportsDir, 'upstream-check-latest.json'), JSON.stringify(payload, null, 2) + '\n')
  }
  if (options.json) console.log(JSON.stringify(report, null, 2))

  if (!report.newer) return EXIT.PASS
  return options.failOnNewer ? EXIT.VALIDATION : 10
}

try {
  const code = await main()
  process.exit(code)
} catch (error) {
  console.error(`FAIL upstream-check: ${error?.message || error}`)
  process.exit(EXIT.API_FAILURE)
}
