const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('petBubble', {
  onUpdate(listener) {
    const receive = (_event, value) => listener(value)
    ipcRenderer.on('nisse-bubble:update', receive)
    return () => ipcRenderer.removeListener('nisse-bubble:update', receive)
  },
  action: value => ipcRenderer.invoke('pet:bubble-action', value),
  setInteractive: value => ipcRenderer.invoke('pet:bubble-interactive', value),
  requestInputFocus: value => ipcRenderer.invoke('pet:bubble-focus', value),
  openDsh: () => ipcRenderer.invoke('pet:bubble-open'),
})
