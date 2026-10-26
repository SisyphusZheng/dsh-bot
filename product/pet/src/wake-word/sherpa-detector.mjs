import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { ensureWakeWordModel, WAKE_WORD_MODEL_FILES } from './model-manager.mjs'

const require = createRequire(import.meta.url)
const engines = new Map()

function pcm16Base64ToFloat32(audio) {
  const bytes = Buffer.from(audio, 'base64')
  const sampleCount = Math.floor(bytes.length / 2)
  const samples = new Float32Array(sampleCount)
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = bytes.readInt16LE(index * 2) / 32768
  }
  return samples
}

async function createEngine({ modelRoot, keywords, engineEntry, bundledRoot }) {
  const modelDirectory = await ensureWakeWordModel(modelRoot, { keywords, bundledRoot })
  const { KeywordSpotter } = require(engineEntry || 'sherpa-onnx-node')
  const keywordSpotter = new KeywordSpotter({
    featConfig: { samplingRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: resolve(modelDirectory, WAKE_WORD_MODEL_FILES.encoder),
        decoder: resolve(modelDirectory, WAKE_WORD_MODEL_FILES.decoder),
        joiner: resolve(modelDirectory, WAKE_WORD_MODEL_FILES.joiner),
      },
      tokens: resolve(modelDirectory, WAKE_WORD_MODEL_FILES.tokens),
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
      modelingUnit: 'cjkchar',
    },
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    keywordsScore: 1.0,
    keywordsThreshold: 0.25,
    keywordsFile: resolve(modelDirectory, WAKE_WORD_MODEL_FILES.keywords),
  })
  return keywordSpotter
}

async function engineFor(options) {
  // 唤醒词短语变化时需要新引擎，缓存键同时包含关键词内容。
  const key = `${resolve(options.modelRoot)}\u0000${options.keywords || ''}`
  if (!engines.has(key)) {
    engines.set(key, createEngine(options).catch(error => {
      engines.delete(key)
      throw error
    }))
  }
  return engines.get(key)
}

export async function createSherpaWakeWordDetector({ modelRoot, keywords = '', engineEntry, bundledRoot }) {
  const keywordSpotter = await engineFor({ modelRoot, keywords, engineEntry, bundledRoot })
  const stream = keywordSpotter.createStream()
  return {
    accept(audio, sampleRate = 16000) {
      const samples = pcm16Base64ToFloat32(audio)
      if (!samples.length) return false
      stream.acceptWaveform({ sampleRate, samples })
      while (keywordSpotter.isReady(stream)) keywordSpotter.decode(stream)
      const result = keywordSpotter.getResult(stream)
      if (!result.keyword) return false
      keywordSpotter.reset(stream)
      return true
    },
    reset() {
      keywordSpotter.reset(stream)
    },
  }
}

export { pcm16Base64ToFloat32 }
