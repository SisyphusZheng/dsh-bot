/** Real Chromium rendering of shipped pet/bubble pages with an explicit IPC fixture. */
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
let experience;let browser,presentation,renders=Promise.resolve()
try {
 browser=await chromium.launch({headless:true,...(process.env.DSH_CHROMIUM_EXECUTABLE?{executablePath:process.env.DSH_CHROMIUM_EXECUTABLE}:{}),args:process.platform==='linux'?['--no-sandbox','--single-process','--no-zygote','--disable-gpu','--disable-dev-shm-usage']:[]})
 const context=await browser.newContext({viewport:{width:420,height:fixtureHeight},deviceScaleFactor:2,reducedMotion:'reduce'}),errors=[],calls=[]
 await context.exposeBinding('bubbleAction',async(_source,action)=>{if(!await experience?.action(action))return presentation.action(action)})
 await context.addInitScript(()=>{
  window.petBridge={state:async()=>({phase:'unconfigured'}),voiceStatus(){},onVoice(){},onVoiceCommand(){},onPresentation:fn=>{window.receivePresentation=fn},hit(){},dragStart(){},dragMove(){},dragEnd(){},openMain(){},menu(){}}
  window.petBubble={onUpdate:fn=>{window.receiveBubble=fn},action:value=>window.bubbleAction(value),setInteractive(){},requestInputFocus(){},openDsh(){}}
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
 presentation=createCompanionPresentation({show:payload=>{renders=renders.then(()=>bubble.evaluate(p=>window.receiveBubble(p),payload))},hide:()=>{renders=renders.then(()=>bubble.evaluate(()=>window.receiveBubble({visible:false})))},animate:payload=>{renders=renders.then(()=>pet.evaluate(p=>window.receivePresentation(p),payload))},send:async(...args)=>calls.push(args)})
 await page.screenshot({path:join(output,'idle.png')})
 const snapshot=requests=>({pid:123,sessionId:'ui-session',requests})
 presentation.sync(snapshot([{id:'choice',kind:'question',sessionId:'ui-session',questions:[{id:'destination',question:'这次旅行想去哪里？',options:[{label:'杭州',description:'西湖边散步，行程轻松。'},{label:'上海'},{label:'苏州'},{label:'南京'},{label:'暂时不去'}]}]}]));await renders
 await bubble.getByRole('button',{name:'暂时不去',exact:true}).waitFor()
 assert.equal(await bubble.locator('#bubble-choices button').count(),5)
 await page.screenshot({path:join(output,'choice.png')})
 await bubble.getByRole('button',{name:'苏州',exact:true}).click();await renders
 assert.deepEqual(calls.at(-1),['/questions/answer',{id:'choice',sessionId:'ui-session',answer:{answers:[{id:'destination',selected:['苏州']}]}}])
 // The actual shipped renderer must retain Markdown and both ends of long output.
 const report='## 执行结果\n\n**完成**，保留 `code`。\n\n- 第一项\n- 第二项\n\n'+'详细结果。'.repeat(120)+'最后一行。'
 presentation.event({type:'assistant.message',data:{text:report}});await renders
 assert.equal(await bubble.locator('#bubble-text strong').textContent(),'完成')
 assert.equal(await bubble.locator('#bubble-text code').textContent(),'code')
 assert.equal(await bubble.locator('#bubble-text li').count(),2)
 assert.ok((await bubble.locator('#bubble-text').textContent()).endsWith('最后一行。'))
 await page.screenshot({path:join(output,'markdown.png')})
 const longOptions=['允许只读检查当前工作区的配置与日志','保持现有设置并暂时跳过本次操作','先解释这几个选项之间的差异']
 presentation.sync(snapshot([{id:'layout',kind:'question',sessionId:'ui-session',questions:[{id:'long',multiSelect:true,question:'**下一步怎么处理？**\n\n请确认范围；可以多选，也可以填写其他回答。',options:longOptions.map(label=>({label,description:'完整说明需要换行显示，不应把文字裁切成省略号。'}))}]}]));await renders
 await bubble.getByRole('button',{name:'提交',exact:true}).waitFor({state:'visible'})
 assert.equal(await bubble.locator('#bubble-progress').isHidden(),true,'single question must not show 1 / 1')
 assert.equal(await bubble.getByRole('button',{name:'在 DSH 中查看',exact:true}).count(),0)
 const footer=bubble.getByRole('button',{name:'提交',exact:true})
 await footer.waitFor({state:'visible'})
 const geometry=await bubble.evaluate(()=>{
  const card=document.getElementById('bubble-card'), footer=[...document.querySelectorAll('#bubble-secondary button')].find(el=>el.textContent==='提交'), r=card.getBoundingClientRect(), f=footer.getBoundingClientRect()
  return {top:r.top,bottom:r.bottom,viewport:innerHeight,footerTop:f.top,footerBottom:f.bottom,cardOverflow:card.scrollHeight>card.clientHeight+1,labels:[...document.querySelectorAll('.choice')].every(el=>el.scrollHeight<=el.clientHeight+1)}
 })
 assert.ok(geometry.top>=0&&geometry.bottom<=geometry.viewport,JSON.stringify(geometry))
 assert.ok(geometry.footerTop>=geometry.top&&geometry.footerBottom<=geometry.bottom,JSON.stringify(geometry))
 assert.equal(geometry.cardOverflow,false,JSON.stringify(geometry));assert.equal(geometry.labels,true)
 writeFileSync(join(output,'layout.json'),JSON.stringify({geometry,scope:'Shipped renderer in Chromium; explicit IPC fixture; not native macOS acceptance'},null,2)+'\n')
 const option=bubble.getByRole('button',{name:new RegExp('^'+longOptions[0])})
 const box=await option.boundingBox();assert.ok(box)
 await option.hover();await page.mouse.down()
 assert.notEqual(await option.evaluate(el=>getComputedStyle(el).boxShadow),'none','Pointer down has no feedback')
 await page.mouse.up();await renders
 assert.equal(await option.getAttribute('aria-pressed'),'true')
 await page.screenshot({path:join(output,'choice-selected.png')})
 await bubble.getByRole('button',{name:'其他回答',exact:true}).click();await renders
 await bubble.getByPlaceholder('输入你的回答').fill('保留完整结果')
 await bubble.getByRole('button',{name:'提交',exact:true}).click();await renders
 assert.deepEqual(calls.at(-1)[1].answer.answers,[{id:'long',selected:[longOptions[0]],custom:'保留完整结果'}])
 presentation.capture({kind:'capture-start',captureId:'silent',text:'正在听…'});await renders
 await bubble.getByRole('button',{name:'取消录音',exact:true}).waitFor({state:'visible'})
 const sentBeforeCancel=calls.length
 await bubble.getByRole('button',{name:'取消录音',exact:true}).click();await renders
 assert.equal(calls.length,sentBeforeCancel,'Recording cancellation reached the Agent')
 presentation.sync(snapshot([{id:'approval',kind:'approval',sessionId:'ui-session',toolName:'write',reason:'write outside workspace: /Users/example/Downloads/report.md'}]));await renders
 assert.equal(await bubble.getByRole('button',{name:'在 DSH 中查看',exact:true}).count(),0)
 assert.match(await bubble.locator('#bubble-text').textContent(),/工作区外/)
 const detailsToggle=bubble.locator('#bubble-details-toggle')
 await detailsToggle.waitFor({state:'visible'})
 await detailsToggle.click();await renders
 const detailsText=await bubble.locator('#bubble-details').innerText()
 assert.match(detailsText,/工具：write/);assert.match(detailsText,/原始原因：write outside workspace/);assert.match(detailsText,/范围：仅本次请求/)
 await page.screenshot({path:join(output,'approval.png')})
 await bubble.getByRole('button',{name:'允许一次',exact:true}).click();await renders
 assert.equal(calls.at(-1)[1].decision,'allow')
 presentation.sync(snapshot([{id:'approval-deny',kind:'approval',sessionId:'ui-session',toolName:'bash',reason:'bash outside workspace: /Users/example'}]));await renders
 assert.match(await bubble.locator('#bubble-text').textContent(),/运行命令/)
 await bubble.getByRole('button',{name:'拒绝',exact:true}).click();await renders
 assert.equal(calls.at(-1)[1].decision,'reject')
 presentation.sync(snapshot([]));await renders
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
 console.log('PASS shipped Chromium sprite/Markdown rendering; complete long text; unclipped question/footer bounds; pressed/selected feedback; multi-select/custom answer; allow/reject clicks; silent capture cancellation; onboarding. IPC is an explicit fixture, not native macOS acceptance.')
} finally {
 await experience?.stop();rmSync(home,{recursive:true,force:true});presentation?.stop();await renders.catch(()=>{});await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections()})
}
