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
const mock = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk
  if (req.url?.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({data:[{id:'mvp-local'}]})); return }
  res.writeHead(200, {'content-type':'text/event-stream'})
  const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
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
  const response=await fetch(`http://127.0.0.1:${descriptor.port}/voice/turn`,{method:'POST',headers:{authorization:`Bearer ${descriptor.token}`,'content-type':'application/json'},body:JSON.stringify({text:'Please say the smoke result.'}),signal:AbortSignal.timeout(30000)})
  assert.equal(response.status,200)
  const frames=(await response.text()).trim().split('\n').map(x=>JSON.parse(x))
  assert.ok(frames.some(x=>x.type==='admitted'))
  assert.ok(frames.some(x=>x.type==='turn-end' && x.reason?.kind==='completed'),JSON.stringify(frames))
  assert.match(frames.filter(x=>x.type==='text').map(x=>x.text).join(''),/MVP profile smoke passed/)
  child.kill('SIGTERM'); await Promise.race([new Promise(r=>child.once('exit',r)),new Promise((_,r)=>setTimeout(()=>r(new Error('Host shutdown timeout')),10000).unref())]); assert.equal(code,0,output.slice(-3000)); child=null
  console.log(`PASS real Host startup, ${llm.provider}, voice NDJSON, session completion and graceful exit`)
} finally {
  child?.kill('SIGKILL'); await new Promise(r=>{mock.close(r);mock.closeAllConnections()}); rmSync(home,{recursive:true,force:true})
}
