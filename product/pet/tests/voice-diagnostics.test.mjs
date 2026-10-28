import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRedactingSink, MAX_LOG_CHUNK } from '../src/voice-worker-supervisor.mjs'
import { createVoiceSession } from '../src/voice-session.mjs'
import { createCompanionPresentation } from '../src/companion-presentation.mjs'
import { classifyVoiceError, voiceErrorNotice } from '../src/voice-input.mjs'

test('diagnostic output is not truncated to a few hundred characters', () => {
  const sink = createRedactingSink([])
  const line = `E ${'x'.repeat(1800)} [root-cause: no python-socks]`
  const out = sink.push(line) + sink.flush()
  assert.equal(out.length, line.length)
  assert.ok(out.includes('[root-cause: no python-socks]'))
})

test('a provider key split across stdout chunks never leaks even partially', () => {
  const key = 'sk-abcdefghijklmnopqrstuvwxyz012345'
  const sink = createRedactingSink([key])
  const chunks = [
    'Error setting up processor: auth ',
    key.slice(0, 11),
    key.slice(11, 25),
    key.slice(25),
    ' rejected',
  ]
  const out = chunks.map((chunk) => sink.push(chunk)).join('') + sink.flush()
  assert.ok(!out.includes(key), 'full key leaked')
  assert.ok(!out.includes(key.slice(0, 8)), 'partial key leaked')
  assert.ok(out.includes('[credential]'))
  assert.ok(out.includes('Error setting up processor'))
})

test('a complete key inside one chunk is replaced exactly once', () => {
  const key = 'dash-secret-value-123456'
  const sink = createRedactingSink([key])
  const out = sink.push(`Authorization: Bearer ${key} rejected`) + sink.flush()
  assert.equal(out, 'Authorization: Bearer [credential] rejected')
})

test('emitted records stay bounded while preserving the newest tail', () => {
  const sink = createRedactingSink([])
  const out = sink.push('a'.repeat(MAX_LOG_CHUNK + 500))
  assert.equal(out.length, MAX_LOG_CHUNK)
  assert.equal(out.at(-1), 'a')
})

test('worker classifications map to actionable localized notices with a diagnostic id', () => {
  const zh = voiceErrorNotice('proxy', { diagId: 've-abc123' })
  assert.equal(zh.kind, 'error')
  assert.equal(zh.retryable, true)
  assert.match(zh.text, /代理/)
  assert.match(zh.text, /ve-abc123/)
  const en = voiceErrorNotice('proxy', { diagId: 've-abc123', language: 'en' })
  assert.match(en.text, /proxy/i)
  assert.equal(classifyVoiceError('connecting through a SOCKS proxy requires python-socks'), 'proxy')
  assert.equal(classifyVoiceError('429 rate limit exceeded'), 'quota')
})

test('a classified failure can be retried in place without an app restart', async () => {
  let created = 0
  let disconnects = 0
  let callbacks
  const session = createVoiceSession({
    publish: () => {},
    createClient: (clientCallbacks) => {
      created += 1
      callbacks = clientCallbacks
      return {
        connect: async () => {},
        disconnect: async () => { disconnects += 1 },
        enableMic: async () => {},
      }
    },
  })
  await session.update('/offer')
  await session.command('enable')
  assert.equal(created, 1)
  callbacks.error(new Error('classified provider failure'))
  await session.retry()
  assert.equal(created, 2)
  await callbacks.ready()
  assert.equal(session.snapshot().wanted, true)
  assert.equal(session.snapshot().enabled, true)
  await session.stop()
  assert.equal(disconnects, 2)
})

test('a notice can expose the retry action without sending a DSH request', () => {
  const shown = []
  const presentation = createCompanionPresentation({
    show: (payload) => shown.push(payload),
    hide: () => {},
    animate: () => {},
    send: async () => { throw new Error('voice retry must not reach DSH') },
  })
  presentation.notice('语音连接被本机代理拦截', 'error', 15_000, '', { secondary: [{ id: 'retry-voice', label: '重试' }] })
  assert.equal(shown.at(-1).kind, 'error')
  assert.deepEqual(shown.at(-1).secondary, [{ id: 'retry-voice', label: '重试' }])
  presentation.stop()
})
