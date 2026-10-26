import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInteractionMirror, validateAnswer } from '../lib/interactions.mjs'
const source=()=>({agent:{session:{id:'session'}},questions:[{id:'q',question:'去哪？',options:[{label:'上海'},{label:'杭州'}]}]})
const answer={answers:[{id:'q',selected:['杭州']}]}
test('pet answer settles the official request and aborts the other UI', async () => {
  let forwarded
  const events=[],mirror=createInteractionMirror({emit:(...x)=>events.push(x),forward:async(_event,req)=>{forwarded=req;return new Promise((_r,reject)=>req.signal.addEventListener('abort',()=>reject(new Error('settled')),{once:true}))}})
  const pending=mirror.ask('question',source());await Promise.resolve();const request=mirror.snapshot()[0]
  assert.equal(mirror.answer(request.id,'wrong',answer),false)
  assert.throws(()=>mirror.answer(request.id,'session',{answers:[{id:'q',selected:['不存在']}]}),/Unknown option/)
  assert.equal(mirror.answer(request.id,'session',answer),true);assert.deepEqual(await pending,answer)
  assert.equal(forwarded.signal.aborted,true);assert.equal(mirror.answer(request.id,'session',answer),false)
  assert.equal(mirror.snapshot().length,0);assert.equal(events.at(-1)[0],'question.decided');mirror.dispose()
})
test('a decision from the DSH UI removes the same pet request', async () => {
  const events=[],mirror=createInteractionMirror({emit:(...x)=>events.push(x),forward:async()=>answer})
  assert.deepEqual(await mirror.ask('question',source()),answer)
  assert.equal(mirror.snapshot().length,0);assert.equal(events.filter(x=>x[0]==='question.decided').length,1);mirror.dispose()
})
test('cancellation and disposal settle pending choices and approvals', async () => {
  const controller=new AbortController(),mirror=createInteractionMirror({emit(){},forward:()=>new Promise(()=>{})})
  const pending=mirror.ask('question',{...source(),signal:controller.signal});controller.abort();await assert.rejects(pending,{code:'ASK_ABORTED'})
  const approval=mirror.ask('approval',{agent:source().agent,toolName:'write'});mirror.dispose();assert.equal(await approval,'cancelled');assert.equal(mirror.snapshot().length,0)
})
test('approval timeout fails closed, with one settlement', async () => {
  const events=[],mirror=createInteractionMirror({emit:(...x)=>events.push(x),forward:async()=> 'unavailable',approvalTimeoutMs:5})
  assert.equal(await mirror.ask('approval',{agent:source().agent,toolName:'write'}),'cancelled')
  assert.equal(events.filter(x=>x[0]==='approval.decided').length,1);mirror.dispose()
})
test('answer validation rejects omitted ids, repeated selections and extra choices', () => {
  const questions=source().questions
  for(const value of [{answers:[]},{answers:[{id:'wrong',selected:['杭州']}]},{answers:[{id:'q',selected:['杭州','杭州']}]},{answers:[{id:'q',selected:['杭州','上海']}]}])assert.throws(()=>validateAnswer(questions,value))
  assert.deepEqual(validateAnswer(questions,answer),answer)
  assert.deepEqual(validateAnswer([{id:'text',question:'备注'}],{answers:[{id:'text',selected:[],custom:' 无糖 '}]}),{answers:[{id:'text',selected:[],custom:'无糖'}]})
})
