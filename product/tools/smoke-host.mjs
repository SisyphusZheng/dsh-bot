/** Exercise the generated desktop profile in the real, compiled DSH CLI. */
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { BotRuntime } from '../../apps/desktop/lib/types/bot-runtime.js'
const root = resolve(import.meta.dirname, '../..'), home = mkdtempSync(join(tmpdir(), 'dsh-bot-host-'))
let child, output = '', code
const requests=[]
const memoryTrace=[]
let nextTool=null
let releaseRecall=null
const mock = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk
  if(['/digest','/search','/write'].includes(req.url)){
    memoryTrace.push({path:req.url,body:body?JSON.parse(body):{},authorization:req.headers.authorization})
    if(req.url==='/search'&&JSON.parse(body).query==='CANCEL_DURING_RECALL'){releaseRecall=()=>res.end(JSON.stringify({ok:true,hits:[]}));return}
    res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/search'?{ok:true,hits:[{text:'个人偏好：无糖拿铁，海风咖啡店。'}]}:req.url==='/digest'?{ok:true,digest:{text:'用户的个人资料'}}:{ok:true}));return
  }
  if (req.url?.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({data:[{id:'mvp-local'}]})); return }
  if(body)requests.push({...JSON.parse(body),_authorization:req.headers.authorization})
  res.writeHead(200, {'content-type':'text/event-stream'})
  const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  if(nextTool){
    const args=nextTool.arguments||nextTool;const toolName=nextTool.name||'write';nextTool=null
    const event=delta=>res.write('data: '+JSON.stringify({id:'chatcmpl-tool',object:'chat.completion.chunk',created:1,model:'mvp-local',choices:[{index:0,delta,finish_reason:Object.keys(delta).length?null:'tool_calls'}]})+'\n\n')
    event({role:'assistant',tool_calls:[{index:0,id:'call_write',type:'function',function:{name:toolName,arguments:JSON.stringify(args)}}]});event({});res.end('data: [DONE]\n\n');return
  }
  if (req.url?.includes('/messages')) {
    event('message_start',{type:'message_start', message:{id:'msg_mvp',type:'message',role:'assistant',model:'deepseek-v4.1-flash',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}})
    event('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}})
    event('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'MVP profile smoke passed'}})
    event('content_block_stop',{type:'content_block_stop',index:0})
    event('message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}})
    event('message_stop',{type:'message_stop'})
  } else {
    for (const delta of [{role:'assistant',content:'MVP profile smoke passed'},{}]) res.write('data: '+JSON.stringify({id:'chatcmpl-mvp',object:'chat.completion.chunk',created:1,model:'mvp-local',choices:[{index:0,delta,finish_reason:delta.content?null:'stop'}],usage:{prompt_tokens:1,completion_tokens:5,total_tokens:6}})+'\n\n')
    res.write('data: [DONE]\n\n')
  }
  res.end()
})
await new Promise(r=>mock.listen(0,'127.0.0.1',r))
try {
  const resources = join(home,'resources'); mkdirSync(resources)
  symlinkSync(join(root,'nisse/packages/host-integration'),join(resources,'host-integration'),'dir')
  const llm = {provider:process.argv.includes('--default-provider')?'opencode-go':'custom',model:process.argv.includes('--default-provider')?'deepseek-v4.1-flash':'mvp-local',baseUrl:`http://127.0.0.1:${mock.address().port}/v1`,apiKey:'mvp-test-key'}
  const runtime = new BotRuntime(home, resources, undefined, join(root,'apps/cli'))
  runtime.setMemory({url:`http://127.0.0.1:${mock.address().port}`,token:'fixture-memory-token'})
  runtime.prepare({llm}); assert.equal(runtime.status().error,'')
  cpSync(join(home,'profiles/desktop'),join(home,'profiles/mvp-smoke'),{recursive:true,dereference:false})
  mkdirSync(join(home,'bot'),{recursive:true}); writeFileSync(join(home,'bot/config.json'),JSON.stringify({llm:{...llm,apiKey:''}}))
  const env={...process.env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',NODE_USE_ENV_PROXY:'0'}
  for (const key of Object.keys(env)) if (/proxy/i.test(key) && key!=='NODE_USE_ENV_PROXY') delete env[key]
  child=spawn(process.execPath,[join(root,'apps/cli/lib/bin.js'),'--profile','mvp-smoke','--no-open','--host','127.0.0.1','--port','0'],{env,stdio:['ignore','pipe','pipe']})
  child.stdout.on('data',x=>output+=x); child.stderr.on('data',x=>output+=x); child.once('exit',x=>{code=x})
  let descriptor
  const deadline=Date.now()+60000
  while(Date.now()<deadline) {
    if(code!==undefined) throw new Error('Host exited: '+output.slice(-6000))
    try { const d=JSON.parse(readFileSync(join(home,'bot/bridge.json'),'utf8')); const h=await (await fetch(`http://127.0.0.1:${d.port}/health`)).json(); if(h.agent?.ready === true && !h.agent.lastStartupError) { descriptor=d; break } } catch {}
    await new Promise(r=>setTimeout(r,100))
  }
  assert.ok(descriptor, 'Host not ready: '+output.slice(-6000))
  if(process.argv.includes('--web')) {
    const {smokeHostBrowser}=await import('./smoke-host-browser.mjs')
    await smokeHostBrowser({root,descriptor,webUrl:output.match(/dsh web: (http[^\s]+)/)?.[1]})
  }
  const response=await fetch(`http://127.0.0.1:${descriptor.port}/voice/turn`,{method:'POST',headers:{authorization:`Bearer ${descriptor.token}`,'content-type':'application/json'},body:JSON.stringify({text:'Please say the smoke result.'}),signal:AbortSignal.timeout(30000)})
  assert.equal(response.status,200)
  const frames=(await response.text()).trim().split('\n').map(x=>JSON.parse(x))
  assert.ok(frames.some(x=>x.type==='admitted'))
  assert.ok(frames.some(x=>x.type==='turn-end' && x.reason?.kind==='completed'),JSON.stringify(frames))
  assert.match(frames.filter(x=>x.type==='text').map(x=>x.text).join(''),/MVP profile smoke passed/)
  const tools=requests[0]?.tools?.map(x=>x.function?.name||x.name)
  for(const name of ['bash','read','write','edit'])assert.ok(tools?.includes(name),`Missing production tool: ${name}`)
  const headers={authorization:`Bearer ${descriptor.token}`,'content-type':'application/json'}
  const post=(path,body)=>fetch(`http://127.0.0.1:${descriptor.port}${path}`,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(30000)})
  const session=frames.find(x=>x.type==='admitted').sessionId
  if(llm.provider==='custom'){
    for(const decision of ['allow','reject','cancel']){
      const target=join(home,`outside-${decision}.txt`);nextTool={file_path:target,content:'production-approved'}
      const response=await post('/voice/turn',{text:`Write ${target}`});assert.equal(response.status,200)
      let approved=false,pending='',all=[]
      for await(const chunk of response.body){pending+=new TextDecoder().decode(chunk);let pos;while((pos=pending.indexOf('\n'))>=0){const frame=JSON.parse(pending.slice(0,pos));pending=pending.slice(pos+1);all.push(frame)
        if(frame.type==='approval'&&!approved){assert.equal(existsSync(target),false);approved=true;assert.equal((await post(decision==='cancel'?'/cancel':'/approval',decision==='cancel'?{}:{id:frame.id,decision})).status,200)}
      }}
      assert.ok(approved,JSON.stringify(all));assert.equal(existsSync(target),decision==='allow',JSON.stringify(all));assert.ok(all.some(x=>x.type==='turn-end'))
    }
    for (const kind of ['single','multi','cancel']) {
      const questions = [{id:'place',question:'去哪里？',options:[{label:'杭州'},{label:'苏州'},{label:'上海'}],...(kind==='multi'?{multi_select:true}:{})}]
      nextTool={name:'ask_user_question',arguments:{questions}}
      const response=await post('/voice/turn',{text:'Ask me to choose a destination.'});assert.equal(response.status,200)
      const finished=response.text()
      let request
      const deadline=Date.now()+15000
      while(Date.now()<deadline){const snapshot=await(await fetch(`http://127.0.0.1:${descriptor.port}/interactions`,{headers})).json();request=snapshot.requests.find(item=>item.kind==='question');if(request)break;await new Promise(r=>setTimeout(r,20))}
      assert.ok(request,'official ask_user_question was not mirrored')
      assert.equal(request.questions[0].id,'place')
      assert.equal((await post('/questions/answer',{id:request.id,sessionId:request.sessionId,answer:{answers:[{id:'place',selected:['unknown']}]}})).status,400)
      if(kind==='cancel')assert.equal((await post('/cancel',{})).status,200)
      else {
        const selected=kind==='multi'?['杭州','苏州']:['苏州']
        const body={id:request.id,sessionId:request.sessionId,answer:{answers:[{id:'place',selected}]}}
        assert.equal((await post('/questions/answer',body)).status,200)
        assert.equal((await post('/questions/answer',body)).status,409)
      }
      const frames=(await finished).trim().split('\n').map(x=>JSON.parse(x));assert.ok(frames.some(x=>x.type==='turn-end'))
      const snapshot=await(await fetch(`http://127.0.0.1:${descriptor.port}/interactions`,{headers})).json();assert.equal(snapshot.requests.length,0)
    }
    console.log('PASS official ask_user_question single/multi-select, invalid answer, duplicate answer and cancellation through real production Host')
    const original=JSON.parse(readFileSync(join(home,'bot/bridge.json'),'utf8')),updated={...llm,model:'mvp-updated',apiKey:'mvp-updated-key'}
    writeFileSync(join(home,'bot/config.json'),JSON.stringify({llm:{...updated,apiKey:''},persona:{name:'LivePersona'},approval:{mode:'ask-before-acting'}}))
    const applied=await post('/config',{llm:updated});assert.equal(applied.status,200,await applied.clone().text())
    const after=JSON.parse(readFileSync(join(home,'bot/bridge.json'),'utf8'));assert.equal(after.pid,original.pid);assert.equal(after.port,original.port)
    const live=await post('/voice/turn',{text:'Verify the updated model and persona.'}),liveFrames=(await live.text()).trim().split('\n').map(x=>JSON.parse(x))
    assert.equal(liveFrames.find(x=>x.type==='admitted')?.sessionId,session);assert.equal(requests.at(-1).model,'mvp-updated');assert.equal(requests.at(-1)._authorization,'Bearer mvp-updated-key');assert.match(JSON.stringify(requests.at(-1).messages),/LivePersona/)
    assert.ok(liveFrames.some(x=>x.type==='turn-end'&&x.reason?.kind==='completed'),JSON.stringify(liveFrames))
    console.log('PASS production preset tools; real write approval allow/reject/cancel; live model/persona preserves PID, port and Session')
  }
  assert.ok(memoryTrace.some(x=>x.path==='/search'&&x.body.query),'no per-turn recall')
  assert.ok(memoryTrace.every(x=>x.authorization==='Bearer fixture-memory-token'))
  assert.match(JSON.stringify(requests.at(-1).messages??requests.at(-1).system),/无糖拿铁/)
  const beforeRecallCancel=requests.length
  const pendingRecall=await post('/voice/turn',{text:'CANCEL_DURING_RECALL'})
  const waitDeadline=Date.now()+3000
  while(!releaseRecall&&Date.now()<waitDeadline)await new Promise(r=>setTimeout(r,10))
  assert.ok(releaseRecall,'recall barrier not entered')
  const cancelled=await post('/cancel',{});assert.equal((await cancelled.json()).cancelled,true)
  releaseRecall();releaseRecall=null
  const cancelledFrames=(await pendingRecall.text()).trim().split('\n').map(x=>JSON.parse(x))
  assert.ok(cancelledFrames.some(x=>x.type==='turn-end'&&x.reason?.kind==='cancelled'))
  assert.equal(requests.length,beforeRecallCancel,'cancelled admission reached LLM')
  const rotated=await post('/conversation/new',{});assert.equal(rotated.status,200)
  const recalled=await post('/voice/turn',{text:'我喜欢什么咖啡？'})
  const recalledFrames=(await recalled.text()).trim().split('\n').map(x=>JSON.parse(x))
  assert.notEqual(recalledFrames.find(x=>x.type==='admitted')?.sessionId,session)
  assert.match(JSON.stringify(requests.at(-1)),/无糖拿铁/)
  assert.ok(memoryTrace.some(x=>x.path==='/write'))
  console.log('PASS authenticated memory write/recall and cross-Session prompt injection (explicit HTTP fixture, not database qualification)')
  child.kill('SIGTERM'); await Promise.race([new Promise(r=>child.once('exit',r)),new Promise((_,r)=>setTimeout(()=>r(new Error('Host shutdown timeout')),10000).unref())]); assert.equal(code,0,output.slice(-3000)); child=null
  console.log(`PASS real Host startup, ${llm.provider}, voice NDJSON, session completion and graceful exit`)
} catch(error) {throw new Error(String(error)+'\n'+output.slice(-14000))} finally {
  if(child){const exited=code===undefined?new Promise(resolve=>child.once('exit',resolve)):Promise.resolve();child.kill('SIGKILL');await exited}
  await new Promise(r=>{mock.close(r);mock.closeAllConnections()}); rmSync(home,{recursive:true,force:true})
}
