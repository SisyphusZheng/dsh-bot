// 桌宠 orb 窗口的 preload。W1 后只暴露 Body Runtime 需要的能力：
// 拖动/位置、生命周期、语音唤醒音频、气泡、任务卡布局、双击打开 DSH、
// 以及归 DSH 的设置入口（不再有独立设置窗口）。
const { contextBridge, ipcRenderer } = require('electron')

function sendPoint(channel, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  ipcRenderer.send(channel, { x, y })
}

contextBridge.exposeInMainWorld('qwenAudioAgentDesktop', {
  dragStart: (x, y) => sendPoint('qwen-audio-agent:drag-start', x, y),
  dragMove: (x, y) => sendPoint('qwen-audio-agent:drag-move', x, y),
  dragEnd: () => ipcRenderer.send('qwen-audio-agent:drag-end'),
  // W6：双击桌宠/气泡 → 主进程 → 桌面壳 POST /bot/toggle-main。
  openDsh: () => ipcRenderer.invoke('nisse:open-dsh'),
  // 设置归 DSH Settings → Bot：桌面壳打开 DSH 并跳到 Bot 页。
  openSettings: () => ipcRenderer.send('qwen-audio-agent:open-settings'),
  setTaskCardCount: count => ipcRenderer.send(
    'qwen-audio-agent:task-card-count',
    count,
  ),
  // 头顶气泡：渲染层把要显示的文字/状态交给主进程，由独立的透明气泡窗口
  // 渲染；orb 窗口尺寸/位置不变。
  setOrbBubble: payload => ipcRenderer.send(
    'qwen-audio-agent:orb-bubble',
    payload || {},
  ),
  onTaskCardPlacement: callback => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, layout) => {
      callback({
        placement: layout?.placement === 'above' ? 'above' : 'below',
        orbOffsetX: Number.isFinite(layout?.orbOffsetX)
          ? layout.orbOffsetX
          : 0,
        headroom: Number.isFinite(layout?.headroom)
          ? Math.max(0, layout.headroom)
          : null,
      })
    }
    ipcRenderer.on('qwen-audio-agent:ta[REDACTED_KEY]', listener)
    return () => ipcRenderer.removeListener(
      'qwen-audio-agent:ta[REDACTED_KEY]',
      listener,
    )
  },
  // 展示形态固定为 orb：聊天面板已从 Body Runtime 移除，这里保留通道仅为
  // 兼容渲染层的调用（主进程始终返回 orb）。
  loadSurface: () => ipcRenderer.invoke('qwen-audio-agent:surface-load'),
  setSurface: mode => ipcRenderer.invoke(
    'qwen-audio-agent:surface-set',
    mode,
  ),
  // 会话归 DSH；桌宠不创建/切换任何会话，该通道只做兼容返回。
  setConversationSession: sessionId => ipcRenderer.invoke(
    'qwen-audio-agent:conversation-session-set',
    sessionId,
  ),
  enterHide: options => ipcRenderer.invoke(
    'qwen-audio-agent:enter-hide',
    options,
  ),
  wake: () => ipcRenderer.send('qwen-audio-agent:wake'),
  acceptWakeWordAudio: (audio, sampleRate) => ipcRenderer.send(
    'qwen-audio-agent:wake-word-audio',
    { audio, sampleRate },
  ),
  lifecycleReady: () => ipcRenderer.send('qwen-audio-agent:lifecycle-ready'),
  loadLifecycle: () => ipcRenderer.invoke('qwen-audio-agent:lifecycle-load'),
  onLifecycle: callback => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, lifecycle) => callback(lifecycle)
    ipcRenderer.on('qwen-audio-agent:lifecycle', listener)
    return () => ipcRenderer.removeListener(
      'qwen-audio-agent:lifecycle',
      listener,
    )
  },
  onClientSettings: callback => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, settings) => callback(settings || {})
    ipcRenderer.on('qwen-audio-agent:client-settings', listener)
    return () => ipcRenderer.removeListener(
      'qwen-audio-agent:client-settings',
      listener,
    )
  },
  quit: () => ipcRenderer.send('qwen-audio-agent:quit'),
  // 语音输入（Body Runtime）：主进程把说话键/模式动作推给渲染层注入的
  // 小控制器，由它点击渲染层自己的麦克风按钮（不新增会话/不新增 UI 窗口）。
  onTalkKey: callback => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, payload) => callback(payload || {})
    ipcRenderer.on('nisse-talk-key', listener)
    return () => ipcRenderer.removeListener('nisse-talk-key', listener)
  },
  onVoiceCommand: callback => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, payload) => callback(payload || {})
    ipcRenderer.on('nisse-voice-command', listener)
    return () => ipcRenderer.removeListener('nisse-voice-command', listener)
  },
  reportVoiceState: state => ipcRenderer.send(
    'nisse:voice-state',
    state && typeof state === 'object' ? state : {},
  ),
  // 按下说话键前先问主进程：语音是否可用（壳里有没有 Key / 网关是否在跑）。
  // 不可用时主进程已经在气泡里说清楚，渲染层不点麦克风。
  checkVoiceReady: () => ipcRenderer.invoke('nisse:voice-ready'),
})
