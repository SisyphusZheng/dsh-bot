// 桌宠自己的体验状态（pet userData）：onboarding 断点、语音输入偏好、
// 壳尚未支持的本地兜底字段。权威设置仍在 DSH（壳的 bot/config.json）；
// 这里只存「桌宠侧进度 + 偏好」，不存任何 API Key。
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

export const EXPERIENCE_FILE = 'pet-experience.json'
export const EXPERIENCE_VERSION = 1
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIRECTORY_MODE = 0o700

function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writePrivate(path, value) {
  const directory = resolve(path, '..')
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: PRIVATE_FILE_MODE })
    chmodSync(temporary, PRIVATE_FILE_MODE)
    renameSync(temporary, path)
    chmodSync(path, PRIVATE_FILE_MODE)
  } catch (error) {
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

/**
 * Pet-side experience persistence.
 * @param {{directory: string}} options clientPaths.directory (Electron userData)
 */
export function createExperienceStore({ directory } = {}) {
  const root = String(directory || '').trim()
  if (!root) throw new TypeError('experience store requires a client directory')
  const path = join(resolve(root), EXPERIENCE_FILE)

  function load() {
    const raw = readJson(path)
    return {
      version: EXPERIENCE_VERSION,
      onboarding: raw.onboarding && typeof raw.onboarding === 'object' ? raw.onboarding : null,
      voiceInput: raw.voiceInput && typeof raw.voiceInput === 'object' ? raw.voiceInput : null,
      localConfig: raw.localConfig && typeof raw.localConfig === 'object' ? raw.localConfig : null,
    }
  }

  function save(patch) {
    const next = { ...load(), ...(patch && typeof patch === 'object' ? patch : {}) }
    next.version = EXPERIENCE_VERSION
    writePrivate(path, next)
    return next
  }

  return {
    path,
    load,
    save,
    saveOnboarding(progress) {
      return save({ onboarding: progress && typeof progress === 'object' ? progress : null })
    },
    saveVoiceInput(settings) {
      return save({ voiceInput: settings && typeof settings === 'object' ? settings : null })
    },
    saveLocalConfig(config) {
      return save({ localConfig: config && typeof config === 'object' ? config : null })
    },
    clearOnboarding() {
      return save({ onboarding: null })
    },
  }
}
