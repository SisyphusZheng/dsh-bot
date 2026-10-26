/** Official Pipecat transport and original sprite renderer in the pet document. */
import { PipecatClient } from '@pipecat-ai/client-js'
import { SmallWebRTCTransport } from '@pipecat-ai/small-webrtc-transport'
import { createPetView } from './pet-view.jsx'
const bridge = window.petBridge, audio = document.getElementById('speaker'), pet = document.getElementById('pet')
const view = createPetView(pet, () => report('桌宠素材加载失败，请打开 DSH 查看。', 'idle', true))
let client = null, wanted = false, current = null, generation = 0
const report = (text, phase = 'idle', notify = false) => {
  void bridge.voiceStatus({ text, phase, enabled: wanted, notify })
}
async function disconnect() {
  const previous = client
  client = null
  if (previous) await previous.disconnect().catch(() => {})
  audio.srcObject = null
}
async function connect(state) {
  const revision = ++generation
  await disconnect()
  if (!wanted || revision !== generation || state.phase !== 'available') return
  const own = new PipecatClient({
    transport: new SmallWebRTCTransport({ iceServers: [], waitForICEGathering: true }),
    enableMic: true, enableCam: false,
    callbacks: {
      onTrackStarted: (track, participant) => {
        if (client !== own || participant?.local || track.kind !== 'audio') return
        audio.srcObject = new MediaStream([track])
        void audio.play().catch(() => report('声音播放失败，请重新开启语音。', 'idle', true))
      },
      onBotReady: () => { if (client === own) report('语音已连接', 'listening', true) },
      onUserStartedSpeaking: () => { if (client === own) report('', 'listening') },
      onUserStoppedSpeaking: () => { if (client === own) report('', 'processing') },
      onBotStartedSpeaking: () => { if (client === own) report('', 'speaking') },
      onBotStoppedSpeaking: () => { if (client === own) report('', 'listening') },
      onDisconnected: () => {
        if (client === own) { client = null; wanted = false; audio.srcObject = null; report('语音已断开，可右键重新开启。', 'idle', true) }
      },
      onError: () => { if (client === own) report('语音连接失败，请检查 Key 与权限。', 'idle', true) },
      onServerMessage: data => {
        if (client !== own) return
        if (data.type === 'duck-playback') audio.volume = 0.3
        if (data.type === 'restore-playback') audio.volume = 1
        if (data.type === 'barge-in-confirmed') { audio.muted = true; report('', 'listening') }
        if (data.type === 'playback-identity') { audio.muted = false; audio.volume = 1 }
      },
    },
  })
  client = own
  report('正在连接语音…', 'processing', true)
  try { await own.connect({ webrtcRequestParams: { endpoint: state.offerUrl } }) }
  catch {
    if (client === own) { await disconnect(); wanted = false; report('连接失败，请检查麦克风权限和语音 Key。', 'idle', true) }
  }
}
async function apply(state) {
  current = state
  if (state.phase === 'available') { if (wanted) await connect(state) }
  else {
    ++generation; await disconnect()
    if (wanted && ['failed', 'unconfigured'].includes(state.phase)) { wanted = false; report(state.error || '语音服务启动失败。', 'idle', true) }
    else report('', 'idle')
  }
}
bridge.onVoice(state => { void apply(state) })
bridge.onVoiceCommand(async () => {
  if (!wanted && current?.phase !== 'available') {
    report(current?.error || '语音正在准备，请稍后重试。', 'idle', true)
    return
  }
  wanted = !wanted
  if (wanted) await connect(current)
  else { ++generation; await disconnect(); report('语音已关闭', 'idle', true) }
})
bridge.onPresentation(value => view.update(value))
void bridge.state().then(apply)
let dragging = false, down = null, lastHover = 0, hit = false
function isOverSprite(event) {
  if (dragging) return true
  const canvas = pet.querySelector('canvas'), bounds = canvas?.getBoundingClientRect()
  if (!canvas || !bounds || event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom) return false
  const x = Math.floor((event.clientX - bounds.left) * canvas.width / bounds.width)
  const y = Math.floor((event.clientY - bounds.top) * canvas.height / bounds.height)
  return canvas.getContext('2d').getImageData(x, y, 1, 1).data[3] > 12
}
window.addEventListener('mousemove', event => {
  const nextHit = isOverSprite(event)
  if (nextHit !== hit) { hit = nextHit; void bridge.hit(hit) }
  if (down && (dragging || Math.hypot(event.screenX - down.x, event.screenY - down.y) > 4)) {
    dragging = true; pet.classList.add('dragging')
    view.update({ dragDirection: event.screenX < down.x ? 'left' : 'right' })
    void bridge.dragMove(event.screenX, event.screenY)
  } else if (hit && !down && performance.now() - lastHover > 6000) {
    lastHover = performance.now(); view.update({ cue: { id: `hover:${lastHover}`, name: 'jumping' } })
  }
})
pet.addEventListener('mousedown', event => {
  if (event.button !== 0 || !isOverSprite(event)) return
  down = { x: event.screenX, y: event.screenY }
  void bridge.dragStart(event.screenX, event.screenY)
  event.preventDefault()
})
window.addEventListener('mouseup', () => {
  if (!down) return
  down = null; dragging = false; pet.classList.remove('dragging'); view.update({ dragDirection: '' }); void bridge.dragEnd()
})
pet.addEventListener('dblclick', event => { if (isOverSprite(event)) void bridge.openMain() })
pet.addEventListener('contextmenu', event => { event.preventDefault(); if (isOverSprite(event)) void bridge.menu() })
window.addEventListener('beforeunload', () => { ++generation; wanted = false; void disconnect(); view.dispose() }, { once: true })
