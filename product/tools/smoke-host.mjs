/** Exercise the generated desktop profile in the real, compiled DSH CLI. */
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync, writeFileSync, cpSync, rmSync, existsSync, realpathSync, accessSync, constants } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { resolve, join, dirname, relative, isAbsolute, sep, parse } from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { BotRuntime } from '../../apps/desktop/lib/types/bot-runtime.js'
const root = resolve(import.meta.dirname, '../..')
// The Bot default permission model is workspace-write, which also grants /tmp and
// the per-user temp directory wholesale. A DSH_HOME under os.tmpdir() would make
// every "outside the workspace" fixture writable and hide the real approval path,
// so HOME/workspace live outside those grants (same rule as
// scripts/snapshot-workspace-parent.ts).
const smokeParent = (() => {
  const temporary = realpathSync.native(tmpdir()), systemTemporary = realpathSync.native('/tmp'), parent = dirname(temporary)
  if (temporary === systemTemporary || parent === parse(parent).root) return homedir()
  try { accessSync(parent, constants.W_OK) } catch { return homedir() }
  return parent
})()
const home = mkdtempSync(join(smokeParent, 'dsh-bot-host-'))
for (const tempRoot of [realpathSync.native(tmpdir()), realpathSync.native('/tmp')]) {
  const rel = relative(tempRoot, realpathSync.native(home))
  assert.ok(rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel), `smoke HOME must be outside automatic temp write grants: ${home} under ${tempRoot}`)
}
let child, output = '', code
const requests=[]
const memoryTrace=[]
// Mock-model escalation state: a plain write is denied by the DSH sandbox, the
// model-visible tool result carries the denial + escalation hint, and the mock
// re-issues the EXACT call once with sandbox_permissions + justification — the
// same retry a real model performs from that hint.
let nextTool=null
let pendingEscalation=null
let escalationRetries=0
const ESCALATION_JUSTIFICATION='smoke fixture: the user asked for this exact write outside the workspace'
const DENIAL_MARKER='[sandbox: file access denied under '
const ESCALATION_HINT='[sandbox: escalation available — retry this exact'
/** Latest tool result text the model sees (chat-completions transcript). */
const lastToolResultText=messages=>{
  for(let index=messages.length-1;index>=0;index-=1){
    const message=messages[index]
    if(message&&message.role==='tool')return typeof message.content==='string'?message.content:JSON.stringify(message.content??'')
  }
  return ''
}
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
  const payload=body?JSON.parse(body):{}
  const writeToolCall=(toolName,args)=>{
    const chunk=delta=>res.write('data: '+JSON.stringify({id:'chatcmpl-tool',object:'chat.completion.chunk',created:1,model:'mvp-local',choices:[{index:0,delta,finish_reason:Object.keys(delta).length?null:'tool_calls'}]})+'\n\n')
    chunk({role:'assistant',tool_calls:[{index:0,id:'call_write',type:'function',function:{name:toolName,arguments:JSON.stringify(args)}}]});chunk({});res.end('data: [DONE]\n\n')
  }
  if(pendingEscalation){
    const denied=lastToolResultText(Array.isArray(payload.messages)?payload.messages:[])
    if(denied.includes(DENIAL_MARKER)&&denied.includes(ESCALATION_HINT)){
      // A real model retries exactly once from the hint; the sandbox tool raises the
      // formal approval request on this call and only an approved call has an effect.
      escalationRetries+=1
      const {name,arguments:args}=pendingEscalation;pendingEscalation=null
      writeToolCall(name,{...args,sandbox_permissions:'danger-full-access',justification:ESCALATION_JUSTIFICATION})
      return
    }
    // Any other outcome (success, rejection, cancellation, unrelated error) ends the retry.
    pendingEscalation=null
  }
  if(nextTool){
    const toolName=nextTool.name||'write',args=nextTool.arguments||nextTool;nextTool=null
    if(toolName==='write'||toolName==='edit')pendingEscalation={name:toolName,arguments:args}
    writeToolCall(toolName,args)
    return
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
  await runtime.prepare({llm}); assert.equal(runtime.status().error,'')
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
  const preview = await (await fetch(`http://127.0.0.1:${descriptor.port}/persona/preview`, {headers})).json()
  const responseStyle = readFileSync(join(root,'product/tools/tests/expected/persona-response-style.txt'),'utf8').trim()
  const detailedStyle = readFileSync(join(root,'product/tools/tests/expected/persona-response-detailed.txt'),'utf8').trim()
  assert.ok(preview.dshPrompt.includes(responseStyle),'Persona response style snapshot differs')
  assert.match(JSON.stringify(requests[0].messages ?? requests[0].system), /任务完成或汇报时/)
  const post=(path,body)=>fetch(`http://127.0.0.1:${descriptor.port}${path}`,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(30000)})
  // A cancel must name the turn it stops. Read that identity immediately before the
  // request instead of sending an unscoped cancel that would stop whatever runs.
  const cancelTarget=async()=>{
    const state=await(await fetch(`http://127.0.0.1:${descriptor.port}/task-state`,{headers,signal:AbortSignal.timeout(5000)})).json()
    return {hostEpoch:state.hostEpoch,sessionId:state.sessionId,...(state.turn===null||state.turn===undefined?{}:{turn:state.turn}),...(state.clientTurnId?{clientTurnId:state.clientTurnId}:{})}
  }
  const session=frames.find(x=>x.type==='admitted').sessionId
  if(llm.provider==='custom'){
    for(const decision of ['allow','reject','cancel']){
      const target=join(home,`outside-${decision}.txt`);nextTool={file_path:target,content:'production-approved'}
      const response=await post('/voice/turn',{text:`Write ${target}`});assert.equal(response.status,200)
      let approved=false,pending='',all=[]
      for await(const chunk of response.body){pending+=new TextDecoder().decode(chunk);let pos;while((pos=pending.indexOf('\n'))>=0){const frame=JSON.parse(pending.slice(0,pos));pending=pending.slice(pos+1);all.push(frame)
        if(frame.type==='approval'&&!approved){assert.equal(existsSync(target),false);approved=true;assert.equal((await post(decision==='cancel'?'/cancel':'/approval',decision==='cancel'?{...(await cancelTarget()),source:'task-stop'}:{id:frame.id,decision})).status,200)}
      }}
      assert.ok(approved,JSON.stringify(all));assert.equal(existsSync(target),decision==='allow',JSON.stringify(all));assert.ok(all.some(x=>x.type==='turn-end'))
      if(decision==='allow')assert.equal(readFileSync(target,'utf8'),'production-approved','an approved escalation must produce the real file side effect')
    }
    assert.ok(escalationRetries>0,'the DSH sandbox denial + escalation hint must reach the model-visible tool result before the escalation retry')
    const recoveryGet=()=>fetch(`http://127.0.0.1:${descriptor.port}/task/recovery`,{headers,signal:AbortSignal.timeout(5000)})
    assert.equal((await fetch(`http://127.0.0.1:${descriptor.port}/task/recovery`)).status,401)
    const oldPreviewResponse=await recoveryGet();assert.equal(oldPreviewResponse.status,200,await oldPreviewResponse.clone().text());const oldPreview=await oldPreviewResponse.json();assert.match(oldPreview.originalText,/outside-cancel/)
    assert.equal((await post('/task/recovery',{token:oldPreview.token,mode:'retry'})).status,400)
    await(await post('/voice/turn',{text:'A newer ordinary task.'})).text()
    assert.equal((await post('/task/recovery',{token:oldPreview.token,mode:'retry',confirmSideEffects:true})).status,409)
    assert.equal((await recoveryGet()).status,409,'Completed work must not offer recovery')
    for(const mode of ['retry','continue']){
      const target=join(home,`recover-${mode}.txt`),original=`Write ${target}`
      nextTool={file_path:target,content:'recovered-once'}
      const interrupted=await post('/voice/turn',{text:original});let buffer=''
      for await(const chunk of interrupted.body){buffer+=new TextDecoder().decode(chunk);let at;while((at=buffer.indexOf('\n'))>=0){const event=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);if(event.type==='approval')assert.equal((await post('/cancel',{...(await cancelTarget()),source:'task-stop'})).status,200)}}
      const previewResponse=await recoveryGet();assert.equal(previewResponse.status,200,await previewResponse.clone().text());const preview=await previewResponse.json();assert.equal(preview.originalText,original);assert.equal(existsSync(target),false)
      if(mode==='retry')nextTool={file_path:target,content:'recovered-once'}
      const admitted=await post('/task/recovery',{token:preview.token,mode,confirmSideEffects:true});assert.equal(admitted.status,200,await admitted.clone().text())
      assert.equal((await post('/task/recovery',{token:preview.token,mode,confirmSideEffects:true})).status,409)
      const limit=Date.now()+10000;let state,answered=false
      do{
        const pending=await(await fetch(`http://127.0.0.1:${descriptor.port}/interactions`,{headers})).json()
        if(pending.requests.length&&!answered){assert.equal((await recoveryGet()).status,409);answered=true;assert.equal((await post('/approval',{id:pending.requests[0].id,sessionId:pending.sessionId,decision:'allow'})).status,200)}
        state=await(await fetch(`http://127.0.0.1:${descriptor.port}/task-state`,{headers})).json()
        if(state.status==='idle'&&state.lastTurn)break
        await new Promise(r=>setTimeout(r,20))
      }while(Date.now()<limit)
      assert.equal(state.status,'idle');assert.equal(existsSync(target),mode==='retry')
      if(mode==='continue')assert.match(JSON.stringify(requests.at(-1).messages),/不重复已经完成的操作/)
    }
    console.log('PASS persisted-task preview, confirmed retry/checked continuation, and stale/duplicate/busy/completed guards')
    const grantTarget=join(home,'exact-granted.txt'), originalArgs={file_path:grantTarget,content:'precise-grant'}
    // The recorded approval operation is the ESCALATED retry (the call that carries
    // sandbox_permissions + justification), so exact grants bind that complete call.
    const escalatedArgs=args=>({...args,sandbox_permissions:'danger-full-access',justification:ESCALATION_JUSTIFICATION})
    const get=path=>fetch(`http://127.0.0.1:${descriptor.port}${path}`,{headers,signal:AbortSignal.timeout(30000)})
    for(const step of ['grant','reuse','changed','revoked']){
      const expectedArgs=step==='changed'?{...originalArgs,content:'changed-content'}:originalArgs
      nextTool=expectedArgs
      const response=await post('/voice/turn',{text:`Write exact grant fixture ${step}`});assert.equal(response.status,200)
      let buffer='',count=0,terminal=false
      for await(const chunk of response.body){buffer+=new TextDecoder().decode(chunk);let pos;while((pos=buffer.indexOf('\n'))>=0){const event=JSON.parse(buffer.slice(0,pos));buffer=buffer.slice(pos+1)
        if(event.type==='approval'){
          count++;const pending=(await(await get('/interactions')).json()).requests.find(item=>item.id===event.id)
          assert.equal(pending.operation.toolName,'write');assert.deepEqual(pending.operation.arguments,escalatedArgs(expectedArgs))
          if(step==='grant'){
            assert.equal((await post('/approval',{id:event.id,sessionId:pending.sessionId,decision:'always-allow'})).status,400)
            assert.equal((await post('/approval',{id:event.id,sessionId:pending.sessionId,decision:'always-allow',confirmExact:true})).status,200)
            assert.equal((await post('/approval',{id:event.id,sessionId:pending.sessionId,decision:'always-allow',confirmExact:true})).status,409)
          }else assert.equal((await post('/approval',{id:event.id,sessionId:pending.sessionId,decision:'reject'})).status,200)
        }
        if(event.type==='turn-end')terminal=true
      }}
      assert.equal(count,step==='reuse'?0:1);assert.ok(terminal)
      if(step==='changed'){
        const store=await(await get('/policies')).json();assert.equal(store.rules.length,1)
        assert.doesNotMatch(readFileSync(join(home,'bot/approval-grants.json'),'utf8'),/precise-grant|file_path/)
        const removed=await fetch(`http://127.0.0.1:${descriptor.port}/policies?id=${store.rules[0].id}`,{method:'DELETE',headers});assert.equal(removed.status,200)
      }
    }
    assert.equal(readFileSync(grantTarget,'utf8'),'precise-grant','the granted exact operation must have written the file; later changed/rejected steps must not overwrite it')
    assert.equal((await post('/policies',{toolName:'write'})).status,400)
    console.log('PASS exact approval arguments, explicit persistent grant, reuse, changed-argument reapproval, duplicate rejection and revocation through real Host')
    // Media disconnect detaches the listener; admitted Agent work keeps its own lifetime.
    nextTool={file_path:join(home,'detached-voice.txt'),content:'detached-completed'}
    const detachController=new AbortController()
    const detached=await fetch(`http://127.0.0.1:${descriptor.port}/voice/turn`,{method:'POST',headers,body:JSON.stringify({text:'Detached media task fixture'}),signal:detachController.signal})
    const reader=detached.body.getReader();let pendingApproval=null,detachedText=''
    try {while(!pendingApproval){const chunk=await reader.read();assert.equal(chunk.done,false);detachedText+=new TextDecoder().decode(chunk.value);for(const line of detachedText.split('\n').slice(0,-1)){const event=JSON.parse(line);if(event.type==='approval')pendingApproval=event}}}finally{detachController.abort();reader.releaseLock()}
    const exact=(await(await get('/interactions')).json()).requests.find(item=>item.id===pendingApproval.id);assert.ok(exact,'Disconnect cancelled the pending official approval')
    assert.equal((await post('/approval',{id:exact.id,sessionId:exact.sessionId,decision:'allow'})).status,200)
    const completionDeadline=Date.now()+15000;let detachedState
    do{detachedState=await(await get('/task-state')).json();if(detachedState.status==='idle'&&existsSync(join(home,'detached-voice.txt')))break;await new Promise(r=>setTimeout(r,20))}while(Date.now()<completionDeadline)
    assert.equal(detachedState.status,'idle');assert.equal(readFileSync(join(home,'detached-voice.txt'),'utf8'),'detached-completed')
    console.log('PASS media disconnect preserves admitted Agent task and pending approval; tool completes independently')
    // S2 contract: a request that names too little is a 400 with the missing fields,
    // a request that names a complete but absent target is a 409. Neither may cancel.
    const incompleteSession=await post('/cancel', {sessionId:'stale-session'})
    assert.equal(incompleteSession.status,400)
    assert.equal((await incompleteSession.json()).error?.code,'CANCEL_TARGET_INCOMPLETE')
    const incompleteRequest=await post('/cancel', {clientTurnId:'stale-request'})
    assert.equal(incompleteRequest.status,400)
    assert.equal((await incompleteRequest.json()).error?.code,'CANCEL_TARGET_INCOMPLETE')
    const incompleteTurn=await post('/cancel', {turn:-999})
    assert.equal(incompleteTurn.status,400)
    assert.equal((await incompleteTurn.json()).error?.code,'CANCEL_TARGET_INCOMPLETE')
    // A complete identity that this idle Host does not own is refused as stale, so the
    // 409 path stays covered instead of being replaced by the 400 path.
    const idleState=await(await fetch(`http://127.0.0.1:${descriptor.port}/task-state`,{headers})).json()
    const staleComplete=await post('/cancel', {hostEpoch:idleState.hostEpoch,sessionId:idleState.sessionId,turn:-999})
    assert.equal(staleComplete.status,409)
    assert.match(String((await staleComplete.json()).error?.code),/^STALE_|^NO_ACTIVE_TURN$/)
    assert.equal((await fetch(`http://127.0.0.1:${descriptor.port}/task-state`)).status,401)
    const taskState=await(await fetch(`http://127.0.0.1:${descriptor.port}/task-state`,{headers})).json()
    assert.equal(taskState.sessionId,session);assert.equal(taskState.status,'idle')
    console.log('PASS authenticated task state and session/request/DSH-turn cancellation scoping')
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
      if(kind==='cancel'){
        const stateUrl=`http://127.0.0.1:${descriptor.port}/task-state`
        const before=await(await fetch(stateUrl,{headers})).json()
        // An unscoped cancel must be refused and must not move the execution snapshot:
        // the request has to name the turn it stops, captured when the user asked.
        const unscoped=await post('/cancel',{})
        assert.equal(unscoped.status,400)
        assert.equal((await unscoped.json()).error?.code,'CANCEL_TARGET_REQUIRED')
        const after=await(await fetch(stateUrl,{headers})).json()
        assert.deepEqual(after.execution,before.execution)
        assert.equal(after.turn,before.turn);assert.equal(after.clientTurnId,before.clientTurnId)
        assert.equal((await post('/cancel',{source:'voice-command',...(await cancelTarget())})).status,200)
      }
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
    writeFileSync(join(home,'bot/config.json'),JSON.stringify({llm:{...updated,apiKey:''},persona:{promptOverride:'自定义人格完整保留'},approval:{mode:'ask-before-acting'}}))
    const customPreview = await (await fetch(`http://127.0.0.1:${descriptor.port}/persona/preview`,{headers})).json()
    assert.ok(customPreview.dshPrompt.includes(responseStyle))
    assert.match(customPreview.dshPrompt,/自定义人格完整保留/)
    writeFileSync(join(home,'bot/config.json'),JSON.stringify({llm:{...updated,apiKey:''},persona:{},app:{responseStyle:'detailed'},approval:{mode:'ask-before-acting'}}))
    const detailedPreview = await (await fetch(`http://127.0.0.1:${descriptor.port}/persona/preview`,{headers})).json()
    assert.ok(detailedPreview.dshPrompt.includes(detailedStyle),'detailed response style was not applied')
    assert.equal(detailedPreview.dshPrompt.includes(responseStyle),false,'concise rule leaked into detailed style')
    console.log('PASS production preset tools; real write approval allow/reject/cancel; live model/persona preserves PID, port and Session')
    console.log('PASS concise/detailed response style reaches the live persona prompt')
  }
  assert.ok(memoryTrace.some(x=>x.path==='/search'&&x.body.query),'no per-turn recall')
  assert.ok(memoryTrace.every(x=>x.authorization==='Bearer fixture-memory-token'))
  assert.match(JSON.stringify(requests.at(-1).messages??requests.at(-1).system),/无糖拿铁/)
  const beforeRecallCancel=requests.length
  const pendingRecall=await post('/voice/turn',{text:'CANCEL_DURING_RECALL'})
  const waitDeadline=Date.now()+3000
  while(!releaseRecall&&Date.now()<waitDeadline)await new Promise(r=>setTimeout(r,10))
  assert.ok(releaseRecall,'recall barrier not entered')
  assert.equal((await post('/cancel',{source:'invalid-source'})).status,400)
  const cancelled=await post('/cancel',{source:'voice-command',...(await cancelTarget())});const cancelledBody=await cancelled.json()
  // The turn is still in Host admission: DSH has not taken it over, so the Host
  // cannot prove the official turn is over. The correct conservative answer is
  // "accepted, not confirmed" — and it must not read as a success.
  assert.equal(cancelled.status,200)
  assert.equal(cancelledBody.state,'unconfirmed')
  assert.equal(cancelledBody.code,'CANCEL_UNCONFIRMED')
  assert.equal(cancelledBody.confirmed,false)
  assert.equal(cancelledBody.cancelled,false)
  assert.doesNotMatch(String(cancelledBody.notice?.text||''),/已停止|已确认/)
  releaseRecall();releaseRecall=null
  const cancelledFrames=(await pendingRecall.text()).trim().split('\n').map(x=>JSON.parse(x))
  // The unconfirmed stop still landed: once DSH took over it aborted this very turn,
  // which is the delayed confirmation the response refused to claim early.
  assert.ok(cancelledFrames.some(x=>x.type==='turn-end'&&x.reason?.kind==='cancelled'))
  assert.equal(requests.length,beforeRecallCancel,'cancelled admission reached LLM')
  const audit=readFileSync(join(home,'bot/audit.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))
  assert.ok(audit.some(row=>JSON.stringify(row).includes('voice-command')&&JSON.stringify(row).includes('session.cancel.requested')))
  const sourceEvents=await (await fetch(`http://127.0.0.1:${descriptor.port}/events`,{headers})).json()
  assert.ok(sourceEvents.events.some(row=>row.type==='turn.started'&&row.data.inputSource==='voice'))
  assert.match(JSON.stringify(requests[0].messages??requests[0].system),/Electron.*Pipecat/s)
  const rotated=await post('/conversation/new',{});assert.equal(rotated.status,200)
  const recalled=await post('/voice/turn',{text:'我喜欢什么咖啡？'})
  const recalledFrames=(await recalled.text()).trim().split('\n').map(x=>JSON.parse(x))
  assert.notEqual(recalledFrames.find(x=>x.type==='admitted')?.sessionId,session)
  assert.match(JSON.stringify(requests.at(-1)),/无糖拿铁/)
  assert.ok(memoryTrace.some(x=>x.path==='/write'))
  console.log('PASS authenticated memory write/recall and cross-Session prompt injection (explicit HTTP fixture, not database qualification)')
  if(llm.provider==='custom'){
    const target=join(home,'recover-after-restart.txt'),original=`Write ${target}`
    nextTool={file_path:target,content:'restart-recovery'}
    const interrupted=await post('/voice/turn',{text:original});let buffer=''
    for await(const chunk of interrupted.body){buffer+=new TextDecoder().decode(chunk);let at;while((at=buffer.indexOf('\n'))>=0){const event=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);if(event.type==='approval')assert.equal((await post('/cancel',{...(await cancelTarget()),source:'task-stop'})).status,200)}}
    const getPreview=()=>fetch(`http://127.0.0.1:${descriptor.port}/task/recovery`,{headers,signal:AbortSignal.timeout(5000)})
    const before=await(await getPreview()).json();assert.equal(before.originalText,original)
    const stopped=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await Promise.race([stopped,new Promise((_,r)=>setTimeout(()=>r(new Error('Restart shutdown timeout')),10000).unref())]);assert.equal(code,0);child=null;code=undefined;output=''
    child=spawn(process.execPath,[join(root,'apps/cli/lib/bin.js'),'--profile','mvp-smoke','--no-open','--host','127.0.0.1','--port','0'],{env,stdio:['ignore','pipe','pipe']})
    child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);child.once('exit',x=>{code=x})
    const restartDeadline=Date.now()+60000;let ready=false
    do{
      if(code!==undefined)throw new Error('Restarted Host exited: '+output.slice(-3000))
      try{const d=JSON.parse(readFileSync(join(home,'bot/bridge.json'),'utf8'));if(d.pid===child.pid){const h=await(await fetch(`http://127.0.0.1:${d.port}/health`)).json();if(h.agent?.ready){descriptor=d;headers.authorization=`Bearer ${d.token}`;ready=true;break}}}catch{}
      await new Promise(r=>setTimeout(r,100))
    }while(Date.now()<restartDeadline)
    assert.ok(ready,'Restarted Host not ready')
    const afterResponse=await getPreview();assert.equal(afterResponse.status,200,await afterResponse.clone().text());const after=await afterResponse.json();assert.equal(after.originalText,original);assert.equal(after.sessionId,before.sessionId);assert.notEqual(after.token,before.token)
    assert.equal((await post('/task/recovery',{token:before.token,mode:'retry',confirmSideEffects:true})).status,409)
    const started=await post('/task/recovery',{token:after.token,mode:'continue',confirmSideEffects:true});assert.equal(started.status,200,await started.clone().text())
    const doneDeadline=Date.now()+10000;let state
    do{state=await(await fetch(`http://127.0.0.1:${descriptor.port}/task-state`,{headers})).json();if(state.status==='idle'&&state.lastTurn)break;await new Promise(r=>setTimeout(r,20))}while(Date.now()<doneDeadline)
    assert.equal(state.status,'idle');assert.equal(existsSync(target),false);assert.match(JSON.stringify(requests.at(-1).messages),/不重复已经完成的操作/)
    console.log('PASS real Host restart resumes the same durable Session, invalidates old recovery tokens and confirms checked continuation without replay')
  }
  child.kill('SIGTERM'); await Promise.race([new Promise(r=>child.once('exit',r)),new Promise((_,r)=>setTimeout(()=>r(new Error('Host shutdown timeout')),10000).unref())]); assert.equal(code,0,output.slice(-3000)); child=null
  console.log(`PASS real Host startup, ${llm.provider}, voice NDJSON, session completion and graceful exit`)
} catch(error) {throw new Error(String(error)+'\n'+output.slice(-14000))} finally {
  if(child){const exited=code===undefined?new Promise(resolve=>child.once('exit',resolve)):Promise.resolve();child.kill('SIGKILL');await exited}
  await new Promise(r=>{mock.close(r);mock.closeAllConnections()}); rmSync(home,{recursive:true,force:true})
}
