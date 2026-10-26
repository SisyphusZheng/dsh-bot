/** Official Pipecat transport and media, bound to the existing pet animation. */
import { PipecatClient } from '@pipecat-ai/client-js'
import { SmallWebRTCTransport } from '@pipecat-ai/small-webrtc-transport'
const bridge = window.petBridge,
  button = document.getElementById('microphone'),
  status = document.getElementById('voice-status'),
  audio = document.getElementById('speaker'),
  message = document.getElementById('message'),
  approval = document.getElementById('approval')
let client = null,
  wanted = false,
  current = null,
  generation = 0,
  approvalId = '',
  text = ''
const report = (value) => {
  status.textContent = value
  void bridge.voiceStatus(value)
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
    enableMic: true,
    enableCam: false,
    callbacks: {
      onTrackStarted: (track, participant) => {
        if (client !== own || participant?.local || track.kind !== 'audio') return
        audio.srcObject = new MediaStream([track])
        void audio.play().catch(() => report('请点击麦克风按钮以允许声音播放'))
      },
      onBotReady: () => {
        if (client === own) report('语音已连接')
      },
      onDisconnected: () => {
        if (client === own) {
          client = null
          wanted = false
          audio.srcObject = null
          button.textContent = '开启语音'
          report('语音已断开，点击麦克风重试')
        }
      },
      onError: () => {
        if (client === own) report('语音连接失败，请检查 Key 与权限')
      },
      onServerMessage: (data) => {
        if (client !== own) return
        if (data.type === 'duck-playback') audio.volume = 0.3
        if (data.type === 'restore-playback') audio.volume = 1
        if (data.type === 'barge-in-confirmed') audio.muted = true
        if (data.type === 'playback-identity') {
          audio.muted = false
          audio.volume = 1
        }
      },
    },
  })
  client = own
  report('正在连接 ASR / Agent / TTS…')
  try {
    await own.connect({ webrtcRequestParams: { endpoint: state.offerUrl } })
  } catch {
    if (client === own) {
      await disconnect()
      wanted = false
      button.textContent = '开启语音'
      report('连接失败；检查麦克风权限、语音 Key 后重试')
    }
  }
}
async function apply(state) {
  current = state
  if (state.phase === 'available') {
    report(wanted ? '正在重连语音…' : '点击麦克风开始说话')
    if (wanted) await connect(state)
  } else {
    ++generation
    await disconnect()
    report(state.phase === 'reconnecting' ? '语音配置更新中…' : state.error || '语音未配置')
  }
}
button.addEventListener('click', async () => {
  wanted = !wanted
  button.textContent = wanted ? '关闭语音' : '开启语音'
  if (wanted && current) await connect(current)
  else {
    ++generation
    await disconnect()
    report('麦克风已关闭')
  }
})
bridge.onVoice((state) => {
  void apply(state)
})
bridge.onAgent((event) => {
  if (event.type === 'turn.accepted') text = ''
  if (event.type === 'assistant.delta') {
    text += event.data?.text || ''
    message.textContent = text.slice(-200)
  }
  if (event.type === 'approval.request') {
    approvalId = event.data.id
    message.textContent = event.data.reason || '允许执行此操作？'
    approval.hidden = false
  }
  if (event.type === 'approval.decided' || event.type === 'turn.ended') approval.hidden = true
  if (event.type === 'error') message.textContent = event.data?.message || 'Agent 执行失败'
})
for (const [id, decision] of [
  ['allow', 'allow'],
  ['reject', 'reject'],
])
  document.getElementById(id).addEventListener('click', async () => {
    try {
      await bridge.approve(approvalId, decision)
      approval.hidden = true
    } catch {
      message.textContent = '审批提交失败，请重试'
    }
  })
document.getElementById('cancel').addEventListener('click', async () => {
  try {
    await bridge.cancel()
    message.textContent = '已请求停止任务'
  } catch {
    message.textContent = '停止失败，请检查 Host 状态'
  }
})
void bridge.state().then(apply)
