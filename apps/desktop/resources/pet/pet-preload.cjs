const {contextBridge,ipcRenderer}=require('electron')
const subscribe=(channel,listener)=>{const handle=(_event,value)=>listener(value);ipcRenderer.on(channel,handle);return ()=>ipcRenderer.removeListener(channel,handle)}
contextBridge.exposeInMainWorld('petBridge',{
 state:()=>ipcRenderer.invoke('pet:state'),openMain:()=>ipcRenderer.invoke('pet:toggle-main'),
 approve:(id,decision)=>ipcRenderer.invoke('pet:approval',id,decision),cancel:()=>ipcRenderer.invoke('pet:cancel'),voiceStatus:value=>ipcRenderer.invoke('pet:voice-status',value),
 onVoice:listener=>subscribe('pet:voice-state',listener),onAgent:listener=>subscribe('pet:agent-event',listener),
 dragStart:(x,y)=>ipcRenderer.invoke('pet:drag-start',x,y),dragMove:(x,y)=>ipcRenderer.invoke('pet:drag-move',x,y),dragEnd:()=>ipcRenderer.invoke('pet:drag-end'),
})
