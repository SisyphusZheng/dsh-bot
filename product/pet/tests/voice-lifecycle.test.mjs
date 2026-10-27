import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCaptureClient } from '../src/capture-client.mjs'
import { createPauseOnInputMonitor, canPauseDesktopTurn } from '../src/pause-on-input.mjs'
import { createCompanionPresentation } from '../src/companion-presentation.mjs'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const { transformSync } = createRequire(new URL('../../../apps/desktop/package.json', import.meta.url))('esbuild')

function capture() {
 const sent=[], mic=[], shown=[];let seq=0
 const c=createCaptureClient({send:(type,data)=>sent.push({type,...data}),setMic:v=>mic.push(v),publish:v=>shown.push(v),id:()=>`c${++seq}`})
 const ack=()=>c.message({type:'capture-ack',action:'start',captureId:c.snapshot().captureId})
 const transcript=(utteranceId,text,final=false)=>c.message({type:'capture-transcript',captureId:c.snapshot().captureId,utteranceId,text,final})
 return {c,sent,mic,shown,ack,transcript}
}
test('hold release before worker acknowledgement never opens the microphone',async()=>{
 const f=capture();const opening=f.c.enable(true);assert.deepEqual(f.mic,[])
 await f.c.enable(false);f.ack();await opening;assert.deepEqual(f.mic,[false]);assert.equal(f.sent.at(-1).action,'finish');f.c.stop()
})
test('capture discard rejects late text and never emits a task cancellation or disconnect',async()=>{
 const f=capture();const opening=f.c.enable(true);f.ack();await opening;assert.deepEqual(f.mic,[true])
 f.transcript('u1','打开浏览器');assert.equal(f.shown.at(-1).kind,'input')
 assert.equal(f.c.discard('old-capture'),false);assert.equal(f.c.discard('c1'),true)
 const count=f.shown.length;f.transcript('u1','打开浏览器',true);assert.equal(f.shown.length,count)
 assert.deepEqual(f.sent.map(x=>x.action),['start','discard']);assert.equal(f.mic.at(-1),false);f.c.stop()
})
test('one always-listening capture supports multiple final utterances and ignores duplicate callbacks',async()=>{
 const f=capture();const p=f.c.enable(true);f.ack();await p
 f.transcript('u1','你好',true);f.transcript('u1','你好',true);f.transcript('u1','你');f.transcript('u2','打开窗口',true)
 assert.deepEqual(f.shown.map(x=>x.text),['你好','打开窗口']);f.c.stop()
})
test('voice-origin turns survive idle=0, while a desktop turn stops at most once',()=>{
 let time=1000,active=true,source='voice',started=1000,waiting=false,held=false;const stopped=[]
 const p=createPauseOnInputMonitor({getIdleSeconds:()=>0,isTurnActive:()=>active,getTurnStartedAt:()=>started,now:()=>time,shouldPause:()=>canPauseDesktopTurn({turn:{inputSource:source,waiting},inputActive:held}),onPause:d=>stopped.push(d)})
 for(time=2000;time<12000;time+=1000)p.tick();assert.equal(stopped.length,0)
 source='desktop';held=true;p.tick();waiting=true;held=false;p.tick();assert.equal(stopped.length,0)
 waiting=false;p.tick();p.tick();assert.equal(stopped.length,1)
 active=false;p.tick();active=true;started=time;p.tick();time+=4000;p.tick();assert.equal(stopped.length,2);p.stop()
})
test('final transcript has no task-cancel button and stale capture actions are rejected',()=>{
 const shown=[],timers=new Map();let seq=0,hidden=0
 const p=createCompanionPresentation({show:v=>shown.push(v),hide:()=>hidden++,animate(){},send:()=>{throw new Error('capture must not call DSH')},setTimer:fn=>{timers.set(++seq,fn);return seq},clearTimer:id=>timers.delete(id)})
 p.capture({kind:'input',captureId:'c1',text:'打开'});assert.equal(shown.at(-1).cancel.id,'cancel-capture');assert.equal(shown.at(-1).requestId,'c1')
 p.capture({kind:'transcript',captureId:'c1',text:'打开窗口'});assert.equal(shown.at(-1).cancel,undefined);assert.equal(p.cancelCapture('c1'),false)
 p.event({type:'turn.accepted',data:{inputSource:'voice'}});p.event({type:'turn.started',data:{}});assert.equal(p.state().inputSource,'voice');assert.equal(p.state().working,true)
 p.capture({kind:'input',captureId:'c2',text:'别的请求'});assert.equal(p.cancelCapture('c1'),false);assert.equal(p.cancelCapture('c2'),true);assert.equal(p.state().working,true);assert.ok(hidden>0);p.stop();assert.equal(timers.size,0)
})
test('locale dictionaries contain no duplicate keys',()=>{
 const result=transformSync(readFileSync(new URL('../src/i18n.mjs',import.meta.url),'utf8'),{logLevel:'silent'})
 assert.deepEqual(result.warnings.filter(x=>x.id==='duplicate-object-key'),[])
})

test('continuing partials cannot extend the absolute input bubble deadline',()=>{
 const timers=new Map(),shown=[];let seq=0,hidden=0
 const p=createCompanionPresentation({show:v=>shown.push(v),hide:()=>hidden++,animate(){},send:async()=>{},setTimer:(fn,ms)=>{timers.set(++seq,{fn,ms});return seq},clearTimer:id=>timers.delete(id)})
 const input={kind:'input',captureId:'c1',utteranceId:'u1',text:'打开'}
 p.capture(input);const hard=[...timers.values()].find(x=>x.ms===15000);assert.ok(hard)
 p.capture({...input,text:'打开窗口'});hard.fn();const count=shown.length
 p.capture({...input,text:'打开窗口啊'});assert.equal(shown.length,count);assert.ok(hidden>0)
 p.capture({...input,utteranceId:'u2',text:'另一个请求'});assert.equal(shown.length,count+1);p.stop()
})

test('rapid release and repress cannot let an old capture acknowledgement open the new mic',async()=>{
 const f=capture();const first=f.c.enable(true);await f.c.enable(false)
 const second=f.c.enable(true),duplicate=f.c.enable(true)
 f.c.message({type:'capture-ack',action:'start',captureId:'c1'});await Promise.resolve();assert.ok(f.mic.every(x=>x===false))
 f.ack();await Promise.all([first,second,duplicate]);assert.deepEqual(f.sent.map(x=>x.action),['start','finish','start']);assert.equal(f.mic.at(-1),true);f.c.stop()
})
