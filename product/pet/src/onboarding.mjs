// Pet-led onboarding（W12）：所有引导都发生在头顶气泡里，绝不打开独立设置窗。
//
// 产品规则：设置归 DSH（壳的 GET/PUT /bot/config + POST /bot/test/*），桌宠只是
// 用气泡把用户的选择收集起来写回壳。因此这里是一个纯状态机：
//   - 步骤/文案/选项全部数据化；
//   - reducer 只产出 { state, effects }，effects 由主进程执行（读/写配置、
//     测试连接、打开 DSH 设置）并按结果回灌 action；
//   - 纯函数便于 node --test；Electron/HTTP 全在 main.mjs。
//
// 断点续：调用方把 normalizeProgress() 后的 state 持久化到 pet userData；
// 首启没有进度文件 → 自动开始；有未完成进度 → 自动续上；已完成不再自动开始，
// 托盘「重新引导」用 startProgress({ restart: true })。

export const ONBOARDING_VERSION = 1

export const DEFAULT_WAKE_WORD = '你好小鲸'

export const PERSONA_PRESETS = Object.freeze([
  Object.freeze({
    id: 'gentle',
    label: '温柔可靠',
    personality: '温柔、可靠、有耐心；像家人一样陪着用户，遇事先接住情绪再解决问题。',
    tone: '温和、清楚、不催促；必要时先给结论。',
  }),
  Object.freeze({
    id: 'sassy',
    label: '毒舌吐槽',
    personality: '嘴硬心软，吐槽精准但不恶意；真正需要帮忙时比谁都靠谱。',
    tone: '短、快、带一点玩笑；绝不拿用户的失败开玩笑。',
  }),
  Object.freeze({
    id: 'energetic',
    label: '元气活泼',
    personality: '元气、热情、好奇心强；喜欢给用户打气，行动力拉满。',
    tone: '轻快、有精神、多短句；不说空话。',
  }),
  Object.freeze({
    id: 'quiet',
    label: '安静省话',
    personality: '安静、克制、专注；不主动打扰，需要时一句话到位。',
    tone: '极简、只说必要信息；不寒暄、不卖萌。',
  }),
])

// 与 apps/desktop/src/bot-providers.ts 的目录保持一致（壳侧还没暴露
// GET /bot/providers，桌宠暂时镜像这份常量；已写进给 Lead 的接线清单）。
export const LLM_PROVIDER_CHOICES = Object.freeze([
  Object.freeze({ id: 'opencode-go', label: 'OpenCode Go（默认）', baseUrl: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4.1-flash' }),
  Object.freeze({ id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }),
  Object.freeze({ id: 'dashscope', label: 'DashScope（通义千问）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' }),
  Object.freeze({ id: 'custom', label: '自定义 OpenAI 兼容', baseUrl: '', model: '', requiresBaseUrl: true }),
])

export const VOICE_PROVIDER_CHOICES = Object.freeze([
  Object.freeze({ id: 'dashscope', label: 'DashScope Qwen Realtime（默认）', baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime', model: 'qwen-audio-3.0-realtime-plus', voice: 'longanxiaoxin' }),
  Object.freeze({ id: 'stepfun', label: 'StepFun Realtime', baseUrl: 'wss://api.stepfun.com/v1/realtime', model: 'stepaudio-3-realtime-preview', voice: '' }),
  Object.freeze({ id: 'doubao-seeduplex', label: '豆包 Seeduplex', baseUrl: 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue', model: '1.2.6.1', voice: 'zh_female_vv_jupiter_bigtts' }),
  Object.freeze({ id: 'local', label: '本地 ASR（设备内识别）', baseUrl: '', model: 'SenseVoiceSmall', voice: '', kind: 'local' }),
])

export const APPROVAL_CHOICES = Object.freeze([
  Object.freeze({ id: 'ask-each', label: '每次都问' }),
  Object.freeze({ id: 'a[REDACTED_KEY]', label: '操作前问' }),
  Object.freeze({ id: 'ask-once', label: '一次 N 分钟' }),
  Object.freeze({ id: 'never-ask', label: '从不问' }),
])

export const APPROVAL_EXPLANATIONS = Object.freeze({
  'ask-each': '每个需要审批的操作都会在气泡里问你「是/否」。最稳。',
  'a[REDACTED_KEY]': '开始一批操作前问一次，之后同类操作不再逐条问。',
  'ask-once': '你允许一次后，N 分钟内同类操作不再问。',
  'never-ask': '不再弹审批气泡，风险操作会直接执行。适合完全信任的时候。',
})

export const STEP_ORDER = Object.freeze([
  'address',
  'persona',
  'llm_provider',
  'llm_key',
  'voice_provider',
  'voice_key',
  'voice_wake',
  'approval',
  'done',
])

const STEP_TITLES = Object.freeze({
  address: '认识一下',
  persona: '我的性格',
  llm_provider: '模型服务',
  llm_key: '模型 Key',
  voice_provider: '语音服务',
  voice_key: '语音 Key',
  voice_wake: '唤醒词',
  approval: '权限',
  done: '好啦',
})

export function emptyAnswers() {
  return {
    addressUser: '',
    persona: { presetId: '', personality: '', tone: '', custom: '' },
    llm: { provider: '', baseUrl: '', model: '', apiKey: '', apiKeySet: false, skipped: false },
    voice: { provider: '', baseUrl: '', model: '', voice: '', wakeWord: '', apiKey: '', apiKeySet: false, skipped: false },
    approval: { mode: 'ask-each', onceMinutes: 30 },
    behavior: { pauseOnInput: true, allowScreenView: true },
  }
}

export function emptyProgress() {
  return {
    version: ONBOARDING_VERSION,
    stepId: 'address',
    substate: '',
    answers: emptyAnswers(),
    completed: false,
    paused: false,
    approvalPersisted: false,
    lastError: '',
    lastTest: null,
    configReadAt: '',
    updatedAt: '',
  }
}

function clampText(value, max = 400) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function isMode(value) {
  return ['ask-each', 'a[REDACTED_KEY]', 'ask-once', 'never-ask'].includes(value)
}

/** Sanitize anything read back from disk / IPC into the current schema. */
export function normalizeProgress(raw) {
  const base = emptyProgress()
  const value = raw && typeof raw === 'object' ? raw : {}
  const answers = value.answers && typeof value.answers === 'object' ? value.answers : {}
  const persona = answers.persona && typeof answers.persona === 'object' ? answers.persona : {}
  const llm = answers.llm && typeof answers.llm === 'object' ? answers.llm : {}
  const voice = answers.voice && typeof answers.voice === 'object' ? answers.voice : {}
  const approval = answers.approval && typeof answers.approval === 'object' ? answers.approval : {}
  const behavior = answers.behavior && typeof answers.behavior === 'object' ? answers.behavior : {}
  const step = STEP_ORDER.includes(String(value.stepId || '')) ? String(value.stepId) : base.stepId
  const substate = ['', 'custom_persona', 'custom_base', 'minutes', 'testing', 'failed'].includes(String(value.substate || ''))
    ? String(value.substate || '')
    : ''
  const lastTest = value.lastTest && typeof value.lastTest === 'object'
    ? {
      target: value.lastTest.target === 'voice' ? 'voice' : 'llm',
      ok: value.lastTest.ok === true,
      detail: clampText(value.lastTest.detail, 200),
      hint: clampText(value.lastTest.hint, 200),
      latencyMs: Math.max(0, Math.floor(Number(value.lastTest.latencyMs) || 0)),
    }
    : null
  const onceMinutes = Math.min(1440, Math.max(1, Math.floor(Number(approval.onceMinutes) || 30)))
  return {
    version: ONBOARDING_VERSION,
    stepId: step,
    substate,
    answers: {
      addressUser: clampText(answers.addressUser, 40),
      persona: {
        presetId: PERSONA_PRESETS.some(preset => preset.id === persona.presetId) ? String(persona.presetId) : '',
        personality: clampText(persona.personality, 400),
        tone: clampText(persona.tone, 400),
        custom: clampText(persona.custom, 400),
      },
      llm: {
        provider: clampText(llm.provider, 40),
        baseUrl: clampText(llm.baseUrl, 300),
        model: clampText(llm.model, 120),
        apiKey: clampText(llm.apiKey, 400),
        apiKeySet: llm.apiKeySet === true,
        skipped: llm.skipped === true,
      },
      voice: {
        provider: clampText(voice.provider, 40),
        baseUrl: clampText(voice.baseUrl, 300),
        model: clampText(voice.model, 120),
        voice: clampText(voice.voice, 80),
        wakeWord: clampText(voice.wakeWord, 40),
        apiKey: clampText(voice.apiKey, 400),
        apiKeySet: voice.apiKeySet === true,
        skipped: voice.skipped === true,
      },
      approval: { mode: isMode(approval.mode) ? approval.mode : 'ask-each', onceMinutes },
      behavior: {
        pauseOnInput: behavior.pauseOnInput !== false,
        allowScreenView: behavior.allowScreenView !== false,
      },
    },
    completed: value.completed === true,
    paused: value.paused === true,
    approvalPersisted: value.approvalPersisted === true,
    lastError: clampText(value.lastError, 300),
    lastTest,
    configReadAt: clampText(value.configReadAt, 40),
    updatedAt: clampText(value.updatedAt, 40),
  }
}

export function startProgress({ restart = false, previous = null } = {}) {
  const previousState = restart ? null : normalizeProgress(previous)
  if (previousState && !previousState.completed) {
    return { ...previousState, paused: false }
  }
  return { ...emptyProgress(), paused: false }
}

function withAnswers(state, mutate) {
  const next = {
    ...state,
    answers: {
      ...state.answers,
      persona: { ...state.answers.persona },
      llm: { ...state.answers.llm },
      voice: { ...state.answers.voice },
      approval: { ...state.answers.approval },
      behavior: { ...state.answers.behavior },
    },
  }
  mutate(next.answers)
  return next
}

function goTo(state, stepId, substate = '') {
  return {
    ...withAnswers(state, () => {}),
    stepId,
    substate,
    lastError: '',
  }
}

function personaAnswerOf(state) {
  const persona = state.answers.persona
  const preset = PERSONA_PRESETS.find(item => item.id === persona.presetId)
  if (preset) return { personality: preset.personality, tone: preset.tone }
  const custom = String(persona.custom || '').trim()
  if (custom) return { personality: custom, tone: custom }
  return { personality: persona.personality || '', tone: persona.tone || '' }
}

export function llmSectionOf(state) {
  const llm = state.answers.llm
  const catalog = LLM_PROVIDER_CHOICES.find(item => item.id === llm.provider)
  const section = {
    provider: llm.provider || catalog?.id || '',
    model: llm.model || catalog?.model || '',
    baseUrl: llm.baseUrl || catalog?.baseUrl || '',
  }
  if (String(llm.apiKey || '').trim()) section.apiKey = llm.apiKey.trim()
  return section
}

export function voiceSectionOf(state) {
  const voice = state.answers.voice
  const catalog = VOICE_PROVIDER_CHOICES.find(item => item.id === voice.provider)
  const section = {
    provider: voice.provider || catalog?.id || '',
    baseUrl: voice.baseUrl || catalog?.baseUrl || '',
    model: voice.model || catalog?.model || '',
    voice: voice.voice || catalog?.voice || '',
    wakeWord: String(voice.wakeWord || '').trim() || DEFAULT_WAKE_WORD,
  }
  if (String(voice.apiKey || '').trim()) section.apiKey = voice.apiKey.trim()
  return section
}

/**
 * Build the full config edit the pet writes through PUT /bot/config.
 *
 * The shell's mergeEdit replaces whole sections, so every section the pet
 * touches is sent complete (falling back to the config view we read at start).
 * `apiKey` is only included when the user typed a new one — an empty value
 * would otherwise keep the stored secret (which the pet never sees).
 */
export function configEditFromProgress(progress, baseConfig = null) {
  const state = normalizeProgress(progress)
  const base = baseConfig && typeof baseConfig === 'object' ? baseConfig : {}
  const persona = personaAnswerOf(state)
  const basePersona = base.persona && typeof base.persona === 'object' ? base.persona : {}
  const edit = {
    persona: {
      ...basePersona,
      addressUser: state.answers.addressUser || basePersona.addressUser || '',
      personality: persona.personality || basePersona.personality || '',
      tone: persona.tone || basePersona.tone || '',
    },
    llm: {
      ...(base.llm && typeof base.llm === 'object' ? { provider: base.llm.provider, model: base.llm.model, baseUrl: base.llm.baseUrl } : {}),
      ...llmSectionOf(state),
    },
    voice: {
      ...(base.voice && typeof base.voice === 'object'
        ? { provider: base.voice.provider, baseUrl: base.voice.baseUrl, model: base.voice.model, voice: base.voice.voice, wakeWord: base.voice.wakeWord }
        : {}),
      ...voiceSectionOf(state),
    },
    approval: { mode: state.answers.approval.mode, onceMinutes: state.answers.approval.onceMinutes },
    behavior: {
      pauseOnInput: state.answers.behavior.pauseOnInput !== false,
      allowScreenView: state.answers.behavior.allowScreenView !== false,
    },
  }
  // 壳当前（task-5 之前）的 normalize() 会丢掉 approval/behavior 两节；
  // 这里显式列出「需要壳补的字段」，供证据与 Lead 接线核对。
  edit.unsupportedUntilShell = ['approval.mode', 'approval.onceMinutes', 'behavior.pauseOnInput', 'behavior.allowScreenView']
  return edit
}

/** Whether the shell config view claims an LLM/voice key is already stored. */
export function seedFromConfig(progress, config) {
  const state = normalizeProgress(progress)
  if (!config || typeof config !== 'object') return state
  return withAnswers(state, answers => {
    const llm = config.llm && typeof config.llm === 'object' ? config.llm : null
    if (llm) {
      answers.llm.provider = answers.llm.provider || String(llm.provider || '')
      answers.llm.model = answers.llm.model || String(llm.model || '')
      answers.llm.baseUrl = answers.llm.baseUrl || String(llm.baseUrl || '')
      answers.llm.apiKeySet = llm.apiKeySet === true || answers.llm.apiKeySet
    }
    const voice = config.voice && typeof config.voice === 'object' ? config.voice : null
    if (voice) {
      answers.voice.provider = answers.voice.provider || String(voice.provider || '')
      answers.voice.baseUrl = answers.voice.baseUrl || String(voice.baseUrl || '')
      answers.voice.model = answers.voice.model || String(voice.model || '')
      answers.voice.voice = answers.voice.voice || String(voice.voice || '')
      answers.voice.wakeWord = answers.voice.wakeWord || String(voice.wakeWord || '')
      answers.voice.apiKeySet = voice.apiKeySet === true || answers.voice.apiKeySet
    }
    const persona = config.persona && typeof config.persona === 'object' ? config.persona : null
    if (persona) {
      answers.addressUser = answers.addressUser || String(persona.addressUser || '')
      answers.persona.personality = answers.persona.personality || String(persona.personality || '')
      answers.persona.tone = answers.persona.tone || String(persona.tone || '')
    }
    const approval = config.approval && typeof config.approval === 'object' ? config.approval : null
    if (approval && isMode(String(approval.mode || ''))) answers.approval.mode = String(approval.mode)
    const behavior = config.behavior && typeof config.behavior === 'object' ? config.behavior : null
    if (behavior) {
      answers.behavior.pauseOnInput = behavior.pauseOnInput !== false
      answers.behavior.allowScreenView = behavior.allowScreenView !== false
    }
  })
}

function choicesOf(list) {
  return Object.freeze(list.map(item => ({ id: item.id, label: item.label })))
}

function personaChoices() {
  return choicesOf(PERSONA_PRESETS)
}

function llmProviderChoices() {
  return choicesOf(LLM_PROVIDER_CHOICES)
}

function voiceProviderChoices() {
  return choicesOf(VOICE_PROVIDER_CHOICES)
}

function approvalChoices() {
  return choicesOf(APPROVAL_CHOICES)
}

function providerLabel(list, id) {
  return list.find(item => item.id === id)?.label || id || ''
}

function stepIndex(stepId) {
  const index = STEP_ORDER.indexOf(stepId)
  return index < 0 ? 0 : index
}

function isSkippable(stepId) {
  return !['done'].includes(stepId)
}

/** The bubble payload for the current step. */
export function onboardingView(progress) {
  const state = normalizeProgress(progress)
  const step = state.stepId
  const index = stepIndex(step)
  const title = STEP_TITLES[step] || '引导'
  const progressLabel = `${Math.min(index + 1, STEP_ORDER.length)}/${STEP_ORDER.length}`
  const base = { kind: 'onboarding', title, progress: progressLabel }
  const secondarySkip = { id: 'skip', label: '跳过' }
  const back = { id: 'back', label: '上一步' }
  const testHint = state.lastTest
    ? (state.lastTest.ok
      ? `✓ 连接成功${state.lastTest.latencyMs ? `（${state.lastTest.latencyMs}ms）` : ''}`
      : `上次没连上：${state.lastTest.hint || state.lastTest.detail || '未知错误'}`)
    : ''
  switch (step) {
    case 'address':
      return {
        ...base,
        text: '你好，我是住在你桌面的鲸鱼娘。先认识一下——我该怎么称呼你？',
        input: { placeholder: '输入称呼，回车或点「好」', submitLabel: '好', value: state.answers.addressUser },
        secondary: [secondarySkip],
      }
    case 'persona':
      if (state.substate === 'custom_persona') {
        return {
          ...base,
          text: '用一句话说说你想要的我：说话风格、脾气、或者像谁。',
          input: { placeholder: '例如：像靠谱的姐姐，说话直但不伤人', submitLabel: '就这个', value: state.answers.persona.custom },
          secondary: [back, secondarySkip],
        }
      }
      return {
        ...base,
        text: '你希望我是什么性格？选一个，或者自己写。',
        choices: personaChoices(),
        secondary: [{ id: 'custom-persona', label: '自己写' }, secondarySkip],
      }
    case 'llm_provider':
      return {
        ...base,
        text: '我思考用的模型服务。你的 Key 会存在 DSH 设置里，我只写不读。',
        hint: state.answers.llm.apiKeySet ? '已有一个保存过的 Key，可直接用或换。' : '',
        choices: llmProviderChoices(),
        secondary: [back, secondarySkip],
      }
    case 'llm_key':
      if (state.substate === 'custom_base') {
        return {
          ...base,
          text: '自定义 OpenAI 兼容服务：先告诉我服务地址（baseUrl）。',
          input: { placeholder: 'https://example.com/v1', submitLabel: '下一步', value: state.answers.llm.baseUrl },
          secondary: [back, secondarySkip],
        }
      }
      if (state.substate === 'testing') {
        return {
          ...base,
          text: `正在测试 ${providerLabel(LLM_PROVIDER_CHOICES, state.answers.llm.provider)} 连接…`,
          hint: '最多等 8 秒。',
        }
      }
      if (state.substate === 'failed') {
        return {
          ...base,
          text: `没连上：${state.lastError || '未知错误'}`,
          hint: 'Key 没错的话，也可以先跳过，之后在 DSH 设置 → Bot 里改。',
          choices: [{ id: 'retry', label: '重试' }, { id: 'skip', label: '跳过' }],
          secondary: [back],
        }
      }
      return {
        ...base,
        text: `把 ${providerLabel(LLM_PROVIDER_CHOICES, state.answers.llm.provider)} 的 API Key 贴给我。`,
        hint: state.answers.llm.apiKeySet ? '已保存过 Key：留空回车 = 沿用旧 Key。' : '没有 Key 也可以先跳过，稍后在 DSH 设置 → Bot 填写。',
        input: { placeholder: state.answers.llm.apiKeySet ? '留空沿用已保存的 Key' : 'sk-…', type: 'password', submitLabel: '测试连接', value: '' },
        secondary: [back, secondarySkip],
      }
    case 'voice_provider':
      return {
        ...base,
        text: '语音前台用哪个服务？选好后填 Key，我会测一下。',
        hint: testHint,
        choices: voiceProviderChoices(),
        secondary: [back, secondarySkip],
      }
    case 'voice_key': {
      const catalog = VOICE_PROVIDER_CHOICES.find(item => item.id === state.answers.voice.provider)
      if (catalog?.kind === 'local') {
        return {
          ...base,
          text: '本地 ASR 不需要 Key，第一次使用会自动下载模型。',
          choices: [{ id: 'voice-local-continue', label: '继续' }],
          secondary: [back, secondarySkip],
        }
      }
      return {
        ...base,
        text: `把 ${providerLabel(VOICE_PROVIDER_CHOICES, state.answers.voice.provider)} 的 API Key 贴给我。`,
        hint: state.answers.voice.apiKeySet ? '已保存过 Key：留空回车 = 沿用旧 Key。' : '',
        input: { placeholder: state.answers.voice.apiKeySet ? '留空沿用已保存的 Key' : 'sk-…', type: 'password', submitLabel: '下一步', value: '' },
        secondary: [back, secondarySkip],
      }
    }
    case 'voice_wake':
      if (state.substate === 'testing') {
        return {
          ...base,
          text: `正在测试 ${providerLabel(VOICE_PROVIDER_CHOICES, state.answers.voice.provider)} 连接…`,
          hint: '最多等 8 秒。',
        }
      }
      if (state.substate === 'failed') {
        return {
          ...base,
          text: `语音服务没连上：${state.lastError || '未知错误'}`,
          hint: '可以先跳过，之后在 DSH 设置 → Bot 里改。',
          choices: [{ id: 'retry', label: '重试' }, { id: 'skip', label: '跳过' }],
          secondary: [back],
        }
      }
      return {
        ...base,
        text: '最后给语音定个唤醒词（留空用默认）。之后在 DSH 设置 → Bot 也能改。',
        input: { placeholder: DEFAULT_WAKE_WORD, submitLabel: '测试语音', value: state.answers.voice.wakeWord },
        secondary: [back, secondarySkip],
      }
    case 'approval':
      if (state.substate === 'minutes') {
        return {
          ...base,
          text: '好，那一次允许管多少分钟？',
          input: { placeholder: '30', submitLabel: '就这个', type: 'number', value: String(state.answers.approval.onceMinutes) },
          secondary: [back],
        }
      }
      return {
        ...base,
        text: '遇到危险操作（比如改工作区外的文件）时，我该怎么问你？',
        hint: APPROVAL_EXPLANATIONS[state.answers.approval.mode] || '',
        choices: approvalChoices(),
        secondary: [back],
      }
    case 'done':
    default:
      return {
        ...base,
        title: '好啦',
        text: '都记好了。以后想改，去 DSH 设置 → Bot；随时可以点托盘「重新引导」再来一遍。',
        hint: testHint,
        choices: [{ id: 'open-settings', label: '打开 DSH 设置' }, { id: 'complete', label: '完成' }],
      }
  }
}

function advance(state) {
  const index = stepIndex(state.stepId)
  const next = STEP_ORDER[Math.min(index + 1, STEP_ORDER.length - 1)]
  return goTo(state, next)
}

function skipToNext(state) {
  if (state.stepId === 'llm_key') {
    return goTo(withAnswers(state, answers => { answers.llm.skipped = true }), 'voice_provider')
  }
  if (state.stepId === 'llm_provider') {
    return goTo(withAnswers(state, answers => { answers.llm.skipped = true }), 'voice_provider')
  }
  if (state.stepId === 'voice_key') {
    return goTo(withAnswers(state, answers => { answers.voice.skipped = true }), 'approval')
  }
  if (state.stepId === 'voice_provider') {
    return goTo(withAnswers(state, answers => { answers.voice.skipped = true }), 'approval')
  }
  if (state.stepId === 'voice_wake') {
    return goTo(withAnswers(state, answers => { answers.voice.skipped = true }), 'approval')
  }
  return advance(state)
}

function goBack(state) {
  const index = stepIndex(state.stepId)
  const previous = STEP_ORDER[Math.max(0, index - 1)]
  if (state.stepId === 'llm_key') return goTo(state, 'llm_provider')
  if (state.stepId === 'voice_key' || state.stepId === 'voice_wake') return goTo(state, 'voice_provider')
  return goTo(state, previous)
}

function setFailed(state, message) {
  return {
    ...state,
    substate: 'failed',
    lastError: String(message || '未知错误').slice(0, 300),
  }
}

/**
 * Apply one user/system action.
 *
 * @param {object} progress persisted state
 * @param {object} action { type, id?, value?, result? }
 * @returns {{state: object, effects: object[], view: object}}
 */
export function reduceOnboarding(progress, action) {
  const state = normalizeProgress(progress)
  const effects = []
  const type = String(action?.type || '')
  const id = String(action?.id || '')
  const value = typeof action?.value === 'string' ? action.value : ''
  const finish = nextState => ({
    state: { ...nextState, updatedAt: new Date().toISOString() },
    effects,
    view: onboardingView(nextState),
  })

  switch (type) {
    case 'start':
      effects.push({ type: 'read-config' })
      return { state, effects, view: onboardingView(state) }

    case 'config-read': {
      const seeded = seedFromConfig(state, action.config)
      const configReadAt = new Date().toISOString()
      return finish({ ...seeded, configReadAt, paused: false })
    }

    case 'input': {
      if (state.stepId === 'address') {
        const name = value.trim().slice(0, 40)
        if (!name) return { state, effects, view: onboardingView(state) }
        const next = withAnswers(state, answers => { answers.addressUser = name })
        effects.push({ type: 'save-config' })
        return finish(advance(next))
      }
      if (state.stepId === 'persona' && state.substate === 'custom_persona') {
        const custom = value.trim().slice(0, 400)
        if (!custom) return { state, effects, view: onboardingView(state) }
        const next = withAnswers(state, answers => {
          answers.persona = { presetId: '', personality: custom, tone: custom, custom }
        })
        effects.push({ type: 'save-config' })
        return finish(goTo(next, 'llm_provider'))
      }
      if (state.stepId === 'llm_key' && state.substate === 'custom_base') {
        const url = value.trim().slice(0, 300)
        const next = withAnswers(state, answers => {
          answers.llm.baseUrl = url
          answers.llm.provider = 'custom'
          answers.llm.model = answers.llm.model || ''
        })
        return finish(goTo(next, 'llm_key'))
      }
      if (state.stepId === 'llm_key' && state.substate !== 'testing') {
        const key = value.trim()
        const next = withAnswers(state, answers => {
          if (key) {
            answers.llm.apiKey = key
            answers.llm.apiKeySet = true
          }
          answers.llm.skipped = false
        })
        effects.push({ type: 'save-config' })
        effects.push({ type: 'test-llm' })
        return finish({ ...next, substate: 'testing', lastError: '', lastTest: null })
      }
      if (state.stepId === 'voice_key') {
        const key = value.trim()
        const selected = state.answers.voice.provider
        const catalog = VOICE_PROVIDER_CHOICES.find(item => item.id === selected)
        const next = withAnswers(state, answers => {
          if (key) {
            answers.voice.apiKey = key
            answers.voice.apiKeySet = true
          }
          answers.voice.skipped = false
        })
        effects.push({ type: 'save-config' })
        if (catalog?.kind === 'local') {
          return finish(goTo(next, 'voice_wake'))
        }
        return finish(goTo(next, 'voice_wake'))
      }
      if (state.stepId === 'voice_wake') {
        const wakeWord = value.trim().slice(0, 40) || DEFAULT_WAKE_WORD
        const next = withAnswers(state, answers => { answers.voice.wakeWord = wakeWord })
        effects.push({ type: 'save-config' })
        effects.push({ type: 'test-voice' })
        return finish({ ...next, substate: 'testing', lastError: '', lastTest: null })
      }
      if (state.stepId === 'approval' && state.substate === 'minutes') {
        const parsed = Number(value)
        const minutes = Number.isFinite(parsed)
          ? Math.min(1440, Math.max(1, Math.floor(parsed)))
          : 30
        const next = withAnswers(state, answers => {
          answers.approval = { mode: 'ask-once', onceMinutes: minutes }
        })
        effects.push({ type: 'save-config' })
        return finish(goTo(next, 'done'))
      }
      return { state, effects, view: onboardingView(state) }
    }

    case 'choice': {
      if (id === 'skip') {
        const next = skipToNext(state)
        effects.push({ type: 'save-config' })
        return finish(next)
      }
      if (id === 'back') return finish(goBack(state))
      if (id === 'retry') {
        return finish({
          ...state,
          substate: 'testing',
          lastError: '',
          lastTest: null,
        })
      }
      if (state.stepId === 'persona') {
        if (id === 'custom-persona') return finish({ ...state, substate: 'custom_persona' })
        const preset = PERSONA_PRESETS.find(item => item.id === id)
        if (!preset) return { state, effects, view: onboardingView(state) }
        const next = withAnswers(state, answers => {
          answers.persona = { presetId: preset.id, personality: preset.personality, tone: preset.tone, custom: '' }
        })
        effects.push({ type: 'save-config' })
        return finish(goTo(next, 'llm_provider'))
      }
      if (state.stepId === 'llm_provider') {
        const provider = LLM_PROVIDER_CHOICES.find(item => item.id === id)
        if (!provider) return { state, effects, view: onboardingView(state) }
        const next = withAnswers(state, answers => {
          answers.llm.provider = provider.id
          answers.llm.baseUrl = provider.baseUrl
          answers.llm.model = provider.model
          answers.llm.skipped = false
        })
        return finish(goTo(next, 'llm_key', provider.requiresBaseUrl ? 'custom_base' : ''))
      }
      if (state.stepId === 'voice_provider') {
        const provider = VOICE_PROVIDER_CHOICES.find(item => item.id === id)
        if (!provider) return { state, effects, view: onboardingView(state) }
        const next = withAnswers(state, answers => {
          answers.voice.provider = provider.id
          answers.voice.baseUrl = provider.baseUrl
          answers.voice.model = provider.model
          answers.voice.voice = provider.voice
          answers.voice.skipped = false
        })
        return finish(goTo(next, 'voice_key'))
      }
      if (state.stepId === 'voice_key' && id === 'voice-local-continue') {
        effects.push({ type: 'save-config' })
        return finish(goTo(state, 'voice_wake'))
      }
      if (state.stepId === 'approval') {
        if (id === 'ask-once') return finish({ ...state, substate: 'minutes' })
        if (!isMode(id)) return { state, effects, view: onboardingView(state) }
        const next = withAnswers(state, answers => {
          answers.approval = { mode: id, onceMinutes: answers.approval.onceMinutes || 30 }
        })
        effects.push({ type: 'save-config' })
        return finish(goTo(next, 'done'))
      }
      if (state.stepId === 'done') {
        if (id === 'open-settings') effects.push({ type: 'open-dsh-settings' })
        if (id === 'open-settings' || id === 'complete') {
          effects.push({ type: 'save-config' })
          effects.push({ type: 'complete' })
          return finish({ ...state, completed: true, paused: false, stepId: 'done' })
        }
        return { state, effects, view: onboardingView(state) }
      }
      return { state, effects, view: onboardingView(state) }
    }

    case 'test-result': {
      const target = action.target === 'voice' ? 'voice' : 'llm'
      const result = action.result && typeof action.result === 'object' ? action.result : { ok: false, detail: '测试失败' }
      const lastTest = {
        target,
        ok: result.ok === true,
        detail: String(result.detail || '').slice(0, 200),
        hint: String(result.hint || '').slice(0, 200),
        latencyMs: Math.max(0, Math.floor(Number(result.latencyMs) || 0)),
      }
      if (target === 'llm') {
        if (lastTest.ok) {
          const next = goTo(state, 'voice_provider')
          return finish({ ...next, lastTest })
        }
        return finish(setFailed({ ...state, lastTest }, lastTest.hint || lastTest.detail || '测试失败'))
      }
      if (lastTest.ok) {
        const next = goTo(state, 'approval')
        return finish({ ...next, lastTest })
      }
      const provider = VOICE_PROVIDER_CHOICES.find(item => item.id === state.answers.voice.provider)
      if (provider?.kind === 'local' || result.error === 'LOCAL_PROVIDER') {
        const next = goTo(state, 'approval')
        return finish({ ...next, lastTest: { ...lastTest, ok: true, detail: '本地 ASR 无需联网测试' } })
      }
      return finish(setFailed({ ...state, lastTest }, lastTest.hint || lastTest.detail || '测试失败'))
    }

    case 'save-result':
      if (action.ok === false) {
        return finish({ ...state, lastError: `保存设置失败：${String(action.error || '').slice(0, 160)}` })
      }
      return finish({ ...state, lastError: '' })

    case 'close':
      return finish({ ...state, paused: true })

    case 'reset':
      return finish(emptyProgress())

    default:
      return { state, effects, view: onboardingView(state) }
  }
}

/** Progress labels for the injected tray/menu text. */
export function onboardingResumeLabel(progress) {
  const state = normalizeProgress(progress)
  if (state.completed) return '重新引导'
  return state.paused ? '继续引导' : '重新引导'
}

/** Whether first launch should auto-start the flow. */
export function shouldAutoStart(progress) {
  const state = progress ? normalizeProgress(progress) : null
  if (!state) return true
  if (state.completed) return false
  return !state.paused
}

/** Is this step waiting on an async shell round-trip? */
export function isBusy(progress) {
  const state = normalizeProgress(progress)
  return state.substate === 'testing'
}
