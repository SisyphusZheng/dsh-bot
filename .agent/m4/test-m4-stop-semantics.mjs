// M4-4 stop-speaking vs cancel-task separation at runtime/state level (no mic).
import { writeFileSync } from 'node:fs'
import { VoiceRuntimeSupervisor } from '../m3/voice-runtime/supervisor.mjs'
import { ProductStateMachine } from '../m3/product-state/state-machine.mjs'
const results = { suite: 'M4-4 stop semantics', startedAt: new Date().toISOString(), steps: {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = async (name, fn) => { const s = Date.now(); try { const d = await fn(); results.steps[name] = { status: 'PASS', ms: Date.now() - s, detail: d }; console.log('PASS ' + name) } catch (e) { results.steps[name] = { status: 'FAIL', ms: Date.now() - s, error: String(e?.message || e) }; console.log('FAIL ' + name + ': ' + e?.message); throw e } }
const voice = new VoiceRuntimeSupervisor()
const uuid = () => crypto.randomUUID(); const ts = () => new Date().toISOString()
const contract = (type, source, data = {}) => ({ eventId: uuid(), ts: ts(), source, type, data })
const sm = new ProductStateMachine()
try {
  await step('stop-playback-keeps-task', async () => {
    await voice.start()
    voice.send('voice.start', { reason: 'm4-test' })
    await voice.waitFor((e) => e.type === 'voice.state' && e.state === 'listening', 5000, 'listening')
    sm.handle(contract('voice.state', 'voice', { state: 'listening' }))
    voice.send('tts.speak', { text: '正在播报' })
    await voice.waitFor((e) => e.type === 'voice.state' && e.state === 'speaking', 5000, 'speaking')
    sm.handle(contract('voice.state', 'voice', { state: 'speaking' }))
    const before = voice.events.length
    voice.send('voice.barge_in', { reason: 'stop-speaking' })
    await voice.waitFor((e) => e.type === 'voice.speech_stopped', 5000, 'speech_stopped')
    const after = voice.events.slice(before).map((e) => e.type)
    if (!after.includes('voice.speech_stopped')) throw new Error('no speech_stopped')
    if (!after.includes('voice.state')) throw new Error('no listening state after stop')
    return { speechEvents: after, state: sm.state }
  })
  await step('state-machine-settles', async () => {
    sm.handle(contract('turn.started', 'host-integration', { turnId: 's1:1' }))
    sm.handle(contract('turn.delta', 'host-integration', { text: 'OK' }))
    sm.handle(contract('turn.settled', 'host-integration', { turnId: 's1:1' }))
    return { state: sm.state }
  })
} finally { await voice.stop() }
results.ok = Object.values(results.steps).every((s) => s.status === 'PASS')
results.finishedAt = new Date().toISOString()
writeFileSync('$HOME/projects/dsh-bot-workspace/m4/evidence/M4-STOP-RESULT.json', JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify({ ok: results.ok, summary: Object.fromEntries(Object.entries(results.steps).map(([k, v]) => [k, v.status])) }))
process.exit(results.ok ? 0 : 1)
