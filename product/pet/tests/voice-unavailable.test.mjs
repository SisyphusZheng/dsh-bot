import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVoiceSession } from '../src/voice-session.mjs'

test('unavailable configuration clears pending intent without creating a media client', async () => {
  const states = []
  let clients = 0
  const session = createVoiceSession({ createClient() { clients++; throw new Error('must not connect') }, publish: s => states.push(s) })
  await session.command('enable')
  assert.equal(session.snapshot().wanted, true)
  await session.unavailable('请先配置主模型 API Key')
  assert.deepEqual(session.snapshot(), { phase: 'failed', enabled: false, wanted: false })
  assert.equal(states.at(-1).text, '请先配置主模型 API Key')
  await session.update('http://localhost/offer')
  assert.equal(clients, 0, 'configuration recovery must not silently open the microphone')
  await session.stop()
})
