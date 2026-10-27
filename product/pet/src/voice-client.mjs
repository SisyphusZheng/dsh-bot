/** Official Pipecat media in the independent sprite document. */
import { PipecatClient } from '@pipecat-ai/client-js'
import { SmallWebRTCTransport, WavMediaManager } from '@pipecat-ai/small-webrtc-transport'
import { createCaptureClient } from './capture-client.mjs'
import { createVoiceSession } from './voice-session.mjs'
import { createPetView } from './pet-view.jsx'
import { createTaskCards } from './task-cards.mjs'
import { desktopTranslator } from './i18n.mjs'
const bridge = window.petBridge, audio = document.getElementById('speaker'), pet = document.getElementById('pet')
const view = createPetView(pet, () => report('桌宠素材加载失败，请打开 DSH 查看。'))
const micButton = document.getElementById('microphone'), hint = document.getElementById('hint'), taskCard = document.getElementById('tasks')
let preferences = { voiceInput: { mode: 'hold', keyId: 'alt' }, hint: '按住 Option/Alt 说话', language: 'zh', orbSkin: 'whale-girl' }
let capture, current, hintTimer, localMic, localContext, localProcessor, wakeReady = false, localStarting = false
const text = (zh, en) => preferences.language === 'en' ? en : zh
function showHint() { hint.textContent = preferences.hint || ''; document.body.dataset.hint = 'show'; clearTimeout(hintTimer); hintTimer = setTimeout(() => { delete document.body.dataset.hint }, 4500) }
function report(message, phase = 'idle', notify = true, kind = 'status', captureId = '', utteranceId = '') { void bridge.voiceStatus({ text: kind === 'status' ? desktopTranslator(preferences.language)(message) : message, phase, enabled: session.snapshot().enabled, transportPhase: session.snapshot().phase, notify, kind, captureId, utteranceId }) }
function level(value) { const amount = Math.min(1, Math.max(0, Number(value) || 0)); document.getElementById('level').style.setProperty('--level', String(1 + amount * 3)); document.getElementById('level').setAttribute('aria-valuenow', String(Math.round(amount * 100))) }
function stopLocal() { localProcessor?.disconnect(); localProcessor = undefined; localMic?.getTracks().forEach(track => track.stop()); localMic = undefined; void localContext?.close().catch(() => {}); localContext = undefined }
async function localWake() {
  if (localStarting || localMic || !wakeReady || !preferences.wakeWordEnabled || session.snapshot().enabled) return
  localStarting = true
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false })
    if (!wakeReady || !preferences.wakeWordEnabled || session.snapshot().enabled) { stream.getTracks().forEach(track => track.stop()); return }
    localMic = stream; localContext = new AudioContext({ sampleRate: 16000 })
    if (localContext.sampleRate !== 16000) { stopLocal(); throw new Error('当前音频设备无法以 16 kHz 运行离线唤醒') }
    const source = localContext.createMediaStreamSource(stream); localProcessor = localContext.createScriptProcessor(4096, 1, 1); source.connect(localProcessor); localProcessor.connect(localContext.destination)
    localProcessor.onaudioprocess = event => { const pcm = event.inputBuffer.getChannelData(0), bytes = new Uint8Array(pcm.length * 2), data = new DataView(bytes.buffer); for (let i = 0; i < pcm.length; i++) data.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32768))), true); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); void bridge.wakeAudio?.(btoa(binary), 16000) }
    report(text('离线唤醒待机：音频仅在本机检测。', 'On-device wake-word detection is ready.'))
  } catch (error) { report(error.message) } finally { localStarting = false }
}
const session = createVoiceSession({
  publish(status) {
    document.body.dataset.voice = status.phase; document.body.dataset.microphone = status.enabled ? 'on' : 'off'
    micButton.title = micButton.ariaLabel = status.phase === 'connecting' ? text('正在连接语音', 'Connecting voice') : status.enabled ? text('暂停麦克风', 'Pause microphone') : text('开启语音', 'Start voice')
    report(status.text, status.phase === 'listening' ? 'listening' : status.phase === 'connecting' ? 'processing' : 'idle', !!status.text)
    if (status.enabled || status.wanted) stopLocal(); else void localWake()
  },
  createClient(callbacks) {
    stopLocal()
    const mediaManager = new WavMediaManager(1024, 16000)
    let mediaQueue = Promise.resolve(); const setMic = mediaManager.enableMic.bind(mediaManager)
    mediaManager.enableMic = enabled => { const operation = mediaQueue.then(() => { if (mediaManager.isMicEnabled !== enabled) return setMic(enabled) }); mediaQueue = operation.catch(callbacks.error); return operation }
    mediaManager.setUserAudioCallback(buffer => { const samples = new Int16Array(buffer); let energy = 0; for (const sample of samples) energy += (sample / 32768) ** 2; level(Math.sqrt(energy / Math.max(1, samples.length))) })
    const own = new PipecatClient({ transport: new SmallWebRTCTransport({ mediaManager, iceServers: [], waitForICEGathering: true }), enableMic: false, enableCam: false, callbacks: {
      onTrackStarted(track, participant) { if (participant?.local || track.kind !== 'audio') return; audio.muted = false; audio.volume = 1; audio.srcObject = new MediaStream([track]); void audio.play().catch(() => report('声音播放失败，请重新连接。')) },
      onBotReady: callbacks.ready, onDisconnected: callbacks.disconnected, onError: callbacks.error,
      onDeviceError: error => callbacks.error(new Error(error?.error?.message || '麦克风设备不可用或权限被拒绝')),
      onMediaStateChanged: state => { if (state.mic?.state === 'error') callbacks.error(new Error('麦克风设备不可用或权限被拒绝')) },
      onLocalAudioLevel: level,
      onUserStartedSpeaking: () => report('', 'listening', false), onUserStoppedSpeaking: () => report('', 'processing', false),
      onBotStartedSpeaking: () => report('', 'speaking', false), onBotStoppedSpeaking: () => report('', session.snapshot().enabled ? 'listening' : 'idle', false),
      // Raw SDK transcripts precede the application capture/echo filter.
      onUserInput: () => {}, onSttRawText: () => {},
      onBotTtsText: data => { if (data.text) report(data.text, 'speaking', true, 'speech') },
      onServerMessage(data) { capture?.message(data); if (data.type === 'duck-playback') audio.volume = 0.3; if (data.type === 'restore-playback') audio.volume = 1; if (data.type === 'barge-in-confirmed') { audio.muted = true; report('', 'listening', false) }; if (data.type === 'playback-identity') { audio.muted = false; audio.volume = 1 }; if (data.type === 'greeting') report(data.text, 'speaking', true, 'speech') },
    } })
    capture = createCaptureClient({
      send: (type, data) => own.sendClientMessage(type, data),
      setMic: enabled => { const track = own.tracks()?.local?.audio; if (!enabled && track) track.enabled = false; own.enableMic(enabled); return mediaQueue },
      configure: async () => { const track = own.tracks()?.local?.audio; if (!track) throw new Error('麦克风音轨尚未就绪'); await track.applyConstraints({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }); const settings = track.getSettings(); void bridge.voiceStatus({notify:false,kind:'media',mediaSettings:{echoCancellation:settings.echoCancellation,noiseSuppression:settings.noiseSuppression,autoGainControl:settings.autoGainControl}}); report(settings.echoCancellation === false ? '当前麦克风未启用回声消除，建议使用耳机。' : '', 'idle', settings.echoCancellation === false) },
      publish: value => report(value.text, value.kind === 'input' ? 'listening' : 'processing', true, value.kind, value.captureId, value.utteranceId),
    })
    const ownCapture = capture
    return { connect: endpoint => own.connect({ webrtcRequestParams: { endpoint } }), disconnect: async () => { ownCapture.stop(); const tracks = Object.values(own.tracks()?.local || {}).filter(Boolean); try { await own.disconnect() } finally { for (const track of tracks) track.stop(); audio.srcObject = null; level(0) } }, enableMic: enabled => ownCapture.enable(enabled) }
  },
})
async function apply(state) { if (state.notice && state.notice !== current?.notice) report(state.notice); current = state; await session.update(state.phase === 'available' ? state.offerUrl : undefined); if (['failed', 'unconfigured'].includes(state.phase) && session.snapshot().wanted) report(state.error || '语音服务尚未就绪。') }
function command(value) { if (value.action === 'discard') { if (capture?.discard(value.captureId)) void session.command('mute'); return }; if (value.action === 'enable' || value.action === 'toggle') stopLocal(); void session.command(value.action || 'toggle'); if (current?.phase === 'unconfigured') report(current.error || '请先配置语音。') }
micButton.addEventListener('click', event => { event.stopPropagation(); command({ action: 'toggle' }) }); micButton.addEventListener('mousedown', event => event.stopPropagation())
bridge.onVoice(state => { void apply(state) }); bridge.onVoiceCommand(command)
function settings(value) { preferences = { ...preferences, ...value }; hint.textContent = preferences.hint || ''; view.update({ skin: preferences.orbSkin || 'whale-girl' }); document.documentElement.lang = preferences.language === 'en' ? 'en' : 'zh-CN'; if (!preferences.voiceInput?.hintSeen) showHint(); if (preferences.voiceInput?.mode === 'always') command({ action: 'enable' }); if (!preferences.wakeWordEnabled) stopLocal(); else void localWake() }
bridge.onPreferences?.(settings); void bridge.preferences?.().then(settings)
bridge.onWake?.(state => { wakeReady = state.ready; if (wakeReady) void localWake(); else stopLocal() })
bridge.onLifecycle?.(state => view.update({ state: state.state === 'active' ? 'waking' : 'hidden' })); bridge.onPresentation(value => view.update(value))
const tasks = createTaskCards(cards => { taskCard.replaceChildren(); for (const card of cards) { const row = document.createElement('div'), open = document.createElement('button'); open.className = 'task-open'; open.textContent = `${({ queued: '等待中', working: '进行中', completed: '完成', failed: '失败', cancelled: '已停止' })[card.state]} · ${card.tool || card.text || text('任务', 'Task')}`; open.addEventListener('click', () => void bridge.openMain()); row.appendChild(open); if (card.state === 'working') { const stop = document.createElement('button'); stop.textContent = text('停止', 'Stop'); stop.addEventListener('click', () => void bridge.cancel()); row.appendChild(stop) }; taskCard.appendChild(row) } })
bridge.onAgent?.(event => tasks.event(event)); void bridge.state().then(apply)
const keyMatch = event => preferences.voiceInput?.keyId === 'alt' && event.key === 'Alt'
window.addEventListener('keydown', event => { if (keyMatch(event) && !event.repeat && !preferences.globalOption) { event.preventDefault(); void bridge.gesture?.('down') } }); window.addEventListener('keyup', event => { if (keyMatch(event) && !preferences.globalOption) void bridge.gesture?.('up') })
pet.addEventListener('mousedown', event => { if (preferences.voiceInput?.keyId === 'mouse4' && event.button === 3 || preferences.voiceInput?.keyId === 'mouse5' && event.button === 4) { event.preventDefault(); void bridge.gesture?.('down') } }); window.addEventListener('mouseup', event => { if (event.button === 3 || event.button === 4) void bridge.gesture?.('up') })
pet.addEventListener('mouseenter', showHint)
let dragging = false, down, lastHover = 0, hit = false
function isOverSprite(event) { if (dragging) return true; const canvas = pet.querySelector('canvas'), bounds = canvas?.getBoundingClientRect(); if (!canvas || !bounds || event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom) return false; const x = Math.floor((event.clientX - bounds.left) * canvas.width / bounds.width), y = Math.floor((event.clientY - bounds.top) * canvas.height / bounds.height); return canvas.getContext('2d').getImageData(x, y, 1, 1).data[3] > 12 }
window.addEventListener('mousemove', event => { const nextHit = !!event.target.closest?.('#controls,#tasks') || isOverSprite(event); if (nextHit !== hit) { hit = nextHit; void bridge.hit(hit) }; if (down && (dragging || Math.hypot(event.screenX - down.x, event.screenY - down.y) > 4)) { dragging = true; pet.classList.add('dragging'); view.update({ dragDirection: event.screenX < down.x ? 'left' : 'right' }); void bridge.dragMove(event.screenX, event.screenY) } else if (hit && !down && performance.now() - lastHover > 6000) { lastHover = performance.now(); view.update({ cue: { id: `hover:${lastHover}`, name: 'jumping' } }) } })
pet.addEventListener('mousedown', event => { if (event.button !== 0 || !isOverSprite(event)) return; down = { x: event.screenX, y: event.screenY }; void bridge.dragStart(event.screenX, event.screenY); event.preventDefault() })
window.addEventListener('mouseup', () => { if (!down) return; down = undefined; dragging = false; pet.classList.remove('dragging'); view.update({ dragDirection: '' }); void bridge.dragEnd() })
pet.addEventListener('dblclick', event => { if (isOverSprite(event)) void bridge.openMain() }); pet.addEventListener('contextmenu', event => { event.preventDefault(); if (isOverSprite(event)) void bridge.menu() })
window.addEventListener('beforeunload', () => { clearTimeout(hintTimer); stopLocal(); void session.stop(); view.dispose() }, { once: true })
