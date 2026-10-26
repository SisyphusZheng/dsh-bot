/** Read previous pet preferences; never import credentials or rewrite originals. */
import { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { parseEnv } from 'node:util'
import { validateSkinPackage } from './skin-store.mjs'
const keys = { language: 'QWEN_AUDIO_DESKTOP_LANGUAGE', orbSkin: 'QWEN_AUDIO_ORB_SKIN', autoHideSeconds: 'QWEN_AUDIO_DESKTOP_AUTO_HIDE_SECONDS', wakeShortcut: 'QWEN_AUDIO_DESKTOP_WAKE_SHORTCUT', wakeWordEnabled: 'QWEN_AUDIO_WAKE_WORD_ENABLED', wakeWordPhrase: 'QWEN_AUDIO_WAKE_WORD_PHRASE' }
export function readLegacyPet(root, destination) {
  const read = name => existsSync(join(root, name)) ? JSON.parse(readFileSync(join(root, name), 'utf8')) : {}
  const previous = read('pet-experience.json'), settingsPath = join(root, 'settings.env')
  const env = existsSync(settingsPath) ? parseEnv(readFileSync(settingsPath, 'utf8')) : {}, localConfig = { ...previous.localConfig }
  for (const [key, variable] of Object.entries(keys)) if (env[variable] !== undefined && localConfig[key] === undefined) localConfig[key] = key === 'autoHideSeconds' ? Number(env[variable]) : key === 'wakeWordEnabled' ? /^(1|true)$/i.test(env[variable]) : env[variable]
  const skin = String(localConfig.orbSkin || ''), source = join(root, 'skins', skin)
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(skin) && skin !== 'whale-girl' && existsSync(join(source, 'pet.json'))) {
    const info = validateSkinPackage(source), target = join(destination, 'skins', info.id)
    mkdirSync(dirname(join(target, info.spritesheetPath)), { recursive: true, mode: 0o700 })
    copyFileSync(join(source, 'pet.json'), join(target, 'pet.json')); copyFileSync(join(source, info.spritesheetPath), join(target, info.spritesheetPath))
  }
  const position = read('ui-state.json').orbPosition
  if (position && Number.isFinite(position.x) && Number.isFinite(position.y) && !existsSync(join(destination, 'position.json'))) writeFileSync(join(destination, 'position.json'), JSON.stringify(position), { mode: 0o600 })
  return { ...previous, localConfig }
}
