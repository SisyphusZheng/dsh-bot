/** Serialize connections while applying release/mute intent during the handshake. */
export function createVoiceSession({ createClient, publish, handshakeTimeoutMs = 30000 }) {
  let client, ready = false, cancelConnect, phase = 'off', enabled = false, wanted = false, endpoint, queue = Promise.resolve(), stopped = false
  const report = (value, text = '') => { phase = value; publish({ phase, text, enabled, wanted }) }
  async function close() {
    const old = client; client = undefined; ready = false; enabled = false
    cancelConnect?.(); cancelConnect = undefined
    if (old) await old.disconnect()
  }
  async function open() {
    if (stopped || !wanted || !endpoint) { if (wanted && !endpoint) report('preparing', '正在准备语音服务…'); return }
    if (client) { if (ready) { await client.enableMic(true); enabled = wanted; report(wanted ? 'listening' : 'muted') }; return }
    report('connecting', '正在连接语音…')
    let own
    try {
      own = createClient({
        async ready() {
          if (client !== own || stopped) return
          ready = true
          const intent = wanted
          try {
            await own.enableMic(intent)
            if (client !== own || stopped || wanted !== intent) return
            enabled = intent
            report(intent ? 'listening' : 'muted', intent ? '我在听，你说。' : '')
          } catch (error) { if (client === own) { wanted = false; enabled = false; report('failed', error.message) } }
        },
        disconnected() { if (client !== own) return; void close().catch(() => {}); report(wanted ? 'failed' : 'off', wanted ? '语音断开，请重新连接。' : '') },
        error(error) { if (client !== own) return; void close().catch(() => {}); report('failed', `语音连接失败：${error?.message || error?.error || '请检查权限和配置'}`) },
      })
      client = own
      const cancelled = new Promise(resolve => { cancelConnect = resolve })
      let deadline
      try {
        const timeout = new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('语音连接超时，请检查麦克风权限、网络或服务配置。')), handshakeTimeoutMs) })
        await Promise.race([own.connect(endpoint), cancelled, timeout])
      } finally { clearTimeout(deadline) }
    } catch (error) { if (!own || client === own) { await close().catch(() => {}); report('failed', `连接失败：${error.message}`) } }
  }
  function schedule(operation) { const result = queue.then(operation); queue = result.catch(error => report('failed', error.message)); return result }
  return {
    update(value) { return schedule(async () => { if (value === endpoint) return; endpoint = value; await close(); if (wanted && endpoint) await open(); else if (!endpoint) report(wanted ? 'preparing' : 'off') }) },
    command(action) {
      if (stopped) return Promise.resolve()
      wanted = action === 'toggle' ? !wanted : action === 'enable'
      if (!wanted) { Promise.resolve(client?.enableMic(false)).catch(error => report('failed', error.message)); enabled = false }
      if (action === 'disable') { const closing = close(); return schedule(async () => { await closing; report('off', '语音已关闭') }) }
      return schedule(async () => { if (stopped) return; if (wanted) await open(); else report(client ? 'muted' : 'off') })
    },
    /** Reconnect in place after a classified failure; never requires an app restart. */
    retry() {
      if (stopped) return Promise.resolve()
      wanted = true
      return schedule(async () => {
        await close().catch(() => {})
        if (stopped) return
        await open()
      })
    },
    snapshot: () => ({ phase, enabled, wanted }),
    confirmInput(value) { if (ready && !stopped) return client?.confirmInput?.(value) },
    queueControl(value) { if (ready && !stopped) return client?.queueControl?.(value) },
    async stop() { stopped = true; wanted = false; await close(); await queue },
  }
}
