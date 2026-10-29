const {contextBridge,ipcRenderer}=require('electron')
const subscribe=(channel,listener)=>{const handle=(_event,value)=>listener(value);ipcRenderer.on(channel,handle);return ()=>ipcRenderer.removeListener(channel,handle)}
contextBridge.exposeInMainWorld('petBridge',{
 preferences:()=>ipcRenderer.invoke('pet:experience'),onPreferences:listener=>subscribe('pet:preferences',listener),onWake:listener=>subscribe('pet:wake-state',listener),onLifecycle:listener=>subscribe('pet:lifecycle',listener),gesture:phase=>ipcRenderer.invoke('pet:gesture',phase),wakeAudio:(audio,rate)=>ipcRenderer.invoke('pet:wake-audio',audio,rate),
 state:()=>ipcRenderer.invoke('pet:state'),openMain:()=>ipcRenderer.invoke('pet:toggle-main'),
 approve:(id,decision)=>ipcRenderer.invoke('pet:approval',id,decision),cancel:()=>ipcRenderer.invoke('pet:cancel'),queue:()=>ipcRenderer.invoke('pet:queue-open'),voiceStatus:value=>ipcRenderer.invoke('pet:voice-status',value),
 onVoice:listener=>subscribe('pet:voice-state',listener),onAgent:listener=>subscribe('pet:agent-event',listener),
 onPresentation:listener=>subscribe('pet:presentation',listener),onVoiceCommand:listener=>subscribe('pet:voice-command',listener),
 menu:()=>ipcRenderer.invoke('pet:menu'),hit:value=>ipcRenderer.invoke('pet:hit',value),
 dragStart:(x,y)=>ipcRenderer.invoke('pet:drag-start',x,y),dragMove:(x,y)=>ipcRenderer.invoke('pet:drag-move',x,y),dragEnd:()=>ipcRenderer.invoke('pet:drag-end'),
})
