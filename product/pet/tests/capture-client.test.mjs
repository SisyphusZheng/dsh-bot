import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCaptureClient } from '../src/capture-client.mjs'

/**
 * A release message must carry the interaction mode. The worker used to treat a
 * missing mode as "always", which rewrote the Host capture projection: a late
 * final then looked like always-listening input (confirmation draft) and the
 * wrong mode was persisted for the next launch.
 */
function client(mode = 'hold') {
  const sent = []
  const value = createCaptureClient({
    send: (type, message) => sent.push([type, message]),
    setMic: async () => {},
    publish: () => {},
    mode: () => mode,
    id: () => 'cap-fixed',
  })
  return { value, sent }
}

async function started(mode = 'hold') {
  const { value, sent } = client(mode)
  const enabling = value.enable(true)
  value.message({ type: 'capture-ack', action: 'start', captureId: 'cap-fixed' })
  await enabling
  return { value, sent }
}

test('the start message carries the mode', async () => {
  const { sent } = await started('hold')
  assert.deepEqual(sent[0], ['capture-state', { action: 'start', captureId: 'cap-fixed', mode: 'hold' }])
})

test('finish and discard keep the mode instead of omitting it', async () => {
  const hold = await started('hold')
  hold.value.discard('cap-fixed')
  assert.deepEqual(hold.sent.at(-1), ['capture-state', { action: 'discard', captureId: 'cap-fixed', mode: 'hold' }])

  const always = await started('always')
  always.value.enable(false)
  assert.deepEqual(always.sent.at(-1), ['capture-state', { action: 'finish', captureId: 'cap-fixed', mode: 'always' }])
})
