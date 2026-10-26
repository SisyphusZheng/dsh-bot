import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {waitAgentReady} from '../wait-agent-ready.mjs'
async function fixture(health,run){
 const root=mkdtempSync(join(tmpdir(),'pet-ready-'));const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(health()))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const file=join(root,'bridge.json');writeFileSync(file,JSON.stringify({port:server.address().port,pid:42}))
 try{await run(file)}finally{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});rmSync(root,{recursive:true,force:true})}
}
test('a published descriptor and healthy HTTP listener do not mean the Agent is ready',async()=>{
 let calls=0
 await fixture(()=>({pid:42,agent:++calls>2?{ready:true,sessionId:'session'}:{ready:false,sessionId:null}}),async file=>{
  const result=await waitAgentReady(file,{intervalMs:1,timeoutMs:3000});assert.equal(result.health.agent.sessionId,'session');assert.ok(calls>=3)
 })
})
test('a known startup failure is reported immediately',async()=>{
 await fixture(()=>({pid:42,agent:{ready:false,lastStartupError:'missing runtime'}}),file=>assert.rejects(waitAgentReady(file),/missing runtime/))
})
test('a different process cannot satisfy readiness through a reused port',async()=>{
 await fixture(()=>({pid:99,agent:{ready:true,sessionId:'wrong'}}),file=>assert.rejects(waitAgentReady(file,{intervalMs:1,timeoutMs:15}),/deadline/))
})
