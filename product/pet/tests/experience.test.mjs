import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPetExperience } from '../src/experience-runtime.mjs'
import { createVoiceSession } from '../src/voice-session.mjs'
function fixture(run) {
 const home=mkdtempSync(join(tmpdir(),'pet-restore-')),events=[],shown=[],keys=new Map()
 const options={home,window:{show(){},focus(){},hide(){},isDestroyed:()=>false,isMinimized:()=>false,webContents:{send(){}}},emit:(channel,value)=>events.push({channel,value}),show:value=>shown.push(value),hide(){},shortcuts:{register(key,action){keys.set(key,action);return true},unregister:key=>keys.delete(key)},request:async()=>({ok:true,config:{}})}
 const experience=createPetExperience(options)
 return Promise.resolve().then(()=>run({experience,home,events,shown,keys,options})).finally(async()=>{await experience.stop();assert.equal(keys.size,0);rmSync(home,{recursive:true,force:true})})
}
test('welcome is visible, accepts a name and persists sanitized progress',()=>fixture(async({experience,shown,home})=>{
 experience.start();await new Promise(r=>setImmediate(r));assert.equal(shown.at(-1).visible,true);assert.match(shown.at(-1).text,/我该怎么称呼你/)
 await experience.action({requestId:'onboarding:address',type:'input',value:'朋友'});assert.match(shown.at(-1).text,/什么性格/)
 const saved=JSON.parse(readFileSync(join(home,'pet/pet-experience.json'),'utf8'));assert.equal(saved.onboarding.answers.addressUser,'朋友');assert.equal(saved.onboarding.answers.voice.apiKey,'')
}))
test('voice mode, effective shortcut fallback and appearance preferences persist',()=>fixture(async({experience,home,keys})=>{
 assert.ok(keys.has('Alt+Space'));assert.ok(keys.has('CommandOrControl+Shift+Space'))
 experience.update({voiceInput:{mode:'always',keyId:'alt-space'},language:'en',autoHideSeconds:60})
 const saved=JSON.parse(readFileSync(join(home,'pet/pet-experience.json'),'utf8'));assert.equal(saved.voiceInput.mode,'always');assert.equal(saved.localConfig.language,'en')
 const second=createPetExperience({home,window:{isDestroyed:()=>true},emit(){},show(){},hide(){},request:async()=>({}),shortcuts:{register:()=>true,unregister(){}}})
 try{assert.equal(second.state().voiceInput.mode,'always');assert.equal(second.state().autoHideSeconds,60)}finally{await second.stop()}
}))
test('listening waits for actual bot readiness; mute preserves playback transport',async()=>{
 let callbacks,disconnects=0;const mic=[]
 const session=createVoiceSession({publish(){},createClient:c=>{callbacks=c;return{connect:async()=>{},disconnect:async()=>{disconnects++},enableMic:v=>mic.push(v)}}})
 await session.update('/offer');await session.command('enable');assert.equal(session.snapshot().enabled,false);assert.equal(session.snapshot().phase,'connecting')
 await callbacks.ready();assert.equal(session.snapshot().enabled,true);await session.command('mute');assert.equal(session.snapshot().enabled,false);assert.equal(disconnects,0)
 await session.command('enable');assert.equal(session.snapshot().enabled,true);await session.stop();assert.equal(disconnects,1);assert.deepEqual(mic,[true,false,true])
})
test('release during connect prevents readiness from re-enabling capture',async()=>{
 let callbacks,connected;const mic=[]
 const session=createVoiceSession({publish(){},createClient:c=>{callbacks=c;return{connect:()=>new Promise(r=>connected=r),disconnect:async()=>{},enableMic:v=>mic.push(v)}}})
 await session.update('/offer');const opening=session.command('enable');await new Promise(r=>setImmediate(r));const muting=session.command('mute');await callbacks.ready();assert.equal(session.snapshot().enabled,false)
 connected();await Promise.all([opening,muting]);assert.ok(mic.every(v=>v===false));await session.stop()
})
test('failed client is disposed and retry creates a new one',async()=>{
 let callbacks,created=0,closed=0
 const session=createVoiceSession({publish(){},createClient:c=>{created++;callbacks=c;return{connect:async()=>{},disconnect:async()=>{closed++},enableMic(){}}}})
 await session.update('/offer');await session.command('enable');callbacks.error(new Error('lost'));assert.equal(session.snapshot().enabled,false)
 await session.command('enable');assert.equal(created,2);assert.equal(closed,1);await callbacks.ready();assert.equal(session.snapshot().enabled,true);await session.stop()
})
test('shutdown aborts unresolved media connect',async()=>{
 let closed=0;const session=createVoiceSession({publish(){},createClient:()=>({connect:()=>new Promise(()=>{}),enableMic(){},disconnect:async()=>{closed++}})})
 await session.update('/offer');void session.command('enable');await new Promise(r=>setImmediate(r));await session.stop();assert.equal(closed,1)
})
test('onboarding can pause/resume and yield to official pending requests',()=>fixture(async({experience,shown})=>{
 experience.start();await new Promise(r=>setImmediate(r));await experience.action({requestId:'onboarding:address',type:'close'});assert.equal(experience.state().onboarding,false)
 experience.menu().find(x=>x.label==='继续引导（气泡内）').click();await new Promise(r=>setImmediate(r));assert.equal(experience.state().onboarding,true)
 experience.sync({requests:[{id:'approval'}]});assert.equal(experience.state().onboarding,false);experience.sync({requests:[]});assert.equal(experience.state().onboarding,true);assert.match(shown.at(-1).text,/称呼/)
}))
test('hold/toggle/mouse gestures, hide/wake shortcut and keyword control the owned pet',()=>fixture(async({experience,events,keys})=>{
 experience.gesture('down');experience.gesture('up');assert.equal(events.at(-1).value.action,'mute');experience.gesture('down');experience.gesture('up');assert.equal(events.at(-1).value.action,'mute')
 experience.update({voiceInput:{mode:'toggle',keyId:'mouse4'}});experience.gesture('down');experience.gesture('up');assert.equal(events.at(-1).value.action,'toggle')
 experience.menu().find(x=>x.label==='隐藏桌宠').click();assert.equal(events.at(-1).value.state,'hidden');keys.get('CommandOrControl+Shift+Space')();assert.equal(events.at(-1).value.state,'active')
 experience.update({wakeWordEnabled:true,wakeWordPhrase:'你好小鲸'});experience.wake();assert.equal(events.at(-1).value.source,'wake-word')
}))

test('Dock, notifications and speech length are local preferences and never restart the Agent',()=>fixture(async({experience,home})=>{
 assert.equal(experience.state().showDockIcon,true);assert.equal(experience.state().systemNotifications,true)
 experience.menu().find(item=>item.label==='显示 Dock 图标').click()
 experience.menu().find(item=>item.label==='系统审批/问答通知').click()
 experience.menu().find(item=>item.label==='语音播报长度').submenu[1].click()
 const saved=JSON.parse(readFileSync(join(home,'pet/pet-experience.json'),'utf8')).localConfig
 assert.equal(saved.showDockIcon,false);assert.equal(saved.systemNotifications,false);assert.equal(saved.playbackStyle,'brief')
}))
