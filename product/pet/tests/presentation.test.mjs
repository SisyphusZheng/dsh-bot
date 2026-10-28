import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCompanionPresentation } from '../src/companion-presentation.mjs'
import { spritePlaybackSelection, resolveAnimations, spriteGeometry } from '../src/sprite-orb.js'
import { readFileSync } from 'node:fs'

function fixture(send = async () => {}) {
  const shown = [], animations = [], timers = new Map()
  let hidden = 0, seq = 0
  const presentation = createCompanionPresentation({ show: p => shown.push(p), hide: () => hidden++, animate: p => animations.push(p), send,
    setTimer(fn) { timers.set(++seq, fn); return seq }, clearTimer(id) { timers.delete(id) } })
  return { presentation, shown, animations, timers, hidden: () => hidden }
}
const question = { id:'choose',kind:'question',sessionId:'s',questions:[{id:'drink',question:'喝什么？',options:[{label:'拿铁'},{label:'美式'},{label:'茶'}]}] }
const snapshot = requests => ({ pid:1,sessionId:'s',requests })
test('idle is silent; ordinary speech expires and stops leave no timers', () => {
  const f=fixture();assert.equal(f.shown.length,0)
  f.presentation.sync(snapshot([]));assert.equal(f.shown.length,0)
  f.presentation.event({type:'assistant.delta',data:{text:'你好'}})
  assert.equal(f.shown.at(-1).text,'你好');assert.equal(f.shown.at(-1).clickThrough,false)
  const before=f.hidden();for(const fn of [...f.timers.values()])fn();assert.ok(f.hidden()>before)
  f.presentation.stop();assert.equal(f.timers.size,0)
})
test('speech retains the beginning and ending of long streamed and completed reports', () => {
  const f = fixture(), report = '**结果**\n' + '详情'.repeat(450) + '\n完成'
  f.presentation.event({type:'assistant.delta',data:{text:report.slice(0,500)}})
  f.presentation.event({type:'assistant.delta',data:{text:report.slice(500)}})
  assert.equal(f.shown.at(-1).text, report)
  f.presentation.event({type:'assistant.message',data:{text:report}})
  assert.equal(f.shown.at(-1).text, report)
  f.presentation.stop()
})
test('single choice posts an official answer batch to the owning request', async () => {
  const calls=[],f=fixture(async(...args)=>calls.push(args))
  f.presentation.sync(snapshot([question]));assert.equal(f.shown.at(-1).choices.length,3)
  f.presentation.event({type:'assistant.delta',data:{text:'cannot replace a pending question'}})
  assert.equal(f.shown.at(-1).requestId,'choose');assert.equal(f.timers.size,0)
  await f.presentation.action({type:'choice',requestId:'choose',id:'1'})
  assert.deepEqual(calls,[['/questions/answer',{id:'choose',sessionId:'s',answer:{answers:[{id:'drink',selected:['美式']}]}}]])
  assert.ok(f.hidden()>0);f.presentation.stop()
})
test('multi-select and multi-question batches preserve every question id', async () => {
  const calls=[],f=fixture(async(...args)=>calls.push(args))
  f.presentation.sync(snapshot([{...question,questions:[{...question.questions[0],multiSelect:true},{id:'note',question:'备注'}]}]))
  await f.presentation.action({type:'choice',requestId:'choose',id:'0'})
  await f.presentation.action({type:'choice',requestId:'choose',id:'2'})
  assert.equal(calls.length,0);assert.equal(f.shown.at(-1).choices.filter(x=>x.selected).length,2)
  await f.presentation.action({type:'secondary',requestId:'choose',id:'submit'})
  await f.presentation.action({type:'input',requestId:'choose',value:'不要糖'})
  assert.deepEqual(calls[0][1].answer.answers,[{id:'drink',selected:['拿铁','茶']},{id:'note',selected:[],custom:'不要糖'}])
  f.presentation.stop()
})
test('only one click is admitted while submitting; a failure remains retryable', async () => {
  let release,calls=0
  const f=fixture(()=>{calls++;return new Promise((resolve,reject)=>{release=reject})})
  const approval={id:'approval',kind:'approval',sessionId:'s',toolName:'write',reason:'写入指定文件？'}
  f.presentation.sync(snapshot([approval,question]))
  const pending=f.presentation.action({type:'approval',requestId:'approval',decision:'allow'})
  await f.presentation.action({type:'approval',requestId:'approval',decision:'reject'})
  assert.equal(calls,1);assert.equal(f.shown.at(-1).busy,true)
  release(new Error('disconnected'));await pending
  assert.equal(f.shown.at(-1).busy,false);assert.match(f.shown.at(-1).hint,/重试/)
  f.presentation.sync(snapshot([question]));assert.equal(f.shown.at(-1).requestId,'choose')
  await f.presentation.action({type:'approval',requestId:'approval',decision:'allow'});assert.equal(calls,1)
  f.presentation.stop()
})
test('another surface settling a request and Host replacement remove stale controls', async () => {
  const calls=[],f=fixture(async(...args)=>calls.push(args));f.presentation.sync(snapshot([question]))
  f.presentation.sync(snapshot([]));await f.presentation.action({type:'choice',requestId:'choose',id:'0'});assert.equal(calls.length,0)
  f.presentation.sync(snapshot([question]));f.presentation.sync({pid:2,sessionId:'new',requests:[]})
  await f.presentation.action({type:'choice',requestId:'choose',id:'0'});assert.equal(calls.length,0);f.presentation.stop()
})
test('the restored sprite policies distinguish speech, work, waiting, drag and completion', () => {
  assert.equal(spritePlaybackSelection({state:'speaking'}).name,'waving')
  assert.equal(spritePlaybackSelection({state:'working'}).name,'running')
  assert.equal(spritePlaybackSelection({state:'listening'}).name,'waiting')
  assert.equal(spritePlaybackSelection({state:'idle',dragDirection:'left'}).name,'running-left')
  assert.equal(spritePlaybackSelection({state:'idle',cue:{id:'done',name:'jumping'}}).loop,false)
  const manifest=JSON.parse(readFileSync(new URL('../../../apps/desktop/resources/whale-girl/pet.json',import.meta.url)))
  assert.equal(Object.keys(resolveAnimations(manifest,spriteGeometry(manifest).frameCount)).length,9)
})

test('approval payload is localized, never offers the dead DSH link, and exposes details', () => {
  const f = fixture()
  f.presentation.sync(snapshot([{ id:'a1',kind:'approval',sessionId:'s',toolName:'bash',reason:'bash outside workspace: /Users/example' }]))
  const payload = f.shown.at(-1)
  assert.match(payload.text,/运行命令/)
  assert.match(payload.text,/Users\/example/)
  assert.deepEqual(payload.details,['工具：bash','目标：/Users/example','原始原因：bash outside workspace: /Users/example','范围：仅本次请求；不会复用为后续操作的授权'])
  assert.equal(payload.secondary,undefined)
  assert.ok(!JSON.stringify(payload).includes('在 DSH 中查看'))
  f.presentation.stop()
})
test('single questions hide 1/1 and multi questions keep progress and an explicit submit', () => {
  const f = fixture()
  f.presentation.sync(snapshot([question]))
  assert.equal(f.shown.at(-1).progress,'')
  assert.equal(f.shown.at(-1).secondary.some(item => item.id === 'submit'),false)
  f.presentation.stop()
  const multi=fixture()
  multi.presentation.sync(snapshot([{...question,questions:[{...question.questions[0],multiSelect:true},{id:'note',question:'备注'}]}]))
  assert.equal(multi.shown.at(-1).progress,'1 / 2')
  assert.equal(multi.shown.at(-1).secondary.some(item => item.id === 'submit'),true)
  assert.equal(multi.shown.at(-1).secondary.some(item => item.id === 'open'),false)
  multi.presentation.stop()
})
test('interrupted upstream failure prose becomes a human notice with a working main-window action', async () => {
  const calls=[],f=fixture(async(...args)=>calls.push(args))
  f.presentation.event({type:'error',ioSeq:7,data:{message:'DSH 进程在本轮完成前退出（例如被强制结束、崩溃或关闭超时），重新启动后本轮已中止。未完成的工具调用结果未知。'}})
  const payload=f.shown.at(-1)
  assert.match(payload.text,/上次任务被中断/)
  assert.match(payload.text,/打开主窗口/)
  assert.deepEqual(payload.secondary,[{id:'open',label:'打开主窗口'}])
  await f.presentation.action({type:'secondary',id:'open'})
  assert.deepEqual(calls,[['open']])
  f.presentation.stop()
})
