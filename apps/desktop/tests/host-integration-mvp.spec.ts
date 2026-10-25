import { it, expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import PermissionPresets from '@deepseek-ai/dsh-permission-presets'
import { MockAdapter, toolCallResponse, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const wait=async(test:()=>boolean):Promise<void>=>{const deadline=Date.now()+8000;while(!test()){if(Date.now()>deadline)throw new Error('condition timeout');await new Promise(r=>setTimeout(r,20))}}
for (const decision of ['allow','reject','cancel']) it(`runs DSH Session/Tool/Approval through voice: ${decision}`,async()=>{
  const home=mkdtempSync(join(tmpdir(),'mvp-agent-')),target=join(home,'outside.txt'),ctx=new Context()
  vi.stubEnv('DSH_HOME',home);vi.stubEnv('NISSE_DSH_LLM_ENTRY',resolve('packages/llm/llm/lib/index.js'))
  try {
    await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{ agents:[] });await ctx.plugin(ApprovalService);ctx.provide('shell',{ sandboxMode:'danger-full-access',resolve(){throw new Error('unused')},run(){throw new Error('unused')},start(){throw new Error('unused')} });await ctx.plugin(PermissionPresets,{ presets:{ 'bot-outside-write':{ sandbox:'danger-full-access',approval:'ask' } },defaultPreset:'bot-outside-write' })
    ctx.llm.registerAdapter(['mock'],new MockAdapter([toolCallResponse('write-1','write',{ path:target }),textResponse('finished')]))
    ctx.tools.register(defineContentToolFixture({ name:'write',description:'write a file',parameters:{ path:{ type:'string' } },execute:async()=>{writeFileSync(target,'approved');return [{ type:'text',text:'written' }]} }))
    const integration=await import(pathToFileURL(resolve('nisse/packages/host-integration/lib/index.js')).href)
    await ctx.plugin(integration,{ provider:'mock',model:'mock',permissionPreset:'bot-outside-write',workspaceDir:join(home,'workspace') })
    const file=join(home,'bot/bridge.json');await wait(()=>existsSync(file));const d=JSON.parse(readFileSync(file,'utf8'));const base=`http://127.0.0.1:${d.port}`,headers={ authorization:`Bearer ${d.token}`,'content-type':'application/json' }
    const post=(path:string,body:object)=>fetch(base+path,{ method:'POST',headers,body:JSON.stringify(body) })
    expect((await post('/sessions/create',{})).status).toBe(200)
    const response=await post('/voice/turn',{ text:'write outside workspace' });expect(response.status).toBe(200)
    const frames: { type: string; id?: string }[]=[];const reading=(async()=>{let pending='';for await(const chunk of response.body!){pending+=new TextDecoder().decode(chunk);let pos;while((pos=pending.indexOf('\n'))>=0){frames.push(JSON.parse(pending.slice(0,pos)));pending=pending.slice(pos+1)}}})()
    await wait(()=>frames.some(x=>x.type==='approval'));expect(existsSync(target)).toBe(false)
    expect((await post('/voice/turn',{ text:'concurrent' })).status).toBe(409)
    const approval=frames.find(x=>x.type==='approval')
    if (approval === undefined) throw new Error('approval frame missing')
    const answer=decision==='cancel'?await post('/cancel',{}):await post('/approval',{ id:approval.id,decision })
    expect(answer.status).toBe(200);await reading
    expect(existsSync(target)).toBe(decision==='allow');expect(frames.some(x=>x.type==='turn-end')).toBe(true)
  } finally {await ctx.fiber.dispose();vi.unstubAllEnvs();rmSync(home,{ recursive:true,force:true })}
},20000)
