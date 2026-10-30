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

test('assistant text stays visible while TTS is still speaking after turn-end', () => {
  const f=fixture()
  f.presentation.event({type:'assistant.message',data:{text:'一条回答'}})
  f.presentation.event({type:'turn.ended',ioSeq:1,data:{terminal:'completed'}})
  assert.ok(f.timers.size>0)
  f.presentation.voice('speaking')
  assert.equal(f.timers.size,0,'speaking must cancel the short turn-end hide timer')
  f.presentation.voice('idle')
  assert.ok(f.timers.size>0,'idle after speaking must schedule a hide')
  for(const fn of [...f.timers.values()])fn()
  assert.ok(f.hidden()>0)
  f.presentation.stop()
})

// ---------------------------------------------------------------------------
// beta2 v2 projection: Host Snapshot + versioned events (plan §11 B2-G11/G12)
// ---------------------------------------------------------------------------

const OPTION = (id, label) => ({ id, label, description: '' })

const v2Question = (overrides = {}) => ({
  id: 'choose', kind: 'question', sessionId: 's', semanticRevision: 1, viewRevision: 1,
  officialCallId: 'call-q', createdAt: '2026-10-30T00:00:00.000Z', expiresAt: null, operation: null,
  questions: [{
    id: 'drink', header: '', question: '喝什么？', detail: '', multiSelect: false,
    options: [OPTION('official:latte', '拿铁'), OPTION('official:americano', '美式'), OPTION('official:tea', '茶')],
  }],
  ...overrides,
})

const v2Approval = (overrides = {}) => ({
  id: 'approve', kind: 'approval', sessionId: 's', semanticRevision: 2, viewRevision: 1,
  officialCallId: 'call-a', createdAt: '2026-10-30T00:00:00.000Z', expiresAt: null, questions: null,
  operation: { toolName: 'bash', cwd: '/work', arguments: { command: 'ls' } },
  ...overrides,
})

const v2Notice = (overrides = {}) => ({
  id: 'n1', kind: 'status', severity: 'info', text: '提示',
  createdAt: '2026-10-30T00:00:00.000Z', expiresAt: new Date(Date.now() + 60000).toISOString(),
  diagnosticId: null, actions: [],
  ...overrides,
})

const v2DraftState = (overrides = {}) => ({
  semanticRevision: 1, selectionRevision: 0, answers: { drink: { selected: [] } }, updatedAt: '2026-10-30T00:00:00.000Z', ...overrides,
})

const v2InputDraft = (overrides = {}) => ({
  id: 'd1', text: '这说不清楚', source: 'voice', captureId: 'c1',
  createdAt: '2026-10-30T00:00:00.000Z', expiresAt: '2026-10-30T00:00:30.000Z',
  revision: 3, status: 'pending', needsConfirmation: true,
  ...overrides,
})

const v2QueueItem = (overrides = {}) => ({
  id: 'q1', text: '写报告', position: 1, source: 'voice',
  createdAt: '2026-10-30T00:00:00.000Z', expiresAt: null, waitedSeconds: 5,
  needsConfirmation: false, status: 'waiting',
  ...overrides,
})

function v2snapshot(overrides = {}) {
  return {
    protocolVersion: 'dsh-bot-v1', schema: 'snapshot@1', hostEpoch: 'epoch-a', snapshotSeq: 1,
    identity: { sessionId: 's', hostPid: 99, botSessionReady: true, workspace: '/w' },
    capture: { state: 'off', mode: 'hold', captureId: null, preview: null },
    playback: { state: 'idle', playbackId: null, sourceTurnId: null, style: 'full' },
    execution: { state: 'idle', sessionId: 's', requestId: null, clientTurnId: null, turn: null, startedAt: null, inputSource: 'desktop', lastTurn: { turn: null, terminal: null, reason: null } },
    interactions: { focusedId: null, pending: [], drafts: {}, recentlyResolved: [] },
    inputDraft: null,
    queue: { revision: 0, items: [] },
    notices: [],
    presentation: {
      displayMode: 'idle',
      priority: ['interactions', 'inputDraft', 'queue', 'execution', 'playback', 'notices'],
      bubble: { visible: false, requestId: null, kind: null },
      bubblePolicy: { placement: 'above', anchorGapPx: 24 },
    },
    ...overrides,
  }
}

function v2(options = {}) {
  const shown = [], animations = [], timers = new Map(), commands = [], views = []
  let hidden = 0, seq = 0, snapshotSeq = 0
  const send = async (type, payload) => {
    commands.push(payload === undefined ? [type] : [type, payload])
    if (typeof options.send === 'function') return options.send(type, payload)
    return { protocolVersion: 'dsh-bot-v1', commandId: 'cmd', hostEpoch: 'epoch-a', status: 'accepted', result: {}, error: null }
  }
  const presentation = createCompanionPresentation({
    show: payload => shown.push({ ...payload }), hide: () => hidden++, animate: payload => animations.push(payload), send,
    setTimer(fn) { const id = ++seq; timers.set(id, fn); return id },
    clearTimer(id) { timers.delete(id) },
    publishQuestion: view => views.push(view),
  })
  return {
    presentation, shown, animations, timers, commands, views,
    hidden: () => hidden,
    nextSnapshot(overrides = {}) { snapshotSeq += 1; return v2snapshot({ snapshotSeq, ...overrides }) },
    fireTimers() { for (const fn of [...timers.values()]) fn() },
    timerCallbacks() { return [...timers.values()] },
  }
}

const interactionSnapshot = (f, pending, drafts = {}, extra = {}) => f.nextSnapshot({
  interactions: { focusedId: pending[0]?.id ?? null, pending, drafts, recentlyResolved: [] },
  ...extra,
})

test('v2 snapshot projects the focused interaction first and retains every pending item', () => {
  const f = v2()
  const approval = v2Approval()
  const question = v2Question({ id: 'ask' })
  f.presentation.applySnapshot(f.nextSnapshot({
    interactions: { focusedId: 'approve', pending: [approval, question], drafts: { ask: v2DraftState() }, recentlyResolved: [] },
  }))
  let payload = f.shown.at(-1)
  assert.equal(payload.requestId, 'approve')
  assert.match(payload.title, /还有 1 项/)
  assert.ok(payload.details.some(line => line.includes('实际参数')))
  f.presentation.applySnapshot(f.nextSnapshot({
    interactions: { focusedId: 'ask', pending: [approval, question], drafts: { ask: v2DraftState() }, recentlyResolved: [] },
  }))
  payload = f.shown.at(-1)
  assert.equal(payload.requestId, 'ask')
  assert.equal(payload.choices.length, 3)
  assert.equal(payload.progress, '')
  assert.equal(f.presentation.state().waiting, true)
  f.presentation.applySnapshot(f.nextSnapshot({
    interactions: { focusedId: null, pending: [question], drafts: { ask: v2DraftState() }, recentlyResolved: [] },
  }))
  assert.equal(f.shown.at(-1).requestId, 'ask')
  f.presentation.stop()
})

test('snapshot replay is stable; older snapshotSeq and old hostEpoch never roll the UI back', () => {
  const f = v2()
  const first = f.nextSnapshot({ notices: [v2Notice({ text: '第一条提示' })] })
  assert.equal(f.presentation.applySnapshot(first).applied, true)
  assert.equal(f.shown.at(-1).text, '第一条提示')
  const shownCount = f.shown.length
  assert.equal(f.presentation.applySnapshot(first).stale, true)
  assert.equal(f.shown.length, shownCount)
  const stale = { ...first, snapshotSeq: 0, notices: [v2Notice({ id: 'old', text: '不应出现' })] }
  assert.equal(f.presentation.applySnapshot(stale).applied, false)
  assert.equal(f.shown.at(-1).text, '第一条提示')
  assert.equal(f.presentation.applySnapshot({ ...first, snapshotSeq: 2 }).applied, true)
  assert.equal(f.shown.length, shownCount, 'a same-content snapshot must not duplicate the surface')
  f.presentation.applySnapshot(f.nextSnapshot({ hostEpoch: 'epoch-b', interactions: { focusedId: 'approve', pending: [v2Approval()], drafts: {}, recentlyResolved: [] } }))
  assert.equal(f.shown.at(-1).requestId, 'approve')
  assert.equal(f.presentation.applySnapshot({ ...first, hostEpoch: 'epoch-a', snapshotSeq: 99 }).applied, false)
  assert.equal(f.shown.at(-1).requestId, 'approve')
  f.presentation.stop()
})

test('notice UX timers only hide their own display; approvals and newer notices survive (B2-G11)', () => {
  const f = v2()
  f.presentation.applySnapshot(f.nextSnapshot({ notices: [v2Notice({ id: 'n1', text: '旧提示' })] }))
  assert.equal(f.shown.at(-1).text, '旧提示')
  assert.equal(f.timers.size, 1)
  const oldTimer = f.timerCallbacks()[0]
  f.presentation.applySnapshot(f.nextSnapshot({ notices: [], interactions: { focusedId: 'approve', pending: [v2Approval()], drafts: {}, recentlyResolved: [] } }))
  assert.equal(f.shown.at(-1).requestId, 'approve')
  oldTimer()
  assert.equal(f.shown.at(-1).requestId, 'approve', 'an expired notice timer must not hide a newer approval')
  const f2 = v2()
  f2.presentation.applySnapshot(f2.nextSnapshot({ notices: [v2Notice({ id: 'n1', text: '旧提示' })] }))
  const older = f2.timerCallbacks()[0]
  f2.presentation.applySnapshot(f2.nextSnapshot({ notices: [v2Notice({ id: 'n2', text: '新提示' })] }))
  assert.equal(f2.shown.at(-1).text, '新提示')
  older()
  assert.equal(f2.shown.at(-1).text, '新提示', 'the older timer must not hide the newer notice')
  f2.fireTimers()
  assert.ok(f2.hidden() > 0)
  const f3 = v2()
  f3.presentation.applySnapshot(f3.nextSnapshot({ notices: [v2Notice({ id: 'n1', text: '临时提示' })] }))
  const noticeTimer = f3.timerCallbacks()[0]
  f3.presentation.applySnapshot(f3.nextSnapshot({ inputDraft: v2InputDraft() }))
  assert.equal(f3.shown.at(-1).title, '我听到（尚未发送）')
  noticeTimer()
  assert.equal(f3.shown.at(-1).title, '我听到（尚未发送）', 'a notice timer must not hide a confirmation draft')
  f.presentation.stop(); f2.presentation.stop(); f3.presentation.stop()
})

test('v2 notice events apply to the last snapshot; notice.expired removes the projection', () => {
  const f = v2()
  f.presentation.applySnapshot(f.nextSnapshot({ snapshotSeq: 5 }))
  const at = f.presentation.state().snapshotSeq
  assert.equal(f.presentation.applyEvent({ protocolVersion: 'dsh-bot-v1', eventId: 'e1', hostEpoch: 'epoch-a', seq: at + 1, type: 'notice.added', data: { notice: v2Notice({ id: 'n9', text: '事件提示' }) } }).applied, true)
  assert.equal(f.shown.at(-1).text, '事件提示')
  assert.equal(f.presentation.applyEvent({ protocolVersion: 'dsh-bot-v1', eventId: 'e2', hostEpoch: 'epoch-a', seq: at + 2, type: 'notice.expired', data: { id: 'n9' } }).applied, true)
  assert.ok(f.hidden() > 0)
  f.presentation.stop()
})

test('v2 snapshot updates never overwrite text currently being edited (B2-G12)', async () => {
  const f = v2()
  // queue edit
  f.presentation.applySnapshot(f.nextSnapshot({ queue: { revision: 3, items: [v2QueueItem({ id: 'q1', text: '旧文本' })] } }))
  await f.presentation.manageQueue()
  f.presentation.action({ type: 'choice', requestId: 'queue:3', id: 'q1' })
  await f.presentation.action({ type: 'secondary', requestId: 'queue:3', id: 'queue-edit' })
  assert.equal(f.shown.at(-1).input.value, '旧文本')
  f.presentation.applySnapshot(f.nextSnapshot({ queue: { revision: 4, items: [v2QueueItem({ id: 'q1', text: 'Host 侧新文本' })] } }))
  assert.equal('value' in f.shown.at(-1).input, false, 'a snapshot must not reseed an open queue editor')
  await f.presentation.action({ type: 'input', requestId: 'queue:4', value: '用户改写' })
  assert.deepEqual(f.commands.pop(), ['queue.edit', { revision: 4, id: 'q1', text: '用户改写' }])
  f.presentation.stop()
  // input draft edit
  const f2 = v2()
  f2.presentation.applySnapshot(f2.nextSnapshot({ inputDraft: v2InputDraft() }))
  assert.equal(f2.shown.at(-1).title, '我听到（尚未发送）')
  await f2.presentation.action({ type: 'secondary', requestId: 'voice:d1', id: 'voice-edit' })
  assert.equal(f2.shown.at(-1).input.value, '这说不清楚')
  f2.presentation.applySnapshot(f2.nextSnapshot({ inputDraft: v2InputDraft({ revision: 4, text: 'Host 更新后' }) }))
  assert.equal('value' in f2.shown.at(-1).input, false, 'a snapshot must not overwrite the draft editor')
  assert.match(f2.shown.at(-1).hint, /Host 已更新/)
  await f2.presentation.action({ type: 'input', requestId: 'voice:d1', value: '用户纠正' })
  assert.deepEqual(f2.commands.pop(), ['input.confirm', { id: 'd1', revision: 4, text: '用户纠正' }])
  f2.presentation.stop()
  // custom answer text + semantic conflict keeps the user text and never silently maps it
  const f3 = v2()
  f3.presentation.applySnapshot(interactionSnapshot(f3, [v2Question()], { choose: v2DraftState() }))
  await f3.presentation.action({ type: 'secondary', requestId: 'choose', id: 'other' })
  assert.equal(f3.shown.at(-1).input.value, '')
  f3.presentation.applySnapshot(interactionSnapshot(f3, [v2Question({ viewRevision: 2 })], { choose: v2DraftState({ updatedAt: '2026-10-30T00:00:01.000Z' }) }))
  assert.equal('value' in f3.shown.at(-1).input, false, 'a view-only snapshot update must not reset typed text')
  f3.presentation.applySnapshot(interactionSnapshot(f3, [v2Question({ semanticRevision: 2 })], {
    choose: { semanticRevision: 2, selectionRevision: 0, answers: { drink: { selected: [] } }, updatedAt: '2026-10-30T00:00:02.000Z' },
  }))
  const conflict = f3.shown.at(-1)
  assert.ok(conflict.input, 'the custom editor stays open on a semantic change')
  assert.equal('value' in conflict.input, false)
  assert.match(conflict.hint, /问题已更新/)
  assert.equal(f3.commands.length, 0, 'a semantic change must not submit old answers')
  await f3.presentation.action({ type: 'input', requestId: 'choose', value: '我的自定义回答' })
  const resolve = f3.commands.pop()
  assert.deepEqual(resolve, ['interaction.resolve', { interactionId: 'choose', semanticRevision: 2, answer: { answers: [{ id: 'drink', selected: [], custom: '我的自定义回答' }] } }])
  f3.presentation.stop()
})

test('v2 queue manager edit/delete/confirm go through revision-bound queue commands', async () => {
  const f = v2()
  const items = [
    v2QueueItem({ id: 'q1', text: '第一项', needsConfirmation: true, status: 'confirming' }),
    v2QueueItem({ id: 'q2', text: '第二项', position: 2 }),
  ]
  f.presentation.applySnapshot(f.nextSnapshot({ queue: { revision: 3, items } }))
  await f.presentation.manageQueue()
  let payload = f.shown.at(-1)
  assert.equal(payload.title, '等待输入 · 2')
  assert.match(payload.choices[0].description, /第 1 位 · 已等 5 秒 · 待确认/)
  await f.presentation.action({ type: 'choice', requestId: 'queue:3', id: 'q1' })
  assert.match(f.shown.at(-1).hint, /需要重新确认/)
  await f.presentation.action({ type: 'secondary', requestId: 'queue:3', id: 'queue-edit' })
  await f.presentation.action({ type: 'input', requestId: 'queue:3', value: '改写后的第一项' })
  assert.deepEqual(f.commands.pop(), ['queue.edit', { revision: 3, id: 'q1', text: '改写后的第一项' }])
  f.presentation.applySnapshot(f.nextSnapshot({ queue: { revision: 4, items: [v2QueueItem({ id: 'q1', text: '改写后的第一项' }), v2QueueItem({ id: 'q2', text: '第二项', position: 2 })] } }))
  await f.presentation.action({ type: 'secondary', requestId: 'queue:4', id: 'queue-confirm' })
  assert.deepEqual(f.commands.pop(), ['queue.confirm', { revision: 4, id: 'q1' }])
  await f.presentation.action({ type: 'secondary', requestId: 'queue:4', id: 'queue-back' })
  await f.presentation.action({ type: 'choice', requestId: 'queue:4', id: 'q2' })
  await f.presentation.action({ type: 'secondary', requestId: 'queue:4', id: 'queue-delete' })
  assert.deepEqual(f.commands.pop(), ['queue.delete', { revision: 4, id: 'q2' }])
  f.presentation.stop()
})

test('v2 input draft confirm/edit/reject map to input.* commands', async () => {
  for (const [actionId, expected] of [
    ['voice-confirm', ['input.confirm', { id: 'd1', revision: 3 }]],
    ['voice-discard', ['input.reject', { id: 'd1', revision: 3 }]],
  ]) {
    const f = v2()
    f.presentation.applySnapshot(f.nextSnapshot({ inputDraft: v2InputDraft() }))
    assert.equal(f.shown.at(-1).title, '我听到（尚未发送）')
    assert.match(f.shown.at(-1).hint, /尚未发送/)
    await f.presentation.action({ type: 'secondary', requestId: 'voice:d1', id: actionId })
    assert.deepEqual(f.commands.pop(), expected)
    f.presentation.stop()
  }
  const f = v2()
  f.presentation.applySnapshot(f.nextSnapshot({ inputDraft: v2InputDraft() }))
  await f.presentation.action({ type: 'secondary', requestId: 'voice:d1', id: 'voice-edit' })
  await f.presentation.action({ type: 'input', requestId: 'voice:d1', value: '纠正后的内容' })
  assert.deepEqual(f.commands.pop(), ['input.confirm', { id: 'd1', revision: 3, text: '纠正后的内容' }])
  // The Host removes the confirmed draft; the projection closes with it (no local timer).
  f.presentation.applySnapshot(f.nextSnapshot({ inputDraft: null }))
  assert.ok(f.hidden() > 0)
  f.presentation.stop()
})

test('v2 multi-select uses set-selected and submit binds the confirmed selectionRevision', async () => {
  const f = v2()
  const question = v2Question({
    questions: [{ id: 'drink', header: '', question: '喝什么？', detail: '', multiSelect: true, options: [OPTION('official:latte', '拿铁'), OPTION('official:americano', '美式')] }],
  })
  const drafts = { choose: { semanticRevision: 1, selectionRevision: 2, answers: { drink: { selected: [] } }, updatedAt: '2026-10-30T00:00:00.000Z' } }
  f.presentation.applySnapshot(f.nextSnapshot({ interactions: { focusedId: 'choose', pending: [question], drafts, recentlyResolved: [] } }))
  await f.presentation.action({ type: 'choice', requestId: 'choose', id: '0' })
  assert.deepEqual(f.commands.pop(), ['interaction.draft.select', { interactionId: 'choose', semanticRevision: 1, selectionRevision: 2, questionId: 'drink', optionId: 'official:latte', selected: true }])
  assert.equal(f.shown.at(-1).choices[0].selected, true)
  await f.presentation.action({ type: 'choice', requestId: 'choose', id: '0' })
  assert.deepEqual(f.commands.pop(), ['interaction.draft.select', { interactionId: 'choose', semanticRevision: 1, selectionRevision: 3, questionId: 'drink', optionId: 'official:latte', selected: false }])
  await f.presentation.action({ type: 'choice', requestId: 'choose', id: '1' })
  f.commands.pop()
  const seq = f.presentation.state().snapshotSeq
  f.presentation.applyEvent({
    protocolVersion: 'dsh-bot-v1', eventId: 'e1', hostEpoch: 'epoch-a', seq: seq + 1, type: 'interaction.draft.changed',
    data: { id: 'choose', interactionId: 'choose', kind: 'question', semanticRevision: 1, selectionRevision: 5, answers: { drink: { selected: ['official:americano'] } } },
  })
  await f.presentation.action({ type: 'secondary', requestId: 'choose', id: 'submit' })
  assert.deepEqual(f.commands.pop(), ['interaction.resolve', {
    interactionId: 'choose', semanticRevision: 1, selectionRevision: 5,
    answer: { answers: [{ id: 'drink', selected: ['official:americano'] }] },
  }])
  f.presentation.stop()
})

test('v2 multi-question progress comes from Host drafts and submits one complete batch (B2-G12)', async () => {
  const f = v2()
  const questions = [
    { id: 'drink', header: '', question: '喝什么？', detail: '', multiSelect: false, options: [OPTION('official:latte', '拿铁'), OPTION('official:tea', '茶')] },
    { id: 'note', header: '', question: '加什么？', detail: '', multiSelect: false, options: [OPTION('official:sugar', '糖'), OPTION('official:milk', '奶')] },
  ]
  const interaction = v2Question({ id: 'choose', questions })
  const drafts = { choose: { semanticRevision: 1, selectionRevision: 4, answers: { drink: { selected: ['official:tea'] }, note: { selected: [] } }, updatedAt: '2026-10-30T00:00:00.000Z' } }
  f.presentation.applySnapshot(f.nextSnapshot({ interactions: { focusedId: 'choose', pending: [interaction], drafts, recentlyResolved: [] } }))
  assert.equal(f.shown.at(-1).progress, '2 / 2')
  await f.presentation.action({ type: 'choice', requestId: 'choose', id: '1' })
  assert.deepEqual(f.commands.pop(), ['interaction.resolve', {
    interactionId: 'choose', semanticRevision: 1,
    answer: { answers: [{ id: 'drink', selected: ['official:tea'] }, { id: 'note', selected: ['official:milk'] }] },
  }])
  f.presentation.stop()
})

test('every visible v2 button has a real result and in-flight submits are serialized (B2-G12)', async () => {
  const known = new Set([
    'grant-confirm', 'grant-back', 'other', 'back', 'skip', 'submit', 'voice-confirm', 'voice-edit', 'voice-discard',
    'queue-close', 'queue-back', 'queue-edit', 'queue-confirm', 'queue-delete', 'open', 'inspect-task', 'recover-task',
    'retry-voice', 'confirm-input', 'cancel-input', 'close',
  ])
  const assertButtons = (payload) => {
    // Secondary buttons map to named actions; choices are option indexes / queue item ids.
    for (const button of payload.secondary || []) {
      assert.ok(known.has(button.id), `unknown secondary button ${button.id}`)
      assert.ok(button.label, `secondary button ${button.id} needs a label`)
    }
    for (const button of payload.choices || []) {
      assert.ok(button.id !== undefined && button.id !== '', 'choice buttons need a target id')
      assert.ok(button.label, 'choice buttons need a label')
    }
  }
  // approval: persistent grant + allow/reject all produce a command receipt
  let f = v2()
  f.presentation.applySnapshot(interactionSnapshot(f, [v2Approval()]))
  assertButtons(f.shown.at(-1))
  await f.presentation.action({ type: 'secondary', requestId: 'approve', id: 'grant-confirm' })
  assert.equal(f.commands.length, 0)
  assert.equal(f.shown.at(-1).approval.allowLabel, '确认持续允许')
  await f.presentation.action({ type: 'approval', requestId: 'approve', decision: 'allow' })
  assert.deepEqual(f.commands.pop(), ['/approval', { id: 'approve', sessionId: 's', decision: 'always-allow', confirmExact: true }])
  for (const [decision, expected] of [['allow', 'allowed-once'], ['reject', 'rejected']]) {
    f = v2()
    f.presentation.applySnapshot(interactionSnapshot(f, [v2Approval()]))
    await f.presentation.action({ type: 'approval', requestId: 'approve', decision })
    assert.deepEqual(f.commands.pop(), ['interaction.resolve', { interactionId: 'approve', semanticRevision: 2, decision: expected }])
  }
  // every rendered question option resolves to a complete answer batch
  for (const [index, optionId] of ['official:latte', 'official:americano', 'official:tea'].entries()) {
    f = v2()
    f.presentation.applySnapshot(interactionSnapshot(f, [v2Question()], { choose: v2DraftState() }))
    assertButtons(f.shown.at(-1))
    await f.presentation.action({ type: 'choice', requestId: 'choose', id: String(index) })
    assert.deepEqual(f.commands.pop(), ['interaction.resolve', { interactionId: 'choose', semanticRevision: 1, answer: { answers: [{ id: 'drink', selected: [optionId] }] } }])
  }
  // input draft buttons
  f = v2()
  f.presentation.applySnapshot(f.nextSnapshot({ inputDraft: v2InputDraft() }))
  assertButtons(f.shown.at(-1))
  // notice actions map to desktop actions and unknown ids are dropped (no dead buttons)
  f = v2()
  f.presentation.applySnapshot(f.nextSnapshot({ notices: [v2Notice({ actions: [{ id: 'open-main', label: '打开主窗口' }, { id: 'definitely-not-handled', label: '死按钮' }] })] }))
  assert.deepEqual(f.shown.at(-1).secondary, [{ id: 'open', label: '打开主窗口' }])
  await f.presentation.action({ type: 'secondary', id: 'open' })
  assert.deepEqual(f.commands.pop(), ['open'])
  // busy: a second click while a submission is in flight sends nothing
  let release
  f = v2({ send: () => new Promise(resolve => { release = resolve }) })
  f.presentation.applySnapshot(interactionSnapshot(f, [v2Question()], { choose: v2DraftState() }))
  const pending = f.presentation.action({ type: 'choice', requestId: 'choose', id: '0' })
  assert.equal(f.shown.at(-1).busy, true)
  await f.presentation.action({ type: 'choice', requestId: 'choose', id: '1' })
  assert.equal(f.commands.length, 1)
  release({ status: 'accepted', result: {} })
  await pending
  assert.equal(f.shown.at(-1).busy, false)
  f.presentation.stop()
})

test('long options, Markdown text and approval details reach the bubble renderer intact (B2-G12)', () => {
  const longLabel = '选项'.repeat(400)
  const question = v2Question({
    questions: [{
      id: 'drink', header: '**标题**', question: '请阅读：\n\n- 第一项\n- 第二项\n\n`code`', detail: '补充说明',
      multiSelect: false, options: [OPTION('official:long', longLabel), OPTION('official:short', '短')],
    }],
  })
  const f = v2()
  const operation = { toolName: 'write', cwd: '/outside', arguments: { path: '/outside/report.md', content: 'x'.repeat(500) } }
  f.presentation.applySnapshot(interactionSnapshot(f, [v2Approval({ operation })]))
  const approval = f.shown.at(-1)
  assert.match(approval.text, /写入或修改/)
  assert.ok(approval.details.some(line => line.includes('/outside/report.md')))
  assert.ok(approval.details.some(line => line.includes('实际参数')))
  f.presentation.applySnapshot(interactionSnapshot(f, [question], { choose: v2DraftState() }))
  const payload = f.shown.at(-1)
  assert.ok(payload.text.includes('- 第一项'))
  assert.ok(payload.text.includes('`code`'))
  assert.equal(payload.title, '**标题**')
  assert.equal(payload.choices.length, 2)
  assert.equal(payload.choices[0].label.length, 800)
  assert.equal(payload.choices[1].label, '短')
  for (const key of ['visible', 'kind', 'requestId', 'busy', 'clickThrough']) assert.ok(key in payload)
  f.presentation.stop()
})

test('v2 capture preview is a projection: cancel sends control.cancel-capture only for the shown capture', async () => {
  const f = v2()
  f.presentation.applySnapshot(f.nextSnapshot({ capture: { state: 'listening', mode: 'hold', captureId: 'cap-1', preview: { text: '正在说的话', revision: 1 } } }))
  const payload = f.shown.at(-1)
  assert.equal(payload.kind, 'input')
  assert.equal(payload.text, '正在说的话')
  assert.equal(payload.cancel.id, 'cancel-capture')
  await f.presentation.action({ type: 'cancel', id: 'cancel-capture', requestId: 'stale-capture' })
  assert.equal(f.commands.length, 0)
  await f.presentation.action({ type: 'cancel', id: 'cancel-capture', requestId: 'cap-1' })
  assert.deepEqual(f.commands.pop(), ['control.cancel-capture', { captureId: 'cap-1' }])
  f.presentation.applySnapshot(f.nextSnapshot({ capture: { state: 'off', captureId: null, preview: null } }))
  assert.ok(f.hidden() > 0)
  f.presentation.stop()
})

test('v2 events drive reply/tool display and request resync on gaps or epoch changes', () => {
  const f = v2()
  f.presentation.applySnapshot(f.nextSnapshot({ snapshotSeq: 10, execution: { state: 'working', inputSource: 'voice', startedAt: '2026-10-30T00:00:00.000Z', lastTurn: null } }))
  let seq = 10
  const ev = (type, data = {}) => {
    seq += 1
    return { protocolVersion: 'dsh-bot-v1', eventId: `e${seq}`, hostEpoch: 'epoch-a', seq, type, source: 'dsh', sessionId: 's', turn: 1, causedByCommandId: null, at: '2026-10-30T00:00:01.000Z', data }
  }
  assert.equal(f.presentation.applyEvent(ev('turn.started', { inputSource: 'voice' })).applied, true)
  assert.equal(f.presentation.applyEvent(ev('turn.delta', { text: '你' })).applied, true)
  assert.equal(f.presentation.applyEvent(ev('turn.delta', { text: '好' })).applied, true)
  assert.equal(f.shown.at(-1).text, '你好')
  assert.equal(f.presentation.applyEvent(ev('turn.tool', { phase: 'call', name: 'read', argumentsPreview: '{"path":"notes.md"}' })).applied, true)
  assert.equal(f.shown.at(-1).kind, 'activity')
  assert.match(f.shown.at(-1).text, /notes\.md/)
  const lastEventSeq = seq
  assert.equal(f.presentation.applyEvent({ ...ev('turn.delta', { text: '重复' }), seq: lastEventSeq }).duplicate, true)
  const gap = f.presentation.applyEvent({ ...ev('turn.delta', { text: '缺口' }), seq: seq + 5 })
  assert.equal(gap.resync, true)
  const epoch = f.presentation.applyEvent({ ...ev('turn.delta', { text: '旧 epoch' }), hostEpoch: 'epoch-stale' })
  assert.equal(epoch.resync, true)
  f.presentation.stop()
  // readable hold after a clean turn end, then a higher-priority interaction replaces it
  const g = v2()
  g.presentation.applySnapshot(g.nextSnapshot({ snapshotSeq: 20 }))
  let gseq = 20
  const gev = (type, data = {}) => {
    gseq += 1
    return { protocolVersion: 'dsh-bot-v1', eventId: `g${gseq}`, hostEpoch: 'epoch-a', seq: gseq, type, source: 'dsh', sessionId: 's', turn: 2, causedByCommandId: null, at: '2026-10-30T00:00:02.000Z', data }
  }
  g.presentation.applyEvent(gev('turn.started'))
  g.presentation.applyEvent(gev('turn.delta', { text: '一条回答' }))
  g.presentation.applyEvent(gev('turn.ended', { terminal: 'completed', reason: { kind: 'completed' } }))
  assert.equal(g.shown.at(-1).text, '一条回答')
  assert.ok(g.timers.size > 0, 'a finished reply keeps a readable hold timer')
  g.presentation.applySnapshot(g.nextSnapshot({ snapshotSeq: gseq + 1, interactions: { focusedId: 'approve', pending: [v2Approval()], drafts: {}, recentlyResolved: [] } }))
  assert.equal(g.shown.at(-1).requestId, 'approve')
  g.presentation.stop()
})
