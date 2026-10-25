#!/usr/bin/env node
/** Generate COPY-MANIFEST.txt + COPY-MANIFEST-FILES.sha256 for the memory staging payload. */
import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.argv[2] || '/tmp/wg-memory-staging'
const PRODUCT_PREFIX = 'product/memory'
const EVIDENCE_SRC = join(ROOT, 'EVIDENCE.json')
const EVIDENCE_DST = 'm4/evidence/MEMORY-PACKAGING-STAGING.json'

const topEntries = [
  'runtime/hindsight',
  'runtime/models',
  'runtime/pg0',
  'adapter/m1-c-hindsight',
  'scripts/validate-offline.mjs',
  'scripts/gen-version.mjs',
  'scripts/gen-manifest.mjs',
  'sidecar.mjs',
  'VERSION.json',
  'INTEGRATION.md',
  'R1B-VALIDATION-PLAN.md',
]

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else if (entry.isFile()) out.push({ full, rel: relative(base, full), bytes: statSync(full).size, link: null })
    else if (entry.isSymbolicLink()) out.push({ full, rel: relative(base, full), bytes: 0, link: readlinkSync(full) })
  }
  return out
}

async function sha256File(path) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

const allFiles = []
const links = []
const entries = []
for (const entry of topEntries) {
  const full = join(ROOT, entry)
  const stat = statSync(full)
  if (stat.isDirectory()) {
    const files = walk(full)
    const lines = []
    for (const file of files.sort((a, b) => a.rel.localeCompare(b.rel))) {
      if (file.link !== null) { links.push(`${file.rel} -> ${file.link}`); continue }
      const digest = await sha256File(file.full)
      lines.push(`${file.rel}\t${file.bytes}\t${digest}`)
      allFiles.push({ src: file.full, dst: `${PRODUCT_PREFIX}/${entry}/${file.rel}`, bytes: file.bytes, sha256: digest })
    }
    const treeSha = createHash('sha256').update(lines.join('\n')).digest('hex')
    entries.push({ kind: 'dir', src: entry, dst: `${PRODUCT_PREFIX}/${entry}`, files: files.length, bytes: files.reduce((sum, f) => sum + f.bytes, 0), treeSha })
  } else {
    const digest = await sha256File(full)
    allFiles.push({ src: full, dst: `${PRODUCT_PREFIX}/${entry}`, bytes: stat.size, sha256: digest })
    entries.push({ kind: 'file', src: entry, dst: `${PRODUCT_PREFIX}/${entry}`, files: 1, bytes: stat.size, treeSha: digest })
  }
}

const manifest = []
manifest.push('COPY-MANIFEST — WhaleGirl Bot memory packaging payload')
manifest.push(`generatedAt: ${new Date().toISOString()}`)
manifest.push(`stagingRoot: ${ROOT}`)
manifest.push(`repoTarget:  nisse/${PRODUCT_PREFIX}/**`)
manifest.push('')
manifest.push('Apply (Lead):')
manifest.push('  mkdir -p <repo>/nisse/product/memory')
manifest.push('  rsync -a --exclude EVIDENCE.json ' + ROOT + '/ <repo>/nisse/product/memory/')
manifest.push('  cp ' + EVIDENCE_SRC + ' <repo>/nisse/m4/evidence/MEMORY-PACKAGING-STAGING.json')
manifest.push('  # verify: cd <repo>/nisse && shasum -a 256 -c /tmp/wg-memory-staging/COPY-MANIFEST-FILES.sha256')
manifest.push('')
manifest.push('Entries (source -> destination, files, bytes, sha256):')
for (const entry of entries) {
  manifest.push(`- ${entry.src} -> ${entry.dst} | ${entry.files} files | ${entry.bytes} bytes | sha256=${entry.treeSha}${entry.kind === 'dir' ? ' (tree hash over "rel\\tbytes\\tsha256" lines)' : ''}`)
}
manifest.push('')
manifest.push(`Total: ${allFiles.length} files, ${allFiles.reduce((sum, f) => sum + f.bytes, 0)} bytes, ${links.length} relative symlinks`)
if (links.length > 0) {
  manifest.push('')
  manifest.push('Symlinks (relative, must be preserved by the copy; listed in COPY-MANIFEST-LINKS.txt):')
  for (const link of links) manifest.push('- ' + link)
}
writeFileSync(join(ROOT, 'COPY-MANIFEST-LINKS.txt'), links.join('\n') + '\n')
writeFileSync(join(ROOT, 'COPY-MANIFEST.txt'), manifest.join('\n') + '\n')

const fileLines = allFiles.map((file) => `${file.sha256}  ${file.dst}`)
fileLines.push(`${await sha256File(EVIDENCE_SRC)}  ${EVIDENCE_DST}`)
writeFileSync(join(ROOT, 'COPY-MANIFEST-FILES.sha256'), fileLines.join('\n') + '\n')
console.log(`manifest files=${allFiles.length} bytes=${allFiles.reduce((sum, f) => sum + f.bytes, 0)}`)
