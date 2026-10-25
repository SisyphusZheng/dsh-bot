import { Worker } from 'node:worker_threads'

export class DesktopWakeWordRuntime {
  constructor({
    modelRoot,
    keywords = '',
    onDetected,
    onError,
    onReady,
    WorkerClass = Worker,
  }) {
    this.modelRoot = modelRoot
    this.keywords = String(keywords ?? '')
    this.onDetected = onDetected
    this.onError = onError
    this.onReady = onReady
    this.WorkerClass = WorkerClass
    this.worker = null
    this.enabled = false
    this.ready = false
  }

  setEnabled(enabled) {
    this.enabled = enabled === true
    if (this.enabled) this.#start()
    else this.stop()
  }

  /** 唤醒词短语变化：更新 keywords 行；运行中则重启检测器使其生效。 */
  setKeywords(keywords) {
    const next = String(keywords ?? '')
    if (next === this.keywords) return
    this.keywords = next
    if (!this.worker) return
    this.stop()
    if (this.enabled) this.#start()
  }

  accept(audio, sampleRate = 16_000) {
    if (!this.enabled || !this.ready || !this.worker || !audio) return false
    this.worker.postMessage({ type: 'audio', audio, sampleRate })
    return true
  }

  #start() {
    if (this.worker) return
    const worker = new this.WorkerClass(
      new URL('./worker.mjs', import.meta.url),
      { workerData: { modelRoot: this.modelRoot, keywords: this.keywords } },
    )
    this.worker = worker
    worker.on('message', message => {
      if (worker !== this.worker) return
      if (message?.type === 'ready') {
        this.ready = true
        this.onReady?.()
      }
      if (message?.type === 'detected') this.onDetected?.()
      if (message?.type === 'error') {
        this.onError?.(new Error(message.message))
        this.stop()
      }
    })
    worker.on('error', error => {
      if (worker !== this.worker) return
      this.onError?.(error)
      this.stop()
    })
    worker.on('exit', () => {
      if (worker !== this.worker) return
      this.worker = null
      this.ready = false
    })
  }

  stop() {
    const worker = this.worker
    this.worker = null
    this.ready = false
    worker?.terminate()
  }
}
