import { createHash } from 'node:crypto'
import {
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const WAKE_WORD_MODEL_NAME = 'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20'
export const WAKE_WORD_MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${WAKE_WORD_MODEL_NAME}.tar.bz2`
export const WAKE_WORD_MODEL_SHA256 = '68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6'

export const WAKE_WORD_MODEL_FILES = Object.freeze({
  encoder: 'encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx',
  decoder: 'decoder-epoch-13-avg-2-chunk-8-left-64.onnx',
  joiner: 'joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx',
  tokens: 'tokens.txt',
  keywords: 'keywords.txt',
})

// 唤醒词短语由设置页写入；这里保留上游默认值，供未配置短语的旧安装与测试使用。
const DEFAULT_KEYWORDS_LINE = 'n ǐ h ǎo q iān w èn @你好千问'
const ARCHIVE_FILES = new Set([
  WAKE_WORD_MODEL_FILES.encoder,
  WAKE_WORD_MODEL_FILES.decoder,
  WAKE_WORD_MODEL_FILES.joiner,
  WAKE_WORD_MODEL_FILES.tokens,
])
const MODEL_FILES = Object.freeze([
  WAKE_WORD_MODEL_FILES.encoder,
  WAKE_WORD_MODEL_FILES.decoder,
  WAKE_WORD_MODEL_FILES.joiner,
  WAKE_WORD_MODEL_FILES.tokens,
])
const REQUIRED_FILES = new Set(Object.values(WAKE_WORD_MODEL_FILES))
const preparations = new Map()

function modelComplete(directory) {
  return MODEL_FILES.every(file => existsSync(resolve(directory, file)))
}

function complete(directory) {
  return [...REQUIRED_FILES].every(file => existsSync(resolve(directory, file)))
}

/** keywords.txt 只保留一条关键词行；空值回退到上游默认短语。 */
function normalizeKeywords(keywords) {
  const text = String(keywords ?? '').trim()
  return `${text || DEFAULT_KEYWORDS_LINE}\n`
}

// 短语变化时不需要重新下载模型，直接原子替换 keywords.txt 即可。
function writeKeywords(directory, keywords) {
  const text = normalizeKeywords(keywords)
  const target = resolve(directory, WAKE_WORD_MODEL_FILES.keywords)
  try {
    if (readFileSync(target, 'utf8') === text) return
  } catch {}
  const temporary = `${target}.${process.pid}-${Date.now()}.tmp`
  writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, target)
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function download(url, path, fetchImpl) {
  const response = await fetchImpl(url)
  if (!response.ok || !response.body) {
    throw new Error(`唤醒词模型下载失败：HTTP ${response.status}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path, {
    flags: 'wx',
    mode: 0o600,
  }))
}

async function extractSelected(archivePath, targetDirectory) {
  await promisify(execFile)('tar', ['--no-same-owner', '-xjf', archivePath, '-C', targetDirectory, '--strip-components=1', ...[...ARCHIVE_FILES].map(name => `${WAKE_WORD_MODEL_NAME}/${name}`)])
}

async function prepare(directory, { fetchImpl }) {
  if (modelComplete(directory)) return directory
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 })
  const nonce = `${process.pid}-${Date.now()}`
  const archivePath = resolve(dirname(directory), `${WAKE_WORD_MODEL_NAME}-${nonce}.tar.bz2`)
  const stagingDirectory = resolve(dirname(directory), `.${WAKE_WORD_MODEL_NAME}-${nonce}`)
  mkdirSync(stagingDirectory, { recursive: false, mode: 0o700 })
  try {
    await download(WAKE_WORD_MODEL_URL, archivePath, fetchImpl)
    const digest = await sha256(archivePath)
    if (digest !== WAKE_WORD_MODEL_SHA256) {
      throw new Error('唤醒词模型校验失败')
    }
    await extractSelected(archivePath, stagingDirectory)
    // 关键词表由调用方短语生成，下载阶段先留空，由 ensureWakeWordModel 写入。
    writeFileSync(
      resolve(stagingDirectory, WAKE_WORD_MODEL_FILES.keywords),
      normalizeKeywords(),
      { encoding: 'utf8', mode: 0o600 },
    )
    if (!complete(stagingDirectory)) {
      throw new Error('唤醒词模型缺少必需文件')
    }
    rmSync(directory, { recursive: true, force: true })
    renameSync(stagingDirectory, directory)
    return directory
  } finally {
    rmSync(archivePath, { force: true })
    rmSync(stagingDirectory, { recursive: true, force: true })
  }
}

/**
 * 确保模型可用的同时，把唤醒词短语写入 keywords.txt。
 *
 * @param {string} directory 模型缓存目录（cache/models/wake-word）
 * @param {{ fetchImpl?: typeof fetch, keywords?: string }} [options]
 *   keywords 为 keyword-phrase.mjs 生成的 keywords 行；省略时保留上游默认短语。
 */
export function ensureWakeWordModel(directory, {
  fetchImpl = fetch,
  keywords,
  bundledRoot,
} = {}) {
  const target = resolve(directory, WAKE_WORD_MODEL_NAME)
  const keywordText = normalizeKeywords(keywords)
  if (!modelComplete(target) && bundledRoot && existsSync(resolve(bundledRoot, 'MODEL.json'))) {
    const record = JSON.parse(readFileSync(resolve(bundledRoot, 'MODEL.json'), 'utf8'))
    if (record.archiveSha256 !== WAKE_WORD_MODEL_SHA256) throw new Error('Bundled wake model identity mismatch')
    for (const file of MODEL_FILES) { const bytes = readFileSync(resolve(bundledRoot, WAKE_WORD_MODEL_NAME, file)); if (createHash('sha256').update(bytes).digest('hex') !== record.files[file]) throw new Error(`Bundled wake model corrupt: ${file}`) }
    mkdirSync(target, { recursive: true, mode: 0o700 }); for (const file of MODEL_FILES) cpSync(resolve(bundledRoot, WAKE_WORD_MODEL_NAME, file), resolve(target, file))
  }
  if (modelComplete(target)) {
    writeKeywords(target, keywordText)
    return Promise.resolve(target)
  }
  if (!preparations.has(target)) {
    const pending = prepare(target, { fetchImpl })
      .finally(() => preparations.delete(target))
    preparations.set(target, pending)
  }
  return preparations.get(target).then(modelDirectory => {
    writeKeywords(modelDirectory, keywordText)
    return modelDirectory
  })
}
