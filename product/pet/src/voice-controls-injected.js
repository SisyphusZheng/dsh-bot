// 注入到 orb 渲染层的小控制器（纯 DOM，无模块系统；主进程用
// webContents.executeJavaScript 注入）。
//
// 为什么不改 web/dist 打包产物：Body Runtime 只允许 m3/pet 侧改动，渲染层是
// 上游 qwen 的构建产物（只读参考）。注入层复用渲染层已有的「悬停麦克风按钮」
// 和它自己的 voice 状态机：
//   - 说话键：koffi 全局 Option 轮询 / 全局组合键由主进程触发（onTalkKey）；
//     桌宠聚焦时监听真实 keydown/keyup；鼠标侧键在悬停桌宠时监听；
//   - 点麦克风 = 明确 toggle：渲染层自己的 onClick 已经实现「第一次开、第二次
//     关并发送」；注入层绝不在 mouseup 时停止/取消，取消只走气泡「取消」；
//   - 所有动作最终 = 点击渲染层麦克风按钮（不新增会话、不新增独立 UI）；
//   - 底部提示徽章不再常驻：首次使用前显示一次 / hover 时短暂显示 / 开始说话
//     立即隐藏。文案来自主进程计算的“实际生效按键”（koffi 可用=Option，
//     不可用=Alt+Space）。
//
// 注入是幂等的：window.__nisseVoiceControlsInstalled 守卫。

;(() => {
  if (window.__nisseVoiceControlsInstalled) {
    window.__nisseVoiceControls?.updateConfig?.(window.__nisseVoiceConfig || {})
    return
  }
  const config = window.__nisseVoiceConfig || {}
  const state = {
    enabled: false,
    waiting: false,
    lastPhase: '',
    reports: 0,
    actions: [],
    applied: 0,
    // round2：提示显隐 / 点击 toggle 诊断
    hintVisible: false,
    hintShows: 0,
    lastHintReason: '',
    hintConsumed: config.hintOnce === false,
    firstRunVisible: false,
    firstRunShown: false,
    clickCount: 0,
    enabledBy: '',
    blocked: '',
    programmaticClick: false,
    pendingUserClick: false,
    lastToggleIntentAt: 0,
    debugLog: [],
  }

  function dbg(entry) {
    state.debugLog.push(`${Date.now() % 100000}:${entry}`)
    if (state.debugLog.length > 40) state.debugLog.shift()
  }
  let micButton = null
  let badge = null
  let observer = null
  let installTimer = null
  let hintHideTimer = null
  let hoverInside = false
  let lastHoldDown = false

  const KEY_LABELS = {
    Alt: 'Option/Alt',
    'Alt+Space': 'Alt+Space',
    'Control+Shift+Space': 'Ctrl+Shift+Space',
  }

  function styleBadge() {
    if (!badge) return
    Object.assign(badge.style, {
      position: 'fixed',
      left: '0',
      right: '0',
      bottom: '6px',
      marginLeft: 'auto',
      marginRight: 'auto',
      width: 'fit-content',
      boxSizing: 'border-box',
      maxWidth: '92%',
      padding: '3px 9px',
      borderRadius: '10px',
      background: 'rgba(23,23,29,.72)',
      color: '#f0f1f6',
      fontFamily: '-apple-system, "PingFang SC", sans-serif',
      fontSize: '10.5px',
      lineHeight: '15px',
      fontWeight: '400',
      whiteSpace: 'normal',
      textAlign: 'center',
      wordBreak: 'break-word',
      overflow: 'hidden',
      pointerEvents: 'none',
      zIndex: '2147483646',
      opacity: '0',
      display: 'none',
      transition: 'opacity .18s ease, background .18s ease',
    })
  }

  function styleMicButton(listening) {
    if (!micButton) return
    micButton.style.color = listening ? '#4ade80' : ''
    micButton.style.filter = listening ? 'drop-shadow(0 0 3px rgba(74,222,128,.55))' : ''
  }

  function findMicButton() {
    const nav = document.querySelector('.desktop-orb-controls')
    if (!nav) return null
    const buttons = [...nav.querySelectorAll('button')]
    return buttons.find(button => {
      const label = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`
      if (/麦克风|mic|listening|voice|语音/i.test(label) && !/对话|设置|退出|收起|任务/i.test(label)) return true
      const svg = button.querySelector('svg')
      return Boolean(svg && svg.querySelector('rect') && svg.querySelectorAll('path').length >= 2)
    }) || buttons[0] || null
  }

  function detectState() {
    if (!micButton) return { enabled: false, waiting: false }
    const label = `${micButton.getAttribute('aria-label') || ''} ${micButton.getAttribute('title') || ''}`
    const svg = micButton.querySelector('svg')
    const paths = svg ? svg.querySelectorAll('path').length : 0
    const rect = svg ? Boolean(svg.querySelector('rect')) : false
    const waiting = /取消等待|等待语音|cancel waiting/i.test(label)
    let enabled
    if (/静音|mute/i.test(label)) enabled = true
    else if (/开启|start|取消等待|cancel/i.test(label)) enabled = false
    else if (rect) enabled = paths <= 2
    else enabled = false
    return { enabled: enabled && !waiting, waiting }
  }

  function hintText() {
    if (state.blocked) {
      const blocked = state.blocked
      state.blocked = ''
      return blocked === 'missing_key'
        ? '语音未配置：去 DSH 设置 → Bot 填 API Key'
        : '语音未就绪：去 DSH 设置 → Bot 检查语音服务'
    }
    const mode = detectMode()
    if (state.waiting) return '等待语音抢占…'
    if (state.enabled) {
      if (state.enabledBy === 'click') return '🎙️ 正在听，再点一下麦克风结束'
      return mode === 'hold' ? '🎙️ 正在听，松开结束' : '🎙️ 正在听，再按一下结束'
    }
    if (typeof config.hintText === 'string' && config.hintText) return config.hintText
    // 主进程没给 hint 时的兼容兜底（旧配置）
    const key = KEY_LABELS[config.rendererKey] || config.displayKey || config.rendererKey || '说话键'
    return mode === 'hold' ? `按住 ${key} 说话` : `按 ${key} 说话`
  }

  function showHint({ reason = 'hover', autoHideMs = 0 } = {}) {
    if (!badge) return
    dbg('show:' + reason + ':' + autoHideMs)
    clearTimeout(hintHideTimer)
    badge.textContent = hintText()
    badge.style.display = 'block'
    // 强制 reflow 后恢复 opacity，避免 display 切换吞掉过渡。
    void badge.offsetWidth
    badge.style.opacity = '0.95'
    state.hintVisible = true
    state.hintShows += 1
    state.lastHintReason = reason
    if (reason === 'first-run') {
      state.firstRunVisible = true
      state.firstRunShown = true
    }
    if (autoHideMs > 0) {
      hintHideTimer = setTimeout(() => hideHint(), autoHideMs)
    }
  }

  function hideHint(delayMs = 0) {
    if (!badge) return
    dbg('hide:' + delayMs + ':en=' + (state.enabled ? 1 : 0))
    clearTimeout(hintHideTimer)
    const apply = () => {
      state.firstRunVisible = false
      badge.style.opacity = '0'
      hintHideTimer = setTimeout(() => {
        if (badge) badge.style.display = 'none'
        state.hintVisible = false
      }, 220)
    }
    if (delayMs > 0) hintHideTimer = setTimeout(apply, delayMs)
    else apply()
    state.hintVisible = false
  }

  function markHintUsed() {
    if (state.hintConsumed) return
    state.hintConsumed = true
    hideHint()
  }

  function sendVoiceState() {
    state.reports += 1
    updateBadge()
    try {
      window.qwenAudioAgentDesktop?.reportVoiceState?.({
        enabled: state.enabled,
        waiting: state.waiting,
        mode: detectMode(),
        reports: state.reports,
        dryRun: config.dryRun === true,
        hintSeen: state.hintConsumed === true,
        hintVisible: state.hintVisible === true,
        hintShows: state.hintShows,
        clickCount: state.clickCount,
        enabledBy: state.enabledBy,
      })
    } catch (error) { /* 主进程不在也不影响渲染 */ }
  }

  function afterStateSettled(previousEnabled) {
    if (state.enabled && !previousEnabled) {
      // 第一次真正开始说话：提示立即消失并持久化「已看过」。
      markHintUsed()
      state.enabledBy = state.enabledBy || 'programmatic'
    }
    if (!state.enabled) state.enabledBy = ''
    updateBadge()
  }

  function report() {
    dbg('report:d=' + (config.dryRun === true ? 1 : 0) + ':en=' + (state.enabled ? 1 : 0))
    if (config.dryRun === true) {
      // smoke dry-run：注入层自己维护模拟的开关状态，真实按钮永远是静音；
      // 这里不能再把模拟态覆盖回真实态（updateBadge 会改 mic class 触发本函数）。
      sendVoiceState()
      return
    }
    const previousEnabled = state.enabled
    if (window.__wgVoice) {
      const vs = window.__wgVoice.state || {}
      state.enabled = Boolean(vs.connected)
      state.waiting = vs.status === 'connecting'
    } else {
      const detected = detectState()
      state.enabled = detected.enabled
      state.waiting = detected.waiting
    }
    if (state.enabled && !previousEnabled && state.pendingUserClick) {
      // 用户直接点了麦克风按钮（renderer 自己 toggle）：标记来源 click，
      // 这样按住语义的 mouseup/keyup 不会误关。
      state.enabledBy = 'click'
      state.pendingUserClick = false
    }
    afterStateSettled(previousEnabled)
    sendVoiceState()
  }

  function detectMode() {
    return (window.__nisseVoiceConfig && window.__nisseVoiceConfig.mode) || 'hold'
  }

  async function applyAction(action, source = 'programmatic') {
    if (action !== 'enable' && action !== 'disable') return
    dbg('apply:' + action + ':' + source)
    // Pipecat product mode: the injected client owns transport/mic; do not click
    // the legacy renderer's microphone button or call the legacy gateway check.
    if (window.__wgVoice && typeof window.__wgVoice.connect === 'function') {
      state.actions.push({ action, source, at: Date.now() })
      if (state.actions.length > 40) state.actions.shift()
      if (action === 'enable') {
        markHintUsed()
        state.enabled = true
        state.waiting = window.__wgVoice.state?.status === 'connecting'
        state.enabledBy = source
        state.applied += 1
        sendVoiceState()
        try {
          await window.__wgVoice.connect()
          state.enabled = Boolean(window.__wgVoice.state?.connected)
          state.waiting = false
        } catch (error) {
          state.enabled = false
          state.waiting = false
          state.blocked = 'pipecat-connect'
        }
      } else {
        state.applied += 1
        state.enabled = false
        state.waiting = false
        state.enabledBy = ''
        try { await window.__wgVoice.disconnect() } catch {}
      }
      sendVoiceState()
      report()
      return
    }
    if (source === 'click') {
      state.lastToggleIntentAt = Date.now()
      state.pendingUserClick = true
    }
    state.actions.push({ action, source, at: Date.now() })
    if (state.actions.length > 40) state.actions.shift()
    const detected = detectState()
    state.enabled = detected.enabled
    state.waiting = detected.waiting
    if (action === 'enable' && !detected.enabled) {
      // 先问主进程语音是否可用；不可用时主进程会显示错误气泡，这里不开麦。
      if (typeof window.qwenAudioAgentDesktop?.checkVoiceReady === 'function') {
        try {
          const ready = await window.qwenAudioAgentDesktop.checkVoiceReady()
          if (!ready || ready.ok !== true) {
            state.blocked = (ready && ready.kind) || 'not-ready'
            updateBadge()
            return
          }
        } catch (error) { /* 主进程不在：继续按渲染层自身状态处理 */ }
      }
      if (config.dryRun === true) {
        // smoke 用：只验证「主进程→preload→注入层」链路，不去申请真实麦克风
        // （TCC 属用户真机验收，evidence 标 UNVERIFIED）。
        state.applied += 1
        state.enabled = true
        state.waiting = false
        state.enabledBy = source
        markHintUsed()
        sendVoiceState()
        return
      }
      state.programmaticClick = true
      micButton?.click()
      state.programmaticClick = false
      state.applied += 1
      state.enabledBy = source
      setTimeout(report, 160)
      setTimeout(report, 700)
      return
    }
    if (action === 'disable' && (detected.enabled || detected.waiting)) {
      if (config.dryRun === true) {
        state.applied += 1
        state.enabled = false
        state.waiting = false
        state.enabledBy = ''
        sendVoiceState()
        return
      }
      state.programmaticClick = true
      micButton?.click()
      state.programmaticClick = false
      state.applied += 1
      setTimeout(report, 160)
      setTimeout(report, 700)
      return
    }
    report()
  }

  function onPhase(phase) {
    dbg('phase:' + phase)
    state.lastPhase = String(phase || '')
    const mode = detectMode()
    // dry-run（smoke）下渲染层按钮永远是静音，不能拿真实按钮覆盖模拟状态。
    const detected = config.dryRun === true
      ? { enabled: state.enabled, waiting: state.waiting }
      : detectState()
    state.enabled = detected.enabled
    state.waiting = detected.waiting
    if (mode === 'always') {
      if (!detected.enabled && phase === 'global') applyAction('enable', 'global')
      updateBadge()
      return
    }
    if (phase === 'global' || phase === 'auto-stop') {
      if (phase === 'auto-stop') {
        applyAction('disable', 'global')
        return
      }
      if (detected.enabled || detected.waiting) applyAction('disable', 'global')
      else applyAction('enable', 'global')
      return
    }
    if (phase === 'down') {
      lastHoldDown = true
      if (mode === 'hold') {
        if (!detected.enabled && !detected.waiting) applyAction('enable', 'key')
      } else if (mode === 'toggle') {
        applyAction(detected.enabled || detected.waiting ? 'disable' : 'enable', 'key')
      }
      return
    }
    if (phase === 'up') {
      lastHoldDown = false
      // 只有真实的按住/松开（键盘 keyup / FFI Option 松开 / 侧键松开）才会停；
      // 鼠标左键 click 麦克风不经过这里，且点击后 1.2s 内的 up 一律忽略。
      const recentClick = Date.now() - (state.lastToggleIntentAt || 0) < 1_200
      if (
        mode === 'hold'
        && state.enabledBy !== 'click'
        && state.enabledBy !== 'toggle'
        && !recentClick
      ) {
        applyAction('disable', 'key')
      }
      return
    }
    updateBadge()
  }

  function keyMatches(event) {
    const mode = detectMode()
    const key = config.rendererKey
    if (mode === 'always' || !key) return false
    if (key === 'Alt') return event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight'
    return event.key === key
  }

  function mouseMatches(event) {
    const button = Number(config.mouseButton)
    return Number.isInteger(button) && event.button === button
  }

  function onKeyDown(event) {
    if (!keyMatches(event) || event.repeat) return
    event.preventDefault()
    onPhase('down')
  }
  function onKeyUp(event) {
    if (!keyMatches(event)) return
    onPhase('up')
  }
  function onPointerDown(event) {
    if (mouseMatches(event)) {
      event.preventDefault()
      onPhase('down')
    }
  }
  // round2 明确语义：鼠标松开绝不取消/停止（mic click 是 toggle）。
  // 只有用户配置的鼠标侧键（按住侧键说话）在松开时结束。
  function onPointerUp(event) {
    if (mouseMatches(event)) onPhase('up')
  }

  function updateBadge() {
    if (!badge) return
    if (badge.style.display !== 'none') badge.textContent = hintText()
    const listening = state.enabled
    const waiting = state.waiting
    badge.dataset.listening = listening ? '1' : '0'
    badge.dataset.waiting = waiting ? '1' : '0'
    badge.style.background = waiting
      ? 'rgba(161,98,7,.85)'
      : listening ? 'rgba(21,128,61,.85)' : 'rgba(23,23,29,.72)'
    styleMicButton(listening)
  }

  function attach() {
    micButton = findMicButton()
    if (!micButton) return false
    if (!badge) {
      badge = document.createElement('div')
      badge.className = 'nisse-voice-badge'
      badge.setAttribute('aria-hidden', 'true')
      // 注意：orb 渲染层的容器带 transform，`position:fixed` 会被限制在该
      // 容器的 containing block 里（宽度=orb 宽度，文字被截断）。挂到
      // documentElement 上，fixed 才真正相对窗口居中。
      document.documentElement.appendChild(badge)
      styleBadge()
    }
    observer = new MutationObserver(() => report())
    observer.observe(micButton, { attributes: true, attributeFilter: ['class', 'aria-label', 'title'] })
    // 渲染层麦克风按钮自己的 onClick 就是 toggle（第一次开、第二次关并发送）。
    // 这里只记录点击：绝不在 click/mouseup 里做取消。
    if (!micButton.dataset.nisseClickBound) {
      micButton.dataset.nisseClickBound = '1'
      micButton.addEventListener('click', () => {
        if (state.programmaticClick) return
        dbg('mic-click')
        state.clickCount += 1
        state.lastClickAt = Date.now()
        state.pendingUserClick = true
        state.lastToggleIntentAt = Date.now()
        // 下一次状态轮询报告会带上 enabled/clickCount；renderer 自己负责开关。
        setTimeout(report, 60)
        setTimeout(report, 400)
      }, false)
    }
    report()
    updateBadge()
    // 首次使用前显示一次（用户开始说话/点击麦克风后自动隐藏并持久化）。
    if (state.hintConsumed === false && state.firstRunShown === false) {
      showHint({
        reason: 'first-run',
        autoHideMs: Number(config.hintOnceMs) > 0 ? Number(config.hintOnceMs) : 5_000,
      })
    }
    return true
  }

  // hover 桌宠/麦克风按钮时短暂显示提示；离开后收起。
  document.addEventListener('pointerover', event => {
    const target = event && event.target
    if (!target || typeof target.closest !== 'function') return
    if (!target.closest('.desktop-orb-stage')) return
    hoverInside = true
    dbg('hover-in:first=' + (state.firstRunVisible ? 1 : 0) + ':consumed=' + (state.hintConsumed ? 1 : 0) + ':en=' + (state.enabled ? 1 : 0))
    if (state.firstRunVisible) return // 首启提示正在显示，不重复
    if (state.enabled || state.waiting) return
    showHint({ reason: 'hover', autoHideMs: Number(config.hintHoverMs) > 0 ? Number(config.hintHoverMs) : 3_000 })
  }, true)
  document.addEventListener('pointerout', event => {
    const target = event && event.target
    if (!target || typeof target.closest !== 'function') return
    if (!target.closest('.desktop-orb-stage')) return
    const related = event.relatedTarget
    if (related && typeof related.closest === 'function' && related.closest('.desktop-orb-stage')) return
    hoverInside = false
    dbg('hover-out:first=' + (state.firstRunVisible ? 1 : 0))
    if (state.firstRunVisible) return
    hideHint(400)
  }, true)

  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('keyup', onKeyUp, true)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('pointerup', onPointerUp, true)
  window.addEventListener('blur', () => {
    dbg('window-blur')
    // 只有真实的按住路径（键盘/FFI/侧键）在失焦时兜底松开；点击 toggle 不受影响。
    if (lastHoldDown && detectMode() === 'hold' && (state.enabledBy === 'key' || state.enabledBy === 'global')) {
      lastHoldDown = false
      applyAction('disable', 'key')
    }
  })

  try {
    window.qwenAudioAgentDesktop?.onTalkKey?.((payload) => {
      if (payload && payload.phase) onPhase(payload.phase)
    })
    window.qwenAudioAgentDesktop?.onVoiceCommand?.((payload) => {
      if (!payload) return
      if (payload.action === 'enable') applyAction('enable', payload.source || 'programmatic')
      if (payload.action === 'disable') applyAction('disable', payload.source || 'programmatic')
      if (payload.action === 'cancel') applyAction('disable', 'cancel')
      if (payload.action === 'refresh') report()
    })
  } catch (error) { /* preload 不可用时其余功能仍可用 */ }

  let attempts = 0
  installTimer = setInterval(() => {
    attempts += 1
    if (attach() || attempts > 120) {
      clearInterval(installTimer)
      installTimer = null
    }
  }, 250)
  attach()

  window.__nisseVoiceControlsInstalled = true
  window.__nisseVoice = {
    state: () => ({
      enabled: state.enabled,
      waiting: state.waiting,
      mode: detectMode(),
      reports: state.reports,
      applied: state.applied,
      actions: state.actions.slice(-10),
      lastPhase: state.lastPhase,
      hasButton: Boolean(micButton),
      badge: badge ? badge.textContent : '',
      dryRun: config.dryRun === true,
      detected: detectState(),
      debugLog: state.debugLog.slice(-40),
      hintText: hintText(),
      hintVisible: state.hintVisible === true,
      hintShows: state.hintShows,
      hintConsumed: state.hintConsumed === true,
      hintReason: state.lastHintReason || '',
      clickCount: state.clickCount,
      enabledBy: state.enabledBy,
    }),
    updateConfig: next => {
      dbg('config:' + JSON.stringify(next || {}).slice(0, 120))
      Object.assign(config, next || {})
      report()
    },
    debugLog: () => state.debugLog.slice(-30),
    onPhase,
    applyAction,
    showHintForTest: options => showHint(options || {}),
    hideHintForTest: () => hideHint(),
  }
  window.__nisseVoiceControls = window.__nisseVoice
})()
