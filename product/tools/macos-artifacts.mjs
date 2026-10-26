/** Bind a local DMG and its packaged metadata to a clean source commit. */
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { verifyHostClient } from './verify-host-client.mjs'
const root = resolve(import.meta.dirname, '../..')
const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'))
const { readAsar } = requireDesktop('app-builder-lib/out/asar/asar.js')
const [mode, path, manifestPath] = process.argv.slice(2)
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
if (mode === 'record') {
  if (!path.includes(sourceCommit.slice(0, 8))) throw new Error('DMG filename does not identify this source commit')
  const manifest = { sourceCommit, createdAt: new Date().toISOString(), platform: 'darwin', arch: 'arm64', artifact: { path: resolve(path), sha256: await sha256(path) } }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`${manifest.artifact.sha256}  ${manifest.artifact.path}`)
} else if (mode === 'verify') {
  const manifest = JSON.parse(readFileSync(manifestPath))
  if (manifest.sourceCommit !== sourceCommit || manifest.artifact.sha256 !== await sha256(path)) throw new Error('DMG does not match the recorded build and current source commit')
  console.log(JSON.stringify({ sourceCommit, dmg: resolve(path), sha256: manifest.artifact.sha256 }))
} else if (mode === 'app') {
  const archive = await readAsar(join(path, 'Contents/Resources/app.asar'))
  const metadata = await archive.readJson('package.json')
  if (metadata.dshBuildCommit !== sourceCommit || metadata.dshBuildDirty !== false) throw new Error('Packaged app is not the clean candidate source commit')
  verifyHostClient(join(path, 'Contents/Resources/host-integration'))
  console.log(`PASS packaged source identity: ${metadata.dshBuildCommit}`)
} else throw new Error('Usage: macos-artifacts.mjs record|verify <dmg> <manifest> | app <app>')
