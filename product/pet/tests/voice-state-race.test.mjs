import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createVoiceSession } from '../src/voice-session.mjs'

// Execute the actual renderer state handlers, not a separately reimplemented model.
function handlers(session) {
  const source = readFileSync(new URL('../src/voice-client.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('function unavailableVoice(')
  const end = source.indexOf("micButton.addEventListener", start)
  return runInNewContext(`let current, voiceStateRevision=0; ${source.slice(start,end)}; ({apply,command})`, { session, report() {}, stopLocal() {}, preferences: { voiceInput: {mode:'hold'} } })
}
test('stale unavailable state cannot undo newer available state and explicit enable', async () => {
  let clients=0
  const session=createVoiceSession({publish(){},createClient(){clients++;return {connect:async()=>{},disconnect:async()=>{},enableMic(){}}}})
  const h=handlers(session)
  const old=h.apply({phase:'unconfigured',error:'missing key'})
  const latest=h.apply({phase:'available',offerUrl:'/offer'})
  const enabling=session.command('enable')
  await Promise.all([old,latest,enabling])
  assert.equal(session.snapshot().wanted,true)
  assert.notEqual(session.snapshot().phase,'failed')
  assert.equal(clients,1)
  await session.stop()
})
test('unconfigured Option down and up never enter preparing or clear the useful failure', async () => {
  const states=[]
  const session=createVoiceSession({publish:s=>states.push(s),createClient(){throw Error('unexpected media')}})
  const h=handlers(session)
  await h.apply({phase:'unconfigured',error:'missing key'})
  h.command({action:'enable',source:'gesture'})
  h.command({action:'mute',source:'gesture'})
  await new Promise(r=>setImmediate(r))
  assert.equal(session.snapshot().wanted,false)
  assert.equal(states.at(-1).text,'missing key')
  assert.ok(!states.some(s=>s.phase==='preparing'))
  await session.stop()
})
