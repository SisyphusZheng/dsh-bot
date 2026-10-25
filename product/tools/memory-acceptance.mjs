/** Semantic retrieval and persistence acceptance against an actual running Hindsight service. */
import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const [descriptorPath,markerPath,mode='write',bridgePath]=process.argv.slice(2),d=JSON.parse(readFileSync(descriptorPath))
const call=async(path,body)=>{const r=await fetch(d.url+path,{method:'POST',headers:{authorization:`Bearer ${d.token}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});const j=await r.json();assert.equal(r.status,200,JSON.stringify(j));assert.equal(j.ok,true,JSON.stringify(j));return j}
const health=await fetch(d.url+'/health',{headers:{authorization:`Bearer ${d.token}`}});assert.equal((await health.json()).ok,true)
if(mode==='write'){
  const marker='mvp-'+Date.now()
  await call('/write',{items:[{kind:'preference',namespace:'global',text:`我喜欢无糖拿铁，常去的咖啡店叫海风咖啡。记录编号 ${marker}`}],opts:{source:{sessionId:'mvp-session-1'}}})
  writeFileSync(markerPath,JSON.stringify({marker}),{mode:0o600})
  if(bridgePath){const b=JSON.parse(readFileSync(bridgePath));const base=`http://127.0.0.1:${b.port}`;const before=await (await fetch(base+'/health')).json();const r=await fetch(base+'/conversation/new',{method:'POST',headers:{authorization:`Bearer ${b.token}`,'content-type':'application/json'},body:'{}'});assert.equal(r.status,200);const after=await(await fetch(base+'/health')).json();assert.ok(before.agent?.sessionId);assert.ok(after.agent?.sessionId);assert.notEqual(after.agent.sessionId,before.agent.sessionId)}
}
const {marker}=JSON.parse(readFileSync(markerPath))
let hits=[]
for(let i=0;i<20;i++){
  const r=await call('/search',{query:'我平常喝什么咖啡，喜欢去哪一家店？',namespaces:['global'],limit:8,budgetTokens:2000})
  hits=r.hits||[]
  if(hits.some(x=>JSON.stringify(x).includes(marker)&&JSON.stringify(x).includes('无糖拿铁')&&JSON.stringify(x).includes('海风咖啡')))break
  await new Promise(r=>setTimeout(r,1000))
}
assert.ok(hits.some(x=>JSON.stringify(x).includes(marker)&&JSON.stringify(x).includes('无糖拿铁')&&JSON.stringify(x).includes('海风咖啡')),'semantic recall did not return the retained preference')
console.log(`PASS real Hindsight semantic recall (${mode}); persisted bank ${d.bank}`)
