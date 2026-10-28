/** A capture is admitted by the worker before enabling media; release never closes RTC. */
export function createCaptureClient({ send, setMic, configure = async () => {}, publish = () => {}, timeoutMs = 5000, id = () => crypto.randomUUID() }) {
  let current = '', wanted = false, stopped = false, pending, inFlight
  const completed = new Set()
  function end(discard = false) {
    wanted = false
    pending?.reject(); pending = undefined
    void setMic(false)
    if (current) { send('capture-state', { action: discard ? 'discard' : 'finish', captureId: current }); publish({ kind: 'capture-end', captureId: current, text: '' }) }
  }
  return {
    async enable(value) {
      if (!value) { end(); return }
      if (stopped || wanted) return inFlight
      wanted = true; const own = current = id()
      inFlight = (async () => { try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending = undefined; reject(new Error('录音控制未就绪，请重新连接语音。')) }, timeoutMs)
          pending = { id: own, resolve: () => { clearTimeout(timer); resolve() }, reject: () => { clearTimeout(timer); reject(new Error('录音已关闭')) } }
          send('capture-state', { action: 'start', captureId: own })
        })
        await configure()
        if (!stopped && wanted && current === own) {
          await setMic(true)
          if (!stopped && wanted && current === own) publish({ kind: 'capture-start', captureId: own, text: '' })
        }
      } catch (error) { if (wanted && current === own) { end(true); throw error } } })()
      return inFlight
    },
    discard(captureId) { if (captureId !== current) return false; end(true); completed.add('discard:' + captureId); return true },
    message(data) {
      if (data.type === 'capture-ack' && data.action === 'start' && data.captureId === pending?.id) { const own = pending; pending = undefined; own.resolve(); return }
      if (data.type === 'capture-rejected' && data.captureId === current) { completed.add(data.utteranceId); publish({kind:'capture-end',captureId:current,text:''}); return }
      if (data.type !== 'capture-transcript' || data.captureId !== current || completed.has('discard:' + current) || data.type === 'capture-transcript' && completed.has(data.utteranceId)) return
      const final = data.final === true
      if (final) { completed.add(data.utteranceId); if (completed.size > 64) completed.delete(completed.values().next().value) }
      publish({ kind: final ? 'transcript' : 'input', captureId: current, utteranceId: data.utteranceId, text: data.text })
    },
    stop() { stopped = true; end(true); pending?.reject(); pending = undefined },
    snapshot: () => ({ captureId: current, wanted }),
  }
}
