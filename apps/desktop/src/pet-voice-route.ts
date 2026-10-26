/** Resolve preserved voice profiles without sending another provider's credential to Qwen. */
import type { BotRuntimeConfig } from './bot-runtime.ts'
export function resolvePetVoiceRoute(voice: BotRuntimeConfig['voice']):
  | { ok: true; model: string; voice: string; notice?: string }
  | { ok: false; error: string } {
  const provider = voice?.provider || 'dashscope'
  if (!['dashscope', 'qwen', 'qwen-realtime'].includes(provider)) {
    return { ok: false, error: `保留了 ${provider} 语音配置。当前 Pipecat Worker 尚无此供应商适配器；请在 Bot 设置选择受支持的语音服务。未发送其凭据。` }
  }
  const model = voice?.model || 'qwen3-asr-flash-realtime'
  if (/^qwen(?:-audio)?(?:3)?-(?:omni|audio|realtime)/.test(model) || model.startsWith('qwen-audio-')) {
    return { ok: true, model: 'qwen3-asr-flash-realtime', voice: 'Cherry', notice: '已保留旧语音配置；Pipecat 本次使用独立 Qwen3 ASR／TTS 和 Cherry 音色。旧语音对语音模型不能作为 ASR 使用，可在 Bot 设置更新。' }
  }
  return { ok: true, model, voice: voice?.voice || 'Cherry' }
}
