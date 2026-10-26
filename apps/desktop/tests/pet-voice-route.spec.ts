import { expect, it } from 'vitest'
import { resolvePetVoiceRoute } from '../src/pet-voice-route.ts'
it('resolves legacy speech-to-speech without rewriting its profile', () => {
  const profile = { provider: 'dashscope', model: 'qwen-audio-3.0-realtime-plus', voice: 'longanxiaoxin' }
  const route = resolvePetVoiceRoute(profile)
  expect(route).toMatchObject({ ok: true, model: 'qwen3-asr-flash-realtime', voice: 'Cherry' })
  expect(route.ok && route.notice).toContain('已保留旧语音配置')
  expect(profile.model).toBe('qwen-audio-3.0-realtime-plus')
})
it('never sends another provider credential to Qwen', () => {
  for (const provider of ['stepfun', 'doubao-seeduplex', 'local']) expect(resolvePetVoiceRoute({ provider })).toMatchObject({ ok: false })
})
it('preserves current ASR model and TTS voice', () => {
  expect(resolvePetVoiceRoute({ provider: 'dashscope', model: 'qwen3-asr-flash-realtime', voice: 'Serena' })).toEqual({ ok: true, model: 'qwen3-asr-flash-realtime', voice: 'Serena' })
})
