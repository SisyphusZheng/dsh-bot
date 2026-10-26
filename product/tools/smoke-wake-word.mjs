/** Load the shipped native worker/model and feed PCM; spoken wake/TCC still needs native acceptance. */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { DesktopWakeWordRuntime } from '../../apps/desktop/resources/pet/wake-word/runtime.mjs'
import { wakeWordKeywordsLine } from '../pet/src/wake-word/keyword-phrase.mjs'
import assert from 'node:assert/strict'
let worker, deadline
try {
  await new Promise((done, fail) => {
    deadline = setTimeout(() => fail(new Error('KWS readiness deadline')), 15000)
    worker = new DesktopWakeWordRuntime({ modelRoot: resolve('.mvv-build/wake-worker'), bundledRoot: resolve('apps/desktop/resources/pet/wake-model'), engineEntry: createRequire(resolve('apps/desktop/package.json')).resolve('sherpa-onnx-node'), keywords: wakeWordKeywordsLine('你好小鲸'), onReady: done, onError: fail }); worker.setEnabled(true)
  })
  assert.equal(worker.ready, true); assert.equal(worker.accept(Buffer.alloc(32000).toString('base64')), true)
  await worker.stop(); assert.equal(worker.worker, null); assert.equal(worker.ready, false)
  console.log('PASS bundled native KWS worker/model readiness, PCM acceptance and termination; no spoken wake/TCC acceptance.')
} finally { clearTimeout(deadline); await worker?.stop() }
