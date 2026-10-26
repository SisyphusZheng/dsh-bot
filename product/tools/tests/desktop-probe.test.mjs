import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { connectPage, until } from '../desktop-web-acceptance.mjs'
import { waitMemoryReady } from '../wait-memory-ready.mjs'
const { WebSocketServer } = createRequire(new URL('../../../apps/desktop/package.json', import.meta.url))('ws')

test('DevTools probe reports protocol errors and disconnects without closing the App', async () => {
  const server = createServer(), sockets = new WebSocketServer({ server })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const calls = []
  sockets.on('connection', socket => socket.on('message', bytes => {
    const { id, method, params } = JSON.parse(bytes); calls.push(method)
    socket.send(JSON.stringify(method === 'Runtime.evaluate' ? { id, result: { result: { value: params.expression } } } : { id, error: { message: 'fixture protocol failure' } }))
  }))
  let page
  try {
    page = await connectPage(`ws://127.0.0.1:${server.address().port}`)
    assert.equal(await page.evaluate('actual expression'), 'actual expression')
    await assert.rejects(page.call('invalid'), /fixture protocol failure/)
    await page.close(); page = null
    assert.deepEqual(calls, ['Runtime.evaluate', 'invalid'])
  } finally { await page?.close(); await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve)) }
})

test('readiness names its failed phase and stops immediately on a fatal boot report', async () => {
  let calls = 0
  await assert.rejects(until(() => { calls++; throw Object.assign(new Error('web boot: import failed'), { fatal: true }) }), /web boot: import failed/)
  assert.equal(calls, 1)
  await assert.rejects(until(() => false, { timeoutMs: 10, intervalMs: 1, label: 'web boot' }), /web boot deadline/)
})

test('Memory readiness requires live authenticated health instead of the descriptor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-ready-')), path = join(dir, 'runtime.json')
  let calls = 0
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fixture-token'); calls++
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: calls > 1 }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    writeFileSync(path, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token: 'fixture-token' }))
    await waitMemoryReady(path, { timeoutMs: 3000, intervalMs: 1 }); assert.ok(calls > 1)
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections() }); rmSync(dir, { recursive: true, force: true }) }
})

test('native acceptance persists failure and rejects an incomplete overall PASS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-record-')), manifest = join(dir, 'build.json')
  const run = (...args) => spawnSync(process.execPath, ['product/tools/record-macos-acceptance.mjs', dir, manifest, ...args], { encoding: 'utf8' })
  try {
    writeFileSync(manifest, JSON.stringify({ sourceCommit: 'fixture-commit', artifact: { sha256: 'fixture-hash' } }))
    assert.equal(run('initialize').status, 0)
    assert.equal(run('first-web-boot-and-navigation', 'FAIL').status, 0)
    assert.notEqual(run('overall', 'PASS').status, 0)
    const result = JSON.parse(readFileSync(join(dir, 'RESULTS.json'), 'utf8'))
    assert.equal(result.status, 'FAIL'); assert.equal(result.phases['first-web-boot-and-navigation'], 'FAIL')
    assert.equal(result.sourceCommit, 'fixture-commit')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
