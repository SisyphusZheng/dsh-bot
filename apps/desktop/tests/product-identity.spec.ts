import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { hostProductIdentity, runtimeManifestVersion } from '../src/product-identity.ts'

const directories: string[] = []

function runtimeDirectory(version?: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-product-identity-'))
  directories.push(directory)
  if (version !== undefined) writeFileSync(join(directory, 'package.json'), JSON.stringify({ version }))
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('reports the application version with the launched runtime manifest version', () => {
  expect(hostProductIdentity('0.0.1', runtimeDirectory('0.2.1-rc.3'))).toEqual({
    NISSE_PRODUCT_VERSION: '0.0.1',
    NISSE_RUNTIME_VERSION: '0.2.1-rc.3',
  })
})

it('omits the runtime version when the manifest cannot be read instead of guessing one', () => {
  expect(runtimeManifestVersion(runtimeDirectory())).toBe('')
  expect(runtimeManifestVersion(join(runtimeDirectory(), 'absent'))).toBe('')
  expect(hostProductIdentity('0.0.1', runtimeDirectory())).toEqual({ NISSE_PRODUCT_VERSION: '0.0.1' })
})

it('ignores a manifest whose version is not a string', () => {
  expect(runtimeManifestVersion(runtimeDirectory(7))).toBe('')
})
