import { VoiceWorkerSupervisor } from '../pet/src/voice-worker-supervisor.mjs'
import { createServer } from 'node:net'
import { resolve, dirname } from 'node:path'
import assert from 'node:assert/strict'
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r))
const binary=process.argv[2]==='--binary', command=resolve(process.argv[binary?3:2] || '../dependencies/voice-venv/bin/python')
const cwd=binary?dirname(command):resolve(import.meta.dirname,'../voice-worker-src')
let log=''
const supervisor=new VoiceWorkerSupervisor({command,args:binary?[]:[resolve(cwd,'run_worker.py')],cwd,env:{...process.env,G1_MODE:'dsh',SPIKE_TOKEN:'mvp-signaling-test',DASHSCOPE_API_KEY:'',NISSE_VOICE_WORKER_PORT:String(port)},healthUrl:`http://127.0.0.1:${port}/health`,startupTimeoutMs:30000,restart:false,log:(...x)=>{log=(log+'\n'+x.join(' ')).slice(-8000)}})
try {
  await supervisor.start();assert.equal(supervisor.state,'running',log)
  const h=await (await fetch(supervisor.healthUrl)).json();assert.equal(h.mode,'dsh')
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/offer`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401)
  await supervisor.stop();assert.equal(supervisor.state,'stopped');await assert.rejects(fetch(supervisor.healthUrl))
  console.log('PASS real Pipecat/WebRTC worker startup, signaling authentication, supervision and shutdown')
} catch(error){throw new Error(String(error)+'\n'+log)} finally {await supervisor.stop()}
