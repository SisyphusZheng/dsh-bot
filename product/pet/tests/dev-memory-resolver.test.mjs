import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEV_MEMORY_ENV,
  DEV_MEMORY_RELATIVE_PATH,
  DEV_MEMORY_REQUIRED_FILES,
  MEMORY_BUILD_COMMAND,
  findWorkspaceRoot,
  resolveDevMemoryPayload,
  validateMemoryPayload,
} from '../src/dev-memory-resolver.mjs'

const sha256 = value => createHash('sha256').update(value).digest('hex')

function writeFile(path, content = '') {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function writeMemoryPayload(payloadPath, { postgres = '18.1.0', schema = 'dsh-bot.memory/v2', sidecar = 'export const memory = true\n' } = {}) {
  writeFile(join(payloadPath, 'VERSION.json'), JSON.stringify({
    schema,
    generatedAt: '2026-10-30T14:34:19.364Z',
    product: { name: 'dsh-bot', version: '0.0.1-beta' },
    runtime: { name: 'DeepSeek Harness', version: '0.2.1-rc.3' },
    dependencies: { hindsight: '1.0.0', postgres, embedding: 'Xenova/multilingual-e5-small@761b726d' },
    components: [{ path: 'runtime/hindsight', files: 2, sha256: 'fixture' }],
    sidecarSha256: sha256(sidecar),
  }, null, 2))
  writeFile(join(payloadPath, 'sidecar.mjs'), sidecar)
  writeFile(join(payloadPath, 'scripts/run-server.sh'), '#!/bin/bash\nexit 0\n')
  writeFile(join(payloadPath, 'adapter/m1-c-hindsight/src/index.js'), 'export {}\n')
  writeFile(join(payloadPath, 'runtime/hindsight/HindsightAPI'), 'fixture-binary\n')
  writeFile(join(payloadPath, 'runtime/models/Xenova/multilingual-e5-small/onnx/model_int8.onnx'), 'fixture-model\n')
  writeFile(join(payloadPath, `runtime/pg0/installation/${postgres}/bin/postgres`), 'fixture-postgres\n')
}

function fixtureWorkspace({ memory = true, ...payloadOptions } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dev-memory-'))
  writeFile(join(root, 'product/versions.json'), JSON.stringify({ product: { name: 'dsh-bot', version: '0.0.1-beta' }, runtime: { version: '0.2.1-rc.3' } }))
  if (memory) writeMemoryPayload(join(root, DEV_MEMORY_RELATIVE_PATH), payloadOptions)
  return root
}

test('the valid workspace payload is the normal dev Memory source', () => {
  const root = fixtureWorkspace()
  try {
    const resolved = resolveDevMemoryPayload({ repositoryRoot: root, env: {} })
    assert.equal(resolved.source, 'workspace')
    assert.equal(resolved.valid, true)
    assert.equal(resolved.path, join(root, DEV_MEMORY_RELATIVE_PATH))
    assert.match(resolved.message, /Memory dev payload ready/u)
    assert.equal(resolved.validation.version.schema, 'dsh-bot.memory/v2')
    assert.equal(resolved.validation.version.components, 1)
    assert.equal(resolved.validation.sidecarSha256Match, true)
    assert.deepEqual(resolved.validation.problems, [])
    assert.deepEqual(resolved.warnings, [])
    for (const required of DEV_MEMORY_REQUIRED_FILES) assert.ok(existsSync(join(resolved.path, required)), required)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a missing payload produces the explicit preflight message naming build-memory.sh, never a fake ready', () => {
  const root = fixtureWorkspace({ memory: false })
  try {
    const resolved = resolveDevMemoryPayload({ repositoryRoot: root, env: {} })
    assert.equal(resolved.valid, false)
    assert.equal(resolved.source, 'missing')
    assert.equal(resolved.path, null)
    assert.match(resolved.message, /Memory dev payload missing or invalid/u)
    assert.ok(resolved.message.includes(MEMORY_BUILD_COMMAND), resolved.message)
    assert.equal(MEMORY_BUILD_COMMAND, 'bash product/tools/build-memory.sh')
    assert.ok(resolved.warnings.some(warning => /NOT ready/u.test(warning)))
    assert.ok(resolved.workspace.problems.some(problem => problem.code === 'memory-payload-missing'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an incomplete payload reports each missing runnable file instead of pretending ready', () => {
  const root = fixtureWorkspace()
  try {
    rmSync(join(root, DEV_MEMORY_RELATIVE_PATH, 'runtime/hindsight'), { recursive: true, force: true })
    rmSync(join(root, DEV_MEMORY_RELATIVE_PATH, 'sidecar.mjs'), { force: true })
    const resolved = resolveDevMemoryPayload({ repositoryRoot: root, env: {} })
    assert.equal(resolved.valid, false)
    assert.ok(resolved.validation.missingFiles.includes('runtime/hindsight/HindsightAPI'))
    assert.ok(resolved.validation.missingFiles.includes('sidecar.mjs'))
    assert.ok(resolved.validation.problems.some(problem => problem.code === 'memory-file-missing'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a corrupt VERSION.json and a sidecar hash mismatch are classified, not waved through', () => {
  const root = fixtureWorkspace()
  try {
    const payload = join(root, DEV_MEMORY_RELATIVE_PATH)
    writeFile(join(payload, 'VERSION.json'), '{not json')
    const unreadable = validateMemoryPayload(payload)
    assert.equal(unreadable.valid, false)
    assert.ok(unreadable.problems.some(problem => problem.code === 'memory-version-unreadable'))

    writeMemoryPayload(payload)
    writeFile(join(payload, 'sidecar.mjs'), 'changed after staging\n')
    const mismatch = validateMemoryPayload(payload)
    assert.equal(mismatch.valid, false)
    assert.ok(mismatch.problems.some(problem => problem.code === 'memory-sidecar-hash-mismatch'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the PostgreSQL binary path follows the dependency version recorded in VERSION.json', () => {
  const root = fixtureWorkspace({ postgres: '19.2.1' })
  try {
    const resolved = resolveDevMemoryPayload({ repositoryRoot: root, env: {} })
    assert.equal(resolved.valid, true)
    assert.ok(existsSync(join(resolved.path, 'runtime/pg0/installation/19.2.1/bin/postgres')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('NISSE_MEMORY_DIR is an explicit diagnostic-compat override only, with source and validation shown', () => {
  const root = fixtureWorkspace({ memory: false })
  const overrideRoot = mkdtempSync(join(tmpdir(), 'dev-memory-override-'))
  try {
    writeMemoryPayload(overrideRoot)
    const resolved = resolveDevMemoryPayload({ repositoryRoot: root, env: { [DEV_MEMORY_ENV]: overrideRoot } })
    assert.equal(resolved.source, 'env-override')
    assert.equal(resolved.valid, true)
    assert.equal(resolved.path, overrideRoot)
    assert.equal(resolved.envOverride.present, true)
    assert.equal(resolved.envOverride.validation.valid, true)
    assert.ok(resolved.message.includes(DEV_MEMORY_ENV))
    assert.ok(resolved.message.includes(MEMORY_BUILD_COMMAND), 'override must still tell the developer how to prepare the workspace payload')
    assert.ok(resolved.warnings.some(warning => /diagnostic compatibility/u.test(warning)))
    assert.ok(resolved.warnings.some(warning => /must not depend/u.test(warning)))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(overrideRoot, { recursive: true, force: true })
  }
})

test('a valid workspace payload ignores NISSE_MEMORY_DIR and reports it as an ignored diagnostic override', () => {
  const root = fixtureWorkspace()
  const overrideRoot = mkdtempSync(join(tmpdir(), 'dev-memory-override-'))
  try {
    writeMemoryPayload(overrideRoot)
    const resolved = resolveDevMemoryPayload({ repositoryRoot: root, env: { [DEV_MEMORY_ENV]: overrideRoot } })
    assert.equal(resolved.source, 'workspace')
    assert.equal(resolved.path, join(root, DEV_MEMORY_RELATIVE_PATH))
    assert.equal(resolved.envOverride.present, true)
    assert.equal(resolved.envOverride.validation.valid, true)
    assert.equal(resolved.envOverride.ignored, false, 'the return object starts unmodified; warnings carry the ignore semantics')
    assert.ok(resolved.warnings.some(warning => /set but ignored/u.test(warning)))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(overrideRoot, { recursive: true, force: true })
  }
})

test('an explicit but invalid override is honored with its validation failure shown, not silently trusted', () => {
  const root = fixtureWorkspace({ memory: false })
  try {
    const resolved = resolveDevMemoryPayload({ repositoryRoot: root, env: { [DEV_MEMORY_ENV]: join(root, 'nowhere') } })
    assert.equal(resolved.source, 'env-override')
    assert.equal(resolved.valid, false)
    assert.equal(resolved.path, join(root, 'nowhere'))
    assert.ok(resolved.message.includes(MEMORY_BUILD_COMMAND), 'the preflight command is still shown')
    assert.ok(resolved.message.includes(DEV_MEMORY_ENV))
    assert.ok(resolved.warnings.some(warning => warning.includes(DEV_MEMORY_ENV) && /diagnostic compatibility/u.test(warning)))
    assert.ok(resolved.warnings.some(warning => /validation failed/u.test(warning)))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('workspace discovery uses the product/versions.json marker and does not guess a parent', () => {
  const root = fixtureWorkspace()
  try {
    const nested = join(root, 'apps/desktop/src')
    mkdirSync(nested, { recursive: true })
    assert.equal(findWorkspaceRoot(nested), root)
    const outside = mkdtempSync(join(tmpdir(), 'dev-memory-outside-'))
    try {
      assert.equal(findWorkspaceRoot(outside), null)
      const resolved = resolveDevMemoryPayload({ startDirectory: outside, env: {} })
      assert.equal(resolved.valid, false)
      assert.equal(resolved.source, 'missing')
      assert.match(resolved.message, /workspace root not found/u)
    } finally { rmSync(outside, { recursive: true, force: true }) }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('resolution is read-only: it creates and deletes nothing', () => {
  const root = fixtureWorkspace()
  try {
    const payload = join(root, DEV_MEMORY_RELATIVE_PATH)
    const before = readFileSync(join(payload, 'VERSION.json'), 'utf8')
    resolveDevMemoryPayload({ repositoryRoot: root, env: {} })
    resolveDevMemoryPayload({ repositoryRoot: root, env: { [DEV_MEMORY_ENV]: join(root, 'nowhere') } })
    assert.equal(readFileSync(join(payload, 'VERSION.json'), 'utf8'), before)
    assert.ok(existsSync(join(payload, 'runtime/hindsight/HindsightAPI')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
