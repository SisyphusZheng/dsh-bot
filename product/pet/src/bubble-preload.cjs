// 头顶气泡窗口的 preload：只接收主进程发来的气泡内容、回传交互事件，
// 不暴露其它能力。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nisseBubble', {
  // W6：双击气泡 = 与双击桌宠一致，请桌面壳切回/最小化 DSH。
  openDsh: () => ipcRenderer.invoke('nisse:open-dsh'),
  onUpdate: callback => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('nisse-bubble:update', listener)
    return () => ipcRenderer.removeListener('nisse-bubble:update', listener)
  },
  // 审批气泡按钮：是 → allow，否 → reject（主进程转给桌面壳 /bot/approval）。
  answerApproval: (id, decision) => ipcRenderer.send('whale-girl:approval', { id, decision }),
  // 气泡窗口默认点击穿透；指针进入气泡卡片后请求可交互，离开后恢复穿透。
  setInteractive: interactive => ipcRenderer.send(
    'nisse-bubble:set-interactive',
    interactive === true,
  ),
  // 模板控件（引导选项/输入行/取消/关闭）统一回传，主进程按当前流程分发。
  ui: payload => ipcRenderer.send('nisse-bubble:ui', payload && typeof payload === 'object' ? payload : {}),
  // 输入态需要键盘焦点：气泡窗口默认 focusable:false，只有输入时临时可聚焦。
  requestInputFocus: focus => ipcRenderer.send('nisse-bubble:input-focus', focus === true),
  onPreferences: callback => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('nisse-bubble:preferences', listener)
    return () => ipcRenderer.removeListener('nisse-bubble:preferences', listener)
  },
})
