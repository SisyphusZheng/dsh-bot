import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalView, createCompanionPresentation, humanizeFailure } from '../src/companion-presentation.mjs'
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
test('waiting inputs can be reviewed, corrected, confirmed or deleted without touching the active task',async()=>{
 const calls=[],f=fixture(async(...args)=>calls.push(args))
 f.presentation.sync(snapshot([]))
 f.presentation.queue({revision:3,entries:[{id:'queued',text:'就是',position:1,waitedSeconds:62,needsConfirmation:true}]})
 await f.presentation.manageQueue()
 assert.deepEqual(calls.pop(),['voice-queue',{action:'snapshot'}])
 await f.presentation.action({type:'choice',requestId:'queue:3',id:'queued'})
 assert.match(f.shown.at(-1).hint,/需要重新确认/)
 await f.presentation.action({type:'secondary',requestId:'queue:3',id:'queue-edit'})
 await f.presentation.action({type:'input',requestId:'queue:3',value:'请整理报告'})
 assert.deepEqual(calls.pop(),['voice-queue',{action:'edit',id:'queued',revision:3,text:'请整理报告'}])
 f.presentation.queue({revision:4,entries:[{id:'queued',text:'请整理报告',position:1,waitedSeconds:63,needsConfirmation:false}]})
 await f.presentation.action({type:'secondary',requestId:'queue:3',id:'queue-delete'})
 assert.equal(calls.length,0)
 await f.presentation.action({type:'secondary',requestId:'queue:4',id:'queue-delete'})
 assert.deepEqual(calls.pop(),['voice-queue',{action:'delete',id:'queued',revision:4}])
 f.presentation.queue({revision:5,entries:[]});assert.equal(f.shown.at(-1).text,'没有等待的输入。')
 f.presentation.stop()
})
test('passive input is labelled, editable and needs explicit submission; stale actions do nothing',async()=>{
  const calls=[],f=fixture(async(...args)=>calls.push(args))
  f.presentation.sync(snapshot([]))
  f.presentation.capture({kind:'input-confirmation',draftId:'d1',captureId:'c',text:'这说不清楚'})
  assert.equal(f.shown.at(-1).title,'我听到（尚未发送）')
  assert.equal(calls.length,0)
  f.presentation.notice('background status')
  assert.equal(f.shown.at(-1).text,'这说不清楚')
  await f.presentation.action({type:'secondary',requestId:'voice:old',id:'voice-confirm'})
  assert.equal(calls.length,0)
  await f.presentation.action({type:'secondary',requestId:'voice:d1',id:'voice-edit'})
  assert.equal(f.shown.at(-1).input.value,'这说不清楚')
  await f.presentation.action({type:'input',requestId:'voice:d1',value:'请整理报告'})
  await f.presentation.action({type:'input',requestId:'voice:d1',value:'duplicate'})
  assert.deepEqual(calls,[['voice-input',{action:'confirm-input',id:'d1',text:'请整理报告'}]])
  f.presentation.capture({kind:'input-confirmation-ended',draftId:'d1'})
  f.presentation.stop();assert.equal(f.timers.size,0)
})
test('pending approvals keep precedence over a passive draft, discard and expiry never call Agent',async()=>{
  const calls=[],f=fixture(async(...args)=>calls.push(args))
  const approval={id:'a',kind:'approval',sessionId:'s',toolName:'bash'}
  f.presentation.sync(snapshot([approval]))
  f.presentation.capture({kind:'input-confirmation',draftId:'d1',captureId:'c',text:'环境声'})
  assert.equal(f.shown.at(-1).requestId,'a')
  f.presentation.sync(snapshot([]))
  assert.equal(f.shown.at(-1).requestId,'voice:d1')
  await f.presentation.action({type:'secondary',requestId:'voice:d1',id:'voice-discard'})
  assert.deepEqual(calls,[['voice-input',{action:'discard-input',id:'d1'}]])
  f.presentation.capture({kind:'input-confirmation',draftId:'d2',captureId:'c',text:'expired'})
  for(const fn of [...f.timers.values()])fn()
  await f.presentation.action({type:'secondary',requestId:'voice:d2',id:'voice-confirm'})
  assert.equal(calls.length,1);f.presentation.stop()
})
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
  assert.doesNotMatch(payload.text,/Users\/example/)
  assert.ok(payload.details.includes('目标：/Users/example')); assert.ok(payload.details.some(line=>line.includes('只能批准本次')))
  assert.deepEqual(payload.secondary,[])
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
  assert.deepEqual(payload.secondary,[{id:'recover-task',label:'恢复上次任务…'},{id:'inspect-task',label:'检查任务状态'},{id:'open',label:'打开主窗口'}])
  await f.presentation.action({type:'secondary',id:'open'})
  assert.deepEqual(calls,[['open']])
  f.presentation.stop()
})

test('approval mapping never converts an unknown shell command into read/delete risk claims', () => {
  const write = approvalView({ toolName:'write', reason:'write outside workspace: /Users/example/a.txt' })
  assert.match(write.text,/写入或修改/); assert.ok(write.details.some(line=>line.includes("/Users/example/a.txt")))
  const read = approvalView({ toolName:'read', reason:'read outside workspace: /Users/example/b.txt' })
  assert.match(read.text,/读取/); assert.equal(read.text.includes('写入'),false)
  const shell = approvalView({ toolName:'bash', reason:'bash outside workspace: /Users/example' })
  assert.match(shell.text,/运行命令/); assert.equal(shell.text.includes('读取'),false); assert.equal(shell.text.includes('删除'),false)
  const unknown = approvalView({ toolName:'mcp__custom', reason:'needs approval' })
  assert.match(unknown.text,/执行一个需要你批准的操作/); assert.ok(unknown.details.includes('工具：mcp__custom'))
  assert.ok(unknown.details.some(line => line.includes('原始原因：needs approval')))
  assert.equal(humanizeFailure('DSH 进程在本轮完成前退出（例如被强制结束、崩溃或关闭超时）').startsWith('上次任务被中断'), true)
  assert.equal(humanizeFailure('普通错误'), '普通错误')
})

test('persistent approval requires exact operation and a second confirmation; stale drafts cannot grant', async()=>{
 const calls=[],f=fixture(async(...x)=>calls.push(x)),operation={toolName:'bash',cwd:'/work',arguments:{command:'echo fixture'}}
 const request={id:'a',kind:'approval',sessionId:'s',toolName:'bash',operation}
 f.presentation.sync(snapshot([request]));assert.ok(f.shown.at(-1).details.some(x=>x.includes('echo fixture')))
 await f.presentation.action({type:'secondary',id:'grant-confirm',requestId:'a'});assert.equal(calls.length,0)
 assert.equal(f.shown.at(-1).approval.allowLabel,'确认持续允许')
 await f.presentation.action({type:'approval',decision:'allow',requestId:'a'})
 assert.deepEqual(calls[0],['/approval',{id:'a',sessionId:'s',decision:'always-allow',confirmExact:true}])
 f.presentation.sync(snapshot([request]));await f.presentation.action({type:'secondary',id:'grant-confirm',requestId:'a'})
 f.presentation.sync(snapshot([{...request,id:'b'}]));assert.equal(f.shown.at(-1).approval.allowLabel,'允许一次')
 await f.presentation.action({type:'approval',decision:'allow',requestId:'a'});assert.equal(calls.length,1)
 f.presentation.stop()
})
test('grant manager revokes displayed ids only and yields to an arriving approval', async()=>{
 const calls=[],rule={id:'r',toolName:'write',key:'abc123abc123abc123',createdAt:'today'}
 const f=fixture(async(path,body)=>{calls.push([path,body]);return {rules:[rule]}})
 await f.presentation.managePolicies();const own=f.shown.at(-1).requestId
 await f.presentation.action({type:'choice',id:'forged',requestId:own});assert.equal(calls.length,1)
 await f.presentation.action({type:'choice',id:'r',requestId:own});assert.deepEqual(calls.at(-1),['/policies?id=r',{method:'DELETE'}]);assert.equal(f.shown.at(-1).choices.length,0)
 f.presentation.sync(snapshot([{id:'a',kind:'approval',sessionId:'s',toolName:'bash'}]))
 await f.presentation.action({type:'choice',id:'r',requestId:own});assert.equal(calls.length,2);assert.equal(f.shown.at(-1).approval.id,'a');f.presentation.stop()
})
test('late grant-manager load cannot replace a pending approval', async()=>{
 let resolve;const f=fixture(()=>new Promise(r=>resolve=r));const pending=f.presentation.managePolicies()
 f.presentation.sync(snapshot([{id:'a',kind:'approval',sessionId:'s',toolName:'write'}]));resolve({rules:[]});await pending
 assert.equal(f.shown.at(-1).requestId,'a');f.presentation.stop()
})

test('recovery requires a second click and scopes the original token',async()=>{
 const calls=[],f=fixture(async(path,body)=>{calls.push([path,body]);return {token:'r',originalText:'原始目标',warning:'检查副作用'}})
 await f.presentation.recoverTask();const id=f.shown.at(-1).requestId
 await f.presentation.action({type:'choice',id:'retry',requestId:id});assert.equal(calls.length,1)
 await f.presentation.action({type:'secondary',id:'recovery-confirm',requestId:'stale'});assert.equal(calls.length,1)
 await f.presentation.action({type:'secondary',id:'recovery-confirm',requestId:id});assert.deepEqual(calls.at(-1),['/task/recovery',{token:'r',mode:'retry',confirmSideEffects:true}]);f.presentation.stop()
})
test('recovery preview yields to pending approval',async()=>{
 let resolve;const f=fixture(()=>new Promise(r=>resolve=r));const pending=f.presentation.recoverTask()
 f.presentation.sync(snapshot([{id:'a',kind:'approval',sessionId:'s',toolName:'write'}]));resolve({token:'r',originalText:'old'});await pending;assert.equal(f.shown.at(-1).requestId,'a');f.presentation.stop()
})
test('notices with visible actions accept pointer interaction',()=>{const f=fixture();f.presentation.notice('fixture','error',9000,'',{secondary:[{id:'open',label:'打开主窗口'}]});assert.equal(f.shown.at(-1).clickThrough,false);f.presentation.stop()})

test('voice questions use the same current controller, including multi-question navigation and stale click/voice races',async()=>{
 const calls=[],views=[]
 const p=createCompanionPresentation({show:()=>{},hide:()=>{},animate:()=>{},send:async(...v)=>calls.push(v),publishQuestion:v=>views.push(v)})
 p.sync(snapshot([{...question,questions:[question.questions[0],{id:'extras',question:'加什么？',multiSelect:true,options:[{label:'糖'},{label:'奶'}]}]}]))
 const first=views.at(-1)
 assert.equal(await p.voiceAnswer({answerId:'a',view:first,text:'嗯，就选最后一个选项吧。'}),true)
 assert.equal(views.at(-1).questionId,'extras')
 assert.equal(await p.voiceAnswer({answerId:'late',view:first,text:'第一个选项'}),false)
 await p.voiceAnswer({answerId:'b',view:views.at(-1),text:'第一个选项'})
 const selectedView=views.at(-1)
 assert.deepEqual(selectedView.selected,['糖'])
 await p.action({type:'choice',requestId:'choose',id:'1'})
 assert.equal(await p.voiceAnswer({answerId:'race',view:selectedView,text:'提交选择'}),false)
 assert.equal(calls.length,0)
 await p.voiceAnswer({answerId:'c',view:views.at(-1),text:'提交选择'})
 assert.equal(calls.length,1)
 assert.deepEqual(calls[0][1].answer.answers,[{id:'drink',selected:['茶']},{id:'extras',selected:['糖','奶']}])
 assert.equal(views.at(-1),null)
 assert.equal(await p.voiceAnswer({answerId:'c',view:selectedView,text:'提交选择'}),false)
 p.stop()
})
test('ambiguous voice options remain pending, explicit custom text and cancelled requests cannot become tasks',async()=>{
 const calls=[],views=[]
 const p=createCompanionPresentation({show:()=>{},hide:()=>{},animate:()=>{},send:async(...v)=>calls.push(v),publishQuestion:v=>views.push(v)})
 p.sync(snapshot([question]))
 assert.equal(await p.voiceAnswer({answerId:'x',view:views.at(-1),text:'也许随便吧'}),false)
 assert.equal(calls.length,0)
 assert.equal(await p.voiceAnswer({answerId:'y',view:views.at(-1),text:'其他回答：温水'}),true)
 assert.equal(calls[0][1].answer.answers[0].custom,'温水')
 p.sync(snapshot([question]));const old=views.at(-1);p.sync(snapshot([]))
 assert.equal(await p.voiceAnswer({answerId:'z',view:old,text:'最后一个'}),false)
 p.stop()
})
