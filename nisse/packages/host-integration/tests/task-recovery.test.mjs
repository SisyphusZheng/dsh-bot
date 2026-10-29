import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createTaskRecovery,latestRecoverableTask} from '../lib/task-recovery.mjs'
const events=(kind='aborted',text='原始目标')=>[{type:'turn/start',data:{turn:3}},{type:'user/message',data:{id:'m',source:{kind:'user'},content:[{type:'text',text}]}},{type:'turn/end',data:{turn:3,reason:{kind}}}]
function fixture(){let current=true,clock=0;const calls=[],snapshot={owner:{},sessionId:'s',seq:3,status:'idle',events:events()};const recovery=createTaskRecovery({load:async()=>snapshot,isCurrent:()=>current,execute:async(...args)=>{calls.push(args);return {accepted:true}},now:()=>clock,ttlMs:50});return {recovery,calls,snapshot,stale:()=>current=false,expire:()=>clock=51}}
test('preview is read-only, confirmation is required and duplicate clicks execute once',async()=>{
 const f=fixture(),p=await f.recovery.preview();assert.equal(p.originalText,'原始目标');assert.equal(f.calls.length,0)
 await assert.rejects(f.recovery.submit({token:p.token,mode:'retry'}),e=>e.status===400)
 await f.recovery.submit({token:p.token,mode:'retry',confirmSideEffects:true});assert.equal(f.calls[0][0],'原始目标')
 await assert.rejects(f.recovery.submit({token:p.token,mode:'retry',confirmSideEffects:true}),e=>e.status===409);assert.equal(f.calls.length,1)
})
test('continue is a checked user instruction, never a tool replay',async()=>{const f=fixture(),p=await f.recovery.preview();await f.recovery.submit({token:p.token,mode:'continue',confirmSideEffects:true});assert.match(f.calls[0][0],/不重复已经完成的操作/);assert.match(f.calls[0][0],/原始目标/);assert.equal(f.calls[0][2],'continue')})
test('busy, stale, expired and cleared requests cannot execute',async()=>{
 const busy=fixture();busy.snapshot.status='running';await assert.rejects(busy.recovery.preview())
 for(const mode of ['stale','expire','clear']){const f=fixture(),p=await f.recovery.preview();if(mode==='clear')f.recovery.clear();else f[mode]();await assert.rejects(f.recovery.submit({token:p.token,mode:'retry',confirmSideEffects:true}));assert.equal(f.calls.length,0)}
})
test('completed, active, non-text and oversized instructions are not silently repeated',()=>{
 for(const e of [events('completed'),events().slice(0,-1),events('aborted','x'.repeat(20001))])assert.throws(()=>latestRecoverableTask(e))
 const input=events();input[1].data.content.push({type:'image',data:'fixture'});assert.throws(()=>latestRecoverableTask(input))
 assert.throws(()=>latestRecoverableTask([...events(),...events('completed','new target')]))
})
