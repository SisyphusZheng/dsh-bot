/** Pet-owned gestures, onboarding and presentation preferences; Agent/configuration stay in DSH. */
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createExperienceStore } from './experience-store.mjs'
import { normalizeVoiceInput, TALK_KEY_PRESETS, talkKeyHint } from './voice-input.mjs'
import { loadGlobalOptionKeyState, createGlobalOptionWatcher } from './global-option.mjs'
import { startProgress, reduceOnboarding, onboardingView, configEditFromProgress, llmSectionOf, voiceSectionOf } from './onboarding.mjs'
import { DesktopPresence } from './desktop-presence.mjs'
import { desktopTranslator, effectiveDesktopLanguage } from './i18n.mjs'
import { readLegacyPet } from './legacy-preferences.mjs'
import { wakeWordKeywordsLine } from './wake-word/keyword-phrase.mjs'
import { listSkins, importSkin, removeSkin, effectiveOrbSkin, skinAssetPath, extractZipArchive } from './skin-store.mjs'
const defaults = { showDockIcon: true, systemNotifications: true, playbackStyle: 'full', language: 'zh', orbSkin: 'whale-girl', autoHideSeconds: 0, wakeShortcut: 'CommandOrControl+Shift+Space', wakeWordEnabled: false, wakeWordPhrase: '你好小鲸' }
export function createPetExperience(options) {
  const { home, window, emit, show, hide, request, shortcuts, idle = () => 0, dialogs, nativeRequire = createRequire(import.meta.url) } = options
  const directory = join(home, 'pet'), skinsRoot = join(directory, 'skins'); mkdirSync(directory, { recursive: true, mode: 0o700 })
  const store = createExperienceStore({ directory })
  if (!existsSync(store.path)) for (const root of [home, resolve(home, '..', 'Nisse'), resolve(home, '..', 'NissePet'), resolve(home, '..', 'qwen-audio-agent')]) {
    const file = join(root, 'pet-experience.json')
    if ((existsSync(file) || existsSync(join(root, 'settings.env'))) && resolve(file) !== resolve(store.path)) { store.save({ ...readLegacyPet(root, directory), migratedFrom: file }); break }
  }
  const saved = store.load(); let preferences = { ...defaults, ...saved.localConfig }, voice = normalizeVoiceInput(saved.voiceInput)
  let editor, progress = saved.onboarding, busy = false, pending = false, stopped = false, mic = false, opening = false, baseConfig = {}
  const registered = new Set(); let watcher, holdTimer, native = { available: false }, held = false, lastGestureAt = 0
  const translate = text => desktopTranslator(preferences.language, options.systemLanguage || 'zh')(text)
  const presence = new DesktopPresence({ getWindow: () => window, globalShortcut: {} })
  const state = () => ({ ...preferences, language: effectiveDesktopLanguage(preferences.language, options.systemLanguage || 'zh') === 'en' ? 'en' : 'zh', configuredLanguage: preferences.language, orbSkin: effectiveOrbSkin(preferences.orbSkin, { skinsRoot }), voiceInput: voice, globalOption: native.available, hint: talkKeyHint({ settings: voice, globalOption: native }).text, onboarding: !pending && !!progress && !progress.completed && !progress.paused })
  const publish = () => { if (!stopped) emit('preferences', state()) }, persist = () => { store.save({ localConfig: preferences, voiceInput: voice }); publish() }
  const notify = text => options.notice?.(translate(text)), command = (action, source = 'gesture') => { if (!stopped) emit('voice-command', { action, source }) }
  const unregister = () => { watcher?.stop(); watcher = undefined; for (const key of registered) shortcuts?.unregister(key); registered.clear() }
  function register(key, action) { try { if (shortcuts?.register(key, action)) registered.add(key); else if (shortcuts) notify(`快捷键 ${key} 已被占用，请重新选择。`) } catch (error) { notify(error.message) } }
  function rebuildKeys() {
    unregister(); const preset = TALK_KEY_PRESETS.find(item => item.id === voice.keyId)
    if (voice.keyId === 'alt' && native.available) { watcher = createGlobalOptionWatcher({ readPressed: native.readKeyState, onDown: () => gesture('down'), onUp: () => gesture('up'), onError: error => notify(error.message) }); watcher.start() }
    else if (preset?.mouseButton === undefined) register(preset?.accelerator || voice.fallbackAccelerator, () => { if (voice.mode === 'always') command('enable'); else { command('toggle'); if (voice.mode === 'hold') { clearTimeout(holdTimer); holdTimer = setTimeout(() => command('mute'), voice.holdMaxMs) } } })
    register(preferences.wakeShortcut, () => { presence.wake('shortcut'); presence.ready(); emit('lifecycle', { state: 'active' }); render() })
  }
  function gesture(phase) {
    if (stopped || state().onboarding || voice.mode === 'always') return
    if (phase === 'down') { if (held) return; held = true; lastGestureAt = Date.now(); if (voice.mode === 'toggle') { command('toggle'); return }; command('enable') }
    else if (held) { held = false; if (voice.mode === 'hold') { lastGestureAt = Date.now(); command('mute') } }
  }
  const saveProgress = () => store.saveOnboarding(progress)
  function localize(value) { if (Array.isArray(value)) return value.map(localize); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, ['text', 'title', 'label', 'placeholder', 'submitLabel', 'description', 'hint'].includes(key) && typeof item === 'string' ? translate(item) : localize(item)])) }
  function render() { if (stopped || pending || presence.state === 'hidden' || !progress || progress.completed || progress.paused) return; show({ ...localize(onboardingView(progress)), visible: true, requestId: `onboarding:${progress.stepId}`, busy, dismissible: true, clickThrough: false, ...(progress.lastError ? { hint: progress.lastError } : {}) }) }
  async function action(value) {
    if (editor && value?.requestId === `preferences:${editor}`) { if (value.type === 'input') { try { update({ [editor]: value.value }); editor = undefined; hide() } catch (error) { notify(error.message) } } else if (['close', 'cancel'].includes(value.type)) { editor = undefined; hide() }; return true }
    if (!String(value?.requestId || '').startsWith('onboarding:')) return false
    if (busy || !progress || pending || value.requestId !== `onboarding:${progress.stepId}`) return true
    await reduce(['cancel', 'close'].includes(value.type) ? { type: 'close' } : ['choice', 'secondary'].includes(value.type) ? { type: 'choice', id: value.id } : value); return true
  }
  async function reduce(event) {
    if (stopped) return
    const next = reduceOnboarding(progress, event); progress = next.state; saveProgress(); busy = next.effects.length > 0; render()
    try { for (const effect of next.effects) {
      if (effect.type === 'read-config') { const reply = await request('/bot/config'); baseConfig = reply.config || {}; await reduce({ type: 'config-read', config: baseConfig }) }
      else if (effect.type === 'save-config') { const reply = await request('/bot/config', configEditFromProgress(progress, baseConfig), 'PUT'); if (!reply.ok) throw new Error(reply.error?.message || '保存失败'); if (reply.config) baseConfig = reply.config; if (progress.answers.voice.wakeWord && progress.answers.voice.wakeWord !== preferences.wakeWordPhrase) update({ wakeWordPhrase: progress.answers.voice.wakeWord }) }
      else if (effect.type === 'test-llm' || effect.type === 'test-voice') { const target = effect.type === 'test-llm' ? 'llm' : 'voice', section = target === 'llm' ? llmSectionOf(progress) : voiceSectionOf(progress); const reply = await request(`/bot/test/${target}`, { [target]: section }); await reduce({ type: 'test-result', target, result: reply.result || { ok: false, detail: reply.error?.message || '连接失败' } }) }
      else if (effect.type === 'open-dsh-settings') options.openSettings?.()
      else if (effect.type === 'complete') { hide(); publish() }
    } } catch (error) { progress = { ...progress, lastError: error.message, substate: 'failed' }; saveProgress() }
    finally { busy = false; if (progress?.paused) { hide(); publish() } else render() }
    if (progress?.completed) { hide(); publish(); notify('设置好了。想改随时去 DSH 设置 → Bot。') }
  }
  function onboarding(restart = false) { progress = startProgress({ previous: progress, restart }); saveProgress(); publish(); void reduce({ type: 'start' }) }
  function update(patch) {
    if (patch.voiceInput) voice = normalizeVoiceInput({ ...voice, ...patch.voiceInput })
    const next = { ...preferences, ...Object.fromEntries(Object.entries(patch).filter(([key]) => key in defaults)) }
    if (!['zh', 'zh-CN', 'en', 'auto'].includes(next.language)) next.language = defaults.language
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(next.orbSkin))) next.orbSkin = defaults.orbSkin
    next.showDockIcon=next.showDockIcon!==false;next.systemNotifications=next.systemNotifications!==false;next.playbackStyle=next.playbackStyle==='brief'?'brief':'full'
    next.wakeWordEnabled = next.wakeWordEnabled === true; next.wakeWordPhrase = String(next.wakeWordPhrase || defaults.wakeWordPhrase).trim()
    if (patch.wakeWordPhrase !== undefined || next.wakeWordEnabled) wakeWordKeywordsLine(next.wakeWordPhrase)
    next.wakeShortcut = String(next.wakeShortcut || defaults.wakeShortcut).trim(); if (next.wakeShortcut.length > 100 || !next.wakeShortcut.includes('+')) throw new Error('请使用有效的组合快捷键，例如 CommandOrControl+Shift+Space')
    preferences = next; preferences.autoHideSeconds = Math.max(0, Number(preferences.autoHideSeconds) || 0); persist(); rebuildKeys(); options.onPreferences?.(state())
  }
  function editPreference(key) { if (pending) { notify('请先处理当前审批或选择。'); return }; if (progress && !progress.completed) { progress.paused = true; saveProgress() }; editor = key; show({ visible: true, kind: 'input', title: translate(key === 'wakeWordPhrase' ? '唤醒词' : '显示桌宠快捷键'), text: translate(key === 'wakeWordPhrase' ? '说什么来唤醒我？' : '设置全局显示桌宠的组合键'), dismissible: true, requestId: `preferences:${key}`, input: { value: preferences[key], submitLabel: translate('保存') }, clickThrough: false }) }
  function menu() { const label = translate; return [
    { label: label('打开 DSH'), click: options.openMain }, { label: label('Bot 设置…'), click: options.openSettings }, { label: label(mic || opening ? '停止收听' : '开始收听'), click: () => command('toggle', 'menu') },
    { label: label('语音输入'), submenu: [...[['hold', '按住说话'], ['toggle', '按一下切换'], ['always', '一直听']].map(([mode, text]) => ({ label: label(text), type: 'radio', checked: voice.mode === mode, click: () => { update({ voiceInput: { mode } }); if (mode === 'always') command('enable') } })), { type: 'separator' }, ...TALK_KEY_PRESETS.map(key => ({ label: key.label, type: 'radio', checked: voice.keyId === key.id, click: () => update({ voiceInput: { keyId: key.id } }) }))] },
    { label: label('离线语音唤醒'), type: 'checkbox', checked: preferences.wakeWordEnabled, click: () => update({ wakeWordEnabled: !preferences.wakeWordEnabled }) },
    { label: label('设置唤醒词…'), click: () => editPreference('wakeWordPhrase') }, { label: label('显示桌宠快捷键…'), click: () => editPreference('wakeShortcut') },
    { label: label('重新引导（气泡内）'), click: () => onboarding(true) }, { label: label('继续引导（气泡内）'), click: () => onboarding() },
    { label: label('外观'), submenu: [{ label: 'WhaleGirl', type: 'radio', checked: preferences.orbSkin === 'whale-girl', click: () => update({ orbSkin: 'whale-girl' }) }, ...listSkins(skinsRoot).map(skin => ({ label: skin.displayName, type: 'radio', checked: preferences.orbSkin === skin.id, click: () => update({ orbSkin: skin.id }) })), { label: label('导入皮肤…'), click: async () => { try { const file = await dialogs?.pickSkin?.(); if (file) { const skin = await importSkin({ source: file, skinsRoot, extractZip: (zip, dest) => extractZipArchive(zip, dest, nativeRequire('extract-zip')) }); update({ orbSkin: skin.id }) } } catch (error) { notify(error.message) } } }, { label: label('删除所选皮肤'), enabled: preferences.orbSkin !== 'whale-girl', click: () => { removeSkin({ id: preferences.orbSkin, skinsRoot }); update({ orbSkin: 'whale-girl' }) } }] },
    { label: label('语言'), submenu: [['auto', '跟随系统'], ['zh', '中文'], ['en', 'English']].map(([language, text]) => ({ label: text, type: 'radio', checked: preferences.language === language, click: () => update({ language }) })) },
    { label: label('自动休眠'), submenu: [0, 60, 300, 600].map(seconds => ({ label: seconds ? `${seconds / 60} min` : label('永不'), type: 'radio', checked: preferences.autoHideSeconds === seconds, click: () => update({ autoHideSeconds: seconds }) })) },
    { label: label('显示 Dock 图标'), type:'checkbox', checked:preferences.showDockIcon!==false, click:()=>update({showDockIcon:preferences.showDockIcon===false}) },
    { label: label('系统审批/问答通知'), type:'checkbox', checked:preferences.systemNotifications!==false, click:()=>update({systemNotifications:preferences.systemNotifications===false}) },
    { label: label('语音播报长度'), submenu:[['full','完整播报'],['brief','简短播报（约 240 字）']].map(([playbackStyle,title])=>({label:label(title),type:'radio',checked:preferences.playbackStyle===playbackStyle,click:()=>update({playbackStyle})})) },
    { label: label('隐藏桌宠'), click: () => { presence.hide('requested'); hide(); emit('lifecycle', { state: 'hidden' }) } },
    { label: label('导入旧桌宠偏好…'), click: async () => { const file = await dialogs?.pickPreferences?.(); if (!file) return; try { const old = JSON.parse(readFileSync(file, 'utf8')); progress = old.onboarding || progress; saveProgress(); update({ ...old.localConfig, voiceInput: old.voiceInput }) } catch (error) { notify(error.message) } } },
  ] }
  native = loadGlobalOptionKeyState({ requireImpl: nativeRequire, candidates: ['koffi'] }); rebuildKeys()
  const interval = setInterval(() => { if (preferences.autoHideSeconds && !pending && !mic && !state().onboarding && idle() >= preferences.autoHideSeconds && presence.state === 'active') { presence.hide(); hide(); emit('lifecycle', { state: 'hidden' }) } }, 1000); interval.unref?.()
  return { state, menu, update, action, gesture, inputActive: () => held || Date.now() - lastGestureAt < 3000,
    start() { publish(); if (!progress || (!progress.completed && !progress.paused)) onboarding(); if (voice.mode === 'always') command('enable', 'restored-preference') },
    sync(snapshot) { const was = pending; pending = !!snapshot.requests?.length; if (was && !pending) render() },
    voice(status) { mic = status.enabled === true; opening = status.transportPhase === 'connecting'; if (mic && !voice.hintSeen) { voice = normalizeVoiceInput({ ...voice, hintSeen: true }); persist() } },
    wake() { presence.wake('keyword'); presence.ready(); emit('lifecycle', { state: 'active' }); render(); command('enable', 'wake-word') }, skinPath: (id, name) => skinAssetPath(id, name, skinsRoot),
    async stop() { stopped = true; clearInterval(interval); clearTimeout(holdTimer); unregister() },
  }
}
