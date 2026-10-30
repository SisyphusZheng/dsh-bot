/** Real Chromium rendering of shipped pet/bubble pages driven by the v2 Host snapshot/event contract.
 *  The v2 fixture below stands in for the Host: applySnapshot(snapshot@1) + versioned applyEvent().
 *  IPC is an explicit fixture; this is renderer evidence, not native macOS acceptance. */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPetExperience } from '../pet/src/experience-runtime.mjs'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { createCompanionPresentation } from '../pet/src/companion-presentation.mjs'
import { ORB_BUBBLE_WINDOW_HEIGHT, ORB_BUBBLE_WINDOW_WIDTH } from '../pet/src/bubble-window.mjs'
const fixtureHeight = ORB_BUBBLE_WINDOW_HEIGHT + 170
const root=resolve(import.meta.dirname,'../..'),resources=join(root,'apps/desktop/resources')
const {chromium}=createRequire(join(root,'packages/experimental/inspector/package.json'))('playwright')
const output=process.env.DSH_PET_EVIDENCE_DIR||join(root,'.mvv-build/evidence/pet-ui');mkdirSync(output,{recursive:true})
const files=new Map(['pet.html','voice-client.js','bubble.html','bubble.css','bubble.js','bubble-markdown.js'].map(name=>['/'+name,join(resources,'pet',name)]))
files.set('/skins/whale-girl/pet.json',join(resources,'whale-girl/pet.json'));files.set('/skins/whale-girl/spritesheet.webp',join(resources,'whale-girl/spritesheet.webp'))
const server=createServer((req,res)=>{
 if(req.url==='/fixture') {res.setHeader('content-type','text/html');res.end(`<!doctype html><style>html,body{margin:0;width:420px;height:${fixtureHeight}px;background:#eef0f3}iframe{position:absolute;border:0;background:transparent}#bubble{left:20px;top:0;width:${ORB_BUBBLE_WINDOW_WIDTH}px;height:${ORB_BUBBLE_WINDOW_HEIGHT}px}#pet{left:124px;top:${ORB_BUBBLE_WINDOW_HEIGHT-42}px;width:172px;height:204px}</style><iframe id="pet" src="/pet.html"></iframe><iframe id="bubble" src="/bubble.html"></iframe>`);return}
 const file=files.get(req.url);if(!file){res.writeHead(404);res.end();return}
 res.setHeader('content-type',file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'image/webp');res.end(readFileSync(file))
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const home=mkdtempSync(join(tmpdir(),'pet-ui-'))
const iso = () => new Date().toISOString()
const HOST_EPOCH = 'ui-epoch'
let experience;let browser,presentation,renders=Promise.resolve()
try {
 browser=await chromium.launch({headless:true,...(process.env.DSH_CHROMIUM_EXECUTABLE?{executablePath:process.env.DSH_CHROMIUM_EXECUTABLE}:{}),args:process.platform==='linux'?['--no-sandbox','--single-process','--no-zygote','--disable-gpu','--disable-dev-shm-usage']:[]})
 const context=await browser.newContext({viewport:{width:420,height:fixtureHeight},deviceScaleFactor:2,reducedMotion:'reduce'}),errors=[],calls=[]
 await context.exposeBinding('bubbleAction',async(_source,action)=>{if(!await experience?.action(action))return presentation.action(action)})
 await context.addInitScript(()=>{
  window.petBridge={state:async()=>({phase:'unconfigured'}),voiceStatus(){},onVoice(){},onVoiceCommand(){},onPresentation:fn=>{window.receivePresentation=fn},hit(){},dragStart(){},dragMove(){},dragEnd(){},openMain(){},menu(){}}
  window.petBubble={onUpdate:fn=>{window.receiveBubble=fn},action:value=>window.bubbleAction(value),setInteractive(){},requestInputFocus(){},resize:value=>{(window.__resizeCalls||=[]).push(value); const frame=window.parent.document.getElementById('bubble'); if(frame){ const height=Math.max(118,Math.min(420,value)); frame.style.height=height+'px'; frame.style.top=(420-height)+'px' }},openDsh(){}}
 })
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message))
 await page.goto(`http://127.0.0.1:${server.address().port}/fixture`)
 const pet=page.frames().find(frame=>frame.url().endsWith('/pet.html')),bubble=page.frames().find(frame=>frame.url().endsWith('/bubble.html'))
 assert.ok(pet&&bubble)
 await pet.waitForSelector('canvas')
 await pet.waitForFunction(()=>document.querySelector('canvas')?.getContext('2d').getImageData(0,0,192,208).data.some((value,index)=>index%4===3&&value>0))
 assert.equal(await pet.locator('#microphone').count(),1)
 await page.mouse.move(0,0);assert.equal(await pet.locator('#controls').evaluate(el=>getComputedStyle(el).opacity),'0')
 await pet.locator('#pet').hover();await pet.waitForFunction(()=>getComputedStyle(document.getElementById('controls')).opacity==='1')
 assert.ok(await pet.locator('#microphone').isEnabled());await page.mouse.move(0,0)
 await bubble.waitForFunction(()=>getComputedStyle(document.getElementById('bubble')).opacity==='0')
 renders=Promise.resolve()
 // The shipped pet-runtime send() lands on the Host v2 command endpoint; the fixture records the exact type+payload.
 presentation=createCompanionPresentation({show:payload=>{renders=renders.then(()=>bubble.evaluate(p=>window.receiveBubble(p),payload))},hide:()=>{renders=renders.then(()=>bubble.evaluate(()=>window.receiveBubble({visible:false})))},animate:payload=>{renders=renders.then(()=>pet.evaluate(p=>window.receivePresentation(p),payload))},send:async(...args)=>{calls.push(args);if(args[0]==='/task/recovery'&&!args[1])return{token:'ui-recovery',originalText:'整理报告并核对已完成步骤',warning:'原操作可能已执行，请先检查副作用。'};if(args[0]==='/task/recovery')return{ok:true};if(args[0]==='/approval')return{ok:true};return{status:'accepted',commandId:`ui-${calls.length}`}}})
 // One monotonic counter feeds snapshotSeq and event seq: a snapshot installs
 // lastEventSeq = snapshotSeq, so the next event must be snapshotSeq + 1.
 let lastSeq = 500
 const nextSeq = () => ++lastSeq
 const baseSnapshot = extra => ({
  protocolVersion:'dsh-bot-v1', schema:'snapshot@1', hostEpoch:HOST_EPOCH, snapshotSeq:nextSeq(), generatedAt:iso(),
  identity:{product:'dsh-bot',productVersion:'0.0.1-beta2',runtimeVersion:'0.2.1-rc.3',sessionId:'ui-session',botSessionReady:true,workspace:'/tmp/ui',conversationIndex:1,hostPid:123},
  connection:{worker:{state:'disconnected',connectionId:null,lastSeenAt:null},desktop:{connected:true,lastEventSeq:0,lastSeenAt:iso()}},
  capture:{state:'off',mode:'hold',captureId:null,connectionId:null,preview:null},
  playback:{state:'idle',playbackId:null,sourceTurnId:null,style:'full'},
  execution:{state:'idle',sessionId:'ui-session',requestId:null,clientTurnId:null,turn:null,startedAt:null,inputSource:'desktop',lastTurn:{turn:null,terminal:null,reason:null}},
  interactions:{focusedId:null,pending:[],drafts:{},recentlyResolved:[]},
  inputDraft:null, queue:{revision:0,items:[]}, notices:[],
  presentation:{displayMode:'idle',priority:['interactions','inputDraft','queue','execution','playback','notices'],bubble:{visible:false,requestId:null,kind:null},bubblePolicy:{placement:'above',anchorGapPx:24}},
  ...extra,
 })
 const syncV2 = extra => { presentation.applySnapshot(baseSnapshot(extra)); return renders }
 const syncInteraction = (pending,drafts={}) => { presentation.applySnapshot(baseSnapshot({interactions:{focusedId:pending[0]?.id??null,pending,drafts,recentlyResolved:[]}})); return renders }
 const question = (id,questions) => ({id,kind:'question',sessionId:'ui-session',semanticRevision:1,viewRevision:1,officialCallId:`call-${id}`,createdAt:iso(),expiresAt:null,operation:null,questions})
 const approval = (id,extra={}) => ({id,kind:'approval',sessionId:'ui-session',semanticRevision:1,viewRevision:1,officialCallId:`call-${id}`,createdAt:iso(),expiresAt:null,operation:null,toolName:'write',reason:'write outside workspace: /Users/example/Downloads/report.md',...extra})
 const emitEvent = (type,data={}) => presentation.applyEvent({protocolVersion:'dsh-bot-v1',hostEpoch:HOST_EPOCH,seq:nextSeq(),type,data})
 await page.screenshot({path:join(output,'idle.png')})

 // ---- question: single question, official option ids, click resolves through the Host v2 draft/submit path.
 await syncInteraction([question('choice',[{id:'destination',question:'这次旅行想去哪里？',options:[{id:'opt-hz',label:'杭州',description:'西湖边散步，行程轻松。'},{id:'opt-sh',label:'上海'},{id:'opt-sz',label:'苏州'},{id:'opt-nj',label:'南京'},{id:'opt-none',label:'暂时不去'}]}])])
 await bubble.getByRole('button',{name:'暂时不去',exact:true}).waitFor()
 assert.equal(await bubble.locator('#bubble-choices button').count(),5)
 await page.screenshot({path:join(output,'choice.png')})
 await bubble.getByRole('button',{name:'苏州',exact:true}).click();await renders
 assert.deepEqual(calls.at(-1),['interaction.resolve',{interactionId:'choice',semanticRevision:1,answer:{answers:[{id:'destination',selected:['opt-sz']}]}}])
 await bubble.getByText(/已提交/).waitFor()

 // ---- markdown reply arrives as versioned turn events, not a legacy REST payload.
 presentation.applySnapshot(baseSnapshot())
 await renders
 const report='## 执行结果\n\n**完成**，保留 `code`。\n\n- 第一项\n- 第二项\n\n'+'详细结果。'.repeat(120)+'最后一行。'
 emitEvent('turn.started',{turnId:'turn-ui'})
 emitEvent('turn.delta',{text:report})
 emitEvent('turn.ended',{terminal:'completed'})
 await renders
 assert.equal(await bubble.locator('#bubble-text strong').textContent(),'完成')
 assert.equal(await bubble.locator('#bubble-text code').textContent(),'code')
 assert.equal(await bubble.locator('#bubble-text li').count(),2)
 assert.ok((await bubble.locator('#bubble-text').textContent()).endsWith('最后一行。'))
 await page.screenshot({path:join(output,'markdown.png')})

 // ---- multi-select: interaction.draft.select (set-selected, Host selectionRevision) then one resolve.
 const longOptions=[{id:'opt-read',label:'允许只读检查当前工作区的配置与日志'},{id:'opt-skip',label:'保持现有设置并暂时跳过本次操作'},{id:'opt-explain',label:'先解释这几个选项之间的差异'}]
 await syncInteraction([question('layout',[{id:'long',multiSelect:true,question:'**下一步怎么处理？**\n\n请确认范围；可以多选，也可以填写其他回答。',options:longOptions.map(option=>({...option,description:'完整说明需要换行显示，不应把文字裁切成省略号。'}))}])],{layout:{semanticRevision:1,selectionRevision:2,answers:{}}})
 await bubble.getByRole('button',{name:'提交',exact:true}).waitFor({state:'visible'})
 assert.equal(await bubble.locator('#bubble-progress').isHidden(),true,'single question must not show 1 / 1')
 assert.equal(await bubble.getByRole('button',{name:'在 DSH 中查看',exact:true}).count(),0)
 const geometry=await bubble.evaluate(()=>{
  const card=document.getElementById('bubble-card'), footer=[...document.querySelectorAll('#bubble-secondary button')].find(el=>el.textContent==='提交'), r=card.getBoundingClientRect(), f=footer.getBoundingClientRect()
  return {top:r.top,bottom:r.bottom,viewport:innerHeight,footerTop:f.top,footerBottom:f.bottom,cardOverflow:card.scrollHeight>card.clientHeight+1,labels:[...document.querySelectorAll('.choice')].every(el=>el.scrollHeight<=el.clientHeight+1)}
 })
 assert.ok(geometry.top>=0&&geometry.bottom<=geometry.viewport,JSON.stringify(geometry))
 assert.ok(geometry.footerTop>=geometry.top&&geometry.footerBottom<=geometry.bottom,JSON.stringify(geometry))
 assert.equal(geometry.cardOverflow,false,JSON.stringify(geometry));assert.equal(geometry.labels,true)
 writeFileSync(join(output,'layout.json'),JSON.stringify({geometry,snapshot:'snapshot@1',scope:'Shipped renderer in Chromium driven by v2 snapshots + versioned events; explicit IPC fixture; not native macOS acceptance'},null,2)+'\n')
 const option=bubble.getByRole('button',{name:new RegExp('^'+longOptions[0].label)})
 const box=await option.boundingBox();assert.ok(box)
 await option.hover();await page.mouse.down()
 assert.notEqual(await option.evaluate(el=>getComputedStyle(el).boxShadow),'none','Pointer down has no feedback')
 await page.mouse.up()
 await bubble.waitForFunction(()=>document.querySelector('#bubble-choices button')?.getAttribute('aria-pressed')==='true',null,{timeout:3000})
 await renders
 assert.equal(await option.getAttribute('aria-pressed'),'true')
 assert.deepEqual(calls.at(-1),['interaction.draft.select',{interactionId:'layout',semanticRevision:1,selectionRevision:2,questionId:'long',optionId:'opt-read',selected:true}])
 await page.screenshot({path:join(output,'choice-selected.png')})
 // Host confirms the draft with a newer selectionRevision; a submit must bind that confirmed revision.
 emitEvent('interaction.draft.changed',{interactionId:'layout',semanticRevision:1,selectionRevision:3,answers:{long:{selected:['opt-read']}}})
 await renders
 await bubble.getByRole('button',{name:'其他回答',exact:true}).click();await renders
 await bubble.getByPlaceholder('输入你的回答').fill('保留完整结果')
 await bubble.getByRole('button',{name:'提交',exact:true}).click();await renders
 const multiResolve=calls.at(-1)
 assert.equal(multiResolve[0],'interaction.resolve')
 assert.equal(multiResolve[1].interactionId,'layout')
 assert.equal(multiResolve[1].semanticRevision,1)
 assert.equal(multiResolve[1].answer.answers.length,1)
 assert.equal(multiResolve[1].answer.answers[0].id,'long')
 assert.equal(multiResolve[1].answer.answers[0].custom,'保留完整结果')
 // set-selected was already asserted above on interaction.draft.select; a free-text answer
 // carries custom text and does not fabricate new option ids.

 // ---- long option text / fixed footer with the real native-sized viewport.
 const description='扩到约 500 字，装进新建的 Word 文档。'.repeat(35)+'完整说明结尾'
 await syncInteraction([question('overflow',[{id:'document',header:'文档内容',question:'要写的五百字用什么内容？',multiSelect:true,options:[{id:'opt-prev',label:'用之前那篇《慢一点也没关系》（推荐）',description},{id:'opt-new',label:'写一篇新的内容',description:'第二个选项的完整说明'}]}])])
 await bubble.getByRole('button',{name:/^用之前那篇/}).waitFor()
 await bubble.waitForFunction(()=>document.querySelector('#bubble-content').scrollHeight>document.querySelector('#bubble-content').clientHeight)
 await bubble.locator('#bubble-scroll-hint').waitFor({state:'visible'})
 const longChoice=bubble.getByRole('button',{name:/^用之前那篇/})
 assert.ok((await longChoice.textContent()).endsWith('完整说明结尾'))
 await bubble.locator('#bubble-content').evaluate(el=>{el.scrollTop=el.scrollHeight})
 const longGeometry=await bubble.evaluate(()=>{const card=document.querySelector('#bubble-card').getBoundingClientRect(),button=[...document.querySelectorAll('#bubble-secondary button')].find(el=>el.textContent==='提交').getBoundingClientRect();return {top:card.top,bottom:card.bottom,footerBottom:button.bottom,viewport:innerHeight}})
 assert.ok(longGeometry.top>=0&&longGeometry.bottom<=longGeometry.viewport&&longGeometry.footerBottom<=longGeometry.bottom,JSON.stringify(longGeometry))
 await page.screenshot({path:join(output,'long-question-scroll.png')})
 await bubble.getByRole('button',{name:/^写一篇新的内容/}).click();await renders
 assert.equal(await bubble.getByRole('button',{name:/^写一篇新的内容/}).getAttribute('aria-pressed'),'true')
 await bubble.getByRole('button',{name:'提交',exact:true}).click();await renders
 assert.deepEqual(calls.at(-1)[1].answer.answers,[{id:'document',selected:['opt-new']}])

 // ---- inputDraft from the snapshot; typed edit text must survive an incoming notice (B2-G11).
 await syncV2({inputDraft:{id:'ui-draft',text:'这说不清楚',source:'voice',captureId:'capture-ui',createdAt:iso(),expiresAt:iso(),revision:3,status:'pending',needsConfirmation:true}})
 await bubble.getByText('我听到（尚未发送）',{exact:true}).waitFor()
 await bubble.getByRole('button',{name:'修改',exact:true}).click();await renders
 const editField=bubble.getByPlaceholder('纠正识别内容')
 await editField.fill('请整理报告')
 const typedBeforeNotice=await editField.inputValue()
 emitEvent('notice.added',{notice:{id:'n-edit-preserve',kind:'status',severity:'info',text:'新的临时提示',createdAt:iso(),expiresAt:null,diagnosticId:null,actions:[]}})
 await renders
 assert.equal(await editField.inputValue(),typedBeforeNotice,'in-progress edit text must survive an incoming snapshot/notice')
 await page.screenshot({path:join(output,'input-confirmation.png')})
 await bubble.getByRole('button',{name:'确认发送',exact:true}).click();await renders
 assert.deepEqual(calls.at(-1),['input.confirm',{id:'ui-draft',revision:3,text:'请整理报告'}])

 // ---- queue projection: queue.edit / queue.delete bound to the snapshot queue revision.
 await syncV2({queue:{revision:1,items:[{id:'queued-ui',text:'请整理报告',position:1,source:'voice',createdAt:iso(),waitedSeconds:63,expiresAt:iso(),needsConfirmation:true,status:'waiting'}]}})
 await presentation.manageQueue();await renders
 await bubble.getByRole('button',{name:/^请整理报告/}).click();await renders
 await bubble.getByRole('button',{name:'修改',exact:true}).click();await renders
 await bubble.getByPlaceholder('修改等待输入').fill('请整理最新报告')
 await bubble.getByRole('button',{name:'保存并确认',exact:true}).click();await renders
 assert.deepEqual(calls.at(-1),['queue.edit',{revision:1,id:'queued-ui',text:'请整理最新报告'}])
 await syncV2({queue:{revision:2,items:[{id:'queued-ui',text:'请整理最新报告',position:1,source:'voice',createdAt:iso(),waitedSeconds:64,expiresAt:iso(),needsConfirmation:false,status:'waiting'}]}})
 await renders
 await bubble.getByRole('button',{name:'删除这条',exact:true}).click();await renders
 assert.deepEqual(calls.at(-1),['queue.delete',{revision:2,id:'queued-ui'}])
 await syncV2({queue:{revision:3,items:[]}})
 await renders
 await bubble.getByRole('button',{name:'关闭',exact:true}).click();await renders

 // ---- captures are media-level: recording cancellation must never cancel the Agent task.
 const callsBeforeCancel=calls.length
 await presentation.action({type:'cancel',id:'cancel-capture',requestId:'silent'})
 await renders
 assert.ok(!calls.some(call=>call[0]==='/cancel'||call[0]==='control.cancel-task'),'recording cancellation never cancels the Agent task')
 assert.equal(calls.length,callsBeforeCancel,'a stale capture cancel emits no command at all')

 // ---- approval via v2: interaction.resolve allowed-once / rejected; persistent grant through the /approval adapter (same owner).
 await syncInteraction([approval('approval')])
 await renders
 assert.equal(await bubble.getByRole('button',{name:'在 DSH 中查看',exact:true}).count(),0)
 assert.match(await bubble.locator('#bubble-text').textContent(),/工作区外/)
 const detailsToggle=bubble.locator('#bubble-details-toggle')
 await detailsToggle.waitFor({state:'visible'})
 await detailsToggle.click();await renders
 const detailsText=await bubble.locator('#bubble-details').innerText()
 assert.match(detailsText,/工具：write/);assert.match(detailsText,/原始原因：write outside workspace/);assert.match(detailsText,/只能批准本次/)
 const approvalResize=await bubble.evaluate(()=>window.__resizeCalls?.at(-1)||0)
 assert.ok(approvalResize>=150,`approval bubble asked for only ${approvalResize}px`)
 assert.ok(approvalResize<=ORB_BUBBLE_WINDOW_HEIGHT)
 await page.screenshot({path:join(output,'approval.png')})
 await bubble.getByRole('button',{name:'允许一次',exact:true}).click();await renders
 assert.deepEqual(calls.at(-1),['interaction.resolve',{interactionId:'approval',semanticRevision:1,decision:'allowed-once'}])
 await syncInteraction([approval('persistent',{toolName:'bash',reason:'needs approval',operation:{toolName:'bash',cwd:'/work',arguments:{command:'echo fixture'}}})])
 await renders
 await bubble.getByRole('button',{name:'始终允许此操作…',exact:true}).click();await renders
 await bubble.getByRole('button',{name:'返回',exact:true}).click();await renders
 assert.equal(await bubble.getByRole('button',{name:'允许一次',exact:true}).count(),1)
 await bubble.getByRole('button',{name:'始终允许此操作…',exact:true}).click();await renders
 await page.screenshot({path:join(output,'approval-persistent-confirm.png')})
 await bubble.getByRole('button',{name:'确认持续允许',exact:true}).click();await renders
 assert.deepEqual(calls.at(-1),['/approval',{id:'persistent',sessionId:'ui-session',decision:'always-allow',confirmExact:true}])
 await syncInteraction([approval('approval-deny',{toolName:'bash',reason:'bash outside workspace: /Users/example'})])
 await renders
 assert.match(await bubble.locator('#bubble-text').textContent(),/运行命令/)
 await bubble.getByRole('button',{name:'拒绝',exact:true}).click();await renders
 assert.deepEqual(calls.at(-1),['interaction.resolve',{interactionId:'approval-deny',semanticRevision:1,decision:'rejected'}])
 await syncV2({})
 await renders
 await presentation.recoverTask();await renders
 await bubble.getByRole('button',{name:/^重新提交原指令/}).click();await renders
 assert.equal(calls.at(-1)[1],undefined,'Mode selection executed before confirmation')
 await bubble.getByRole('button',{name:'返回',exact:true}).click();await renders
 await bubble.getByRole('button',{name:/^检查后继续/}).click();await renders
 await page.screenshot({path:join(output,'recovery-confirm.png')})
 await bubble.getByRole('button',{name:'确认检查后继续',exact:true}).click();await renders
 assert.deepEqual(calls.at(-1),['/task/recovery',{token:'ui-recovery',mode:'continue',confirmSideEffects:true}])
 await syncV2({})
 await bubble.waitForFunction(()=>getComputedStyle(document.getElementById('bubble')).opacity==='0')
 experience=createPetExperience({home,window:{isDestroyed:()=>false,webContents:{send(){}}},emit(){},show:payload=>{renders=renders.then(()=>bubble.evaluate(p=>window.receiveBubble(p),payload))},hide:()=>{renders=renders.then(()=>bubble.evaluate(()=>window.receiveBubble({visible:false})))},shortcuts:{register:()=>true,unregister(){}},request:async()=>({ok:true,config:{}})})
 experience.start();await renders
 await bubble.getByPlaceholder('输入称呼，回车或点「好」').waitFor()
 await page.screenshot({path:join(output,'welcome.png')})
 await bubble.getByPlaceholder('输入称呼，回车或点「好」').fill('朋友')
 await bubble.getByRole('button',{name:'好',exact:true}).click();await renders
 await bubble.getByText('你希望我是什么性格？选一个，或者自己写。',{exact:true}).waitFor()
 await bubble.locator('#bubble-close').click();await renders;assert.equal(experience.state().onboarding,false)
 assert.deepEqual(errors,[])
 console.log('PASS shipped Chromium sprite/Markdown rendering driven by v2 snapshot@1 + versioned events; complete long text; unclipped question/footer bounds; pressed/selected feedback; multi-select set-selected/custom answer with Host-confirmed selectionRevision; interaction.resolve allowed-once/rejected; persistent-approval adapter; queue.edit/queue.delete by revision; input.edit preserved across an incoming notice; recording cancellation stays media-scope; onboarding. IPC is an explicit fixture, not native macOS acceptance.')
} finally {
 await experience?.stop();rmSync(home,{recursive:true,force:true});presentation?.stop();await renders.catch(()=>{});await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections()})
}
