import { it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { botHostEnvironment } from '../src/bot-host-environment.ts'
import { startBotConfigServer } from '../src/bot-config-server.ts'
import { MemoryRuntime } from '../src/memory-runtime.ts'
import { BotRuntime } from '../src/bot-runtime.ts'

it('keeps current owned runtime and keys while rejecting login-shell injection', () => {
  expect(botHostEnvironment({ PATH:'/bin',DSH_HOME:'/foreign',NISSE_DSH_LLM_ENTRY:'/wrong',WHALEGIRL_PROJECT_ROOT:'/foreign',OPENAI_API_KEY:'old' }, { DSH_HOME:'/private',NISSE_DSH_LLM_ENTRY:'/real',OPENAI_API_KEY:'new' })).toEqual({ PATH:'/bin',DSH_HOME:'/private',NISSE_DSH_LLM_ENTRY:'/real',OPENAI_API_KEY:'new' })
})
it('allows the application origin and authenticates approval mutations', async () => {
  const home=mkdtempSync(join(tmpdir(),'mvp-api-')); let decisions=0
  const server=await startBotConfigServer(home,0,{ onApproval:async()=>{decisions++;return { ok:true }} })
  const base=`http://127.0.0.1:${server.port}`
  try {
    const headers={ origin:'dsh-app://app','sec-fetch-site':'cross-site','x-dsh-bot-token':server.token }
    const r=await fetch(base+'/bot/config',{ headers }); expect(r.status).toBe(200);expect(r.headers.get('access-control-allow-origin')).toBe('dsh-app://app')
    expect((await fetch(base+'/bot/config',{ headers:{ origin:'https://evil.example' } })).status).toBe(403)
    expect((await fetch(base+'/bot/approval',{ method:'POST',headers:{ origin:'dsh-app://app' },body:'{}' })).status).toBe(401)
    expect((await fetch(base+'/bot/approval',{ method:'POST',headers:{ ...headers,'x-dsh-bot-token':server.token },body:'{}' })).status).toBe(200);expect(decisions).toBe(1)
    expect((await fetch(base+'/bot/approval',{ method:'OPTIONS',headers })).status).toBe(204)
    const page=await fetch(base+'/bot/settings?token='+server.token,{ headers });expect(page.status).toBe(200);expect(page.headers.get('content-security-policy')).toContain('dsh-app://app');expect(await page.text()).toContain(server.token)
  } finally {await server.close();rmSync(home,{ recursive:true,force:true })}
})
it('resolves the official compiled LLM from the runtime contract and clears managed keys', () => {
  const home=mkdtempSync(join(tmpdir(),'mvp-profile-'));vi.stubEnv('WHALEGIRL_HOST_INTEGRATION_DIR',resolve('nisse/packages/host-integration'))
  try {
    const runtime=new BotRuntime(home,home,undefined,resolve('apps/cli'))
    runtime.prepare({ llm:{ provider:'custom',model:'mvp',apiKey:'test-key',baseUrl:'http://127.0.0.1:9876/v1' } })
    expect(runtime.status().error).toBe('');expect(existsSync(process.env.NISSE_DSH_LLM_ENTRY!)).toBe(true)
    const patch=readFileSync(join(home,'profiles/desktop/cordis.patch.yml'),'utf8');expect(patch).toContain('openai-completions');expect(patch).toContain(join(home,'bot'));expect(patch).not.toContain('test-key');expect(patch).not.toContain('whalegirl-g2')
    expect(statSync(join(home,'profiles/desktop/cordis.patch.yml')).mode & 0o777).toBe(0o600)
    runtime.prepare({ llm:{ provider:'custom',apiKey:'' } });expect(process.env.WHALEGIRL_LLM_API_KEY).not.toBe('test-key')
  } finally {vi.unstubAllEnvs();rmSync(home,{ recursive:true,force:true })}
})
it('runs the real authenticated adapter, waits for bank bootstrap and preserves data over restart', async () => {
  const home=mkdtempSync(join(tmpdir(),'mvp-memory-'))
  let bankRequests=0
  const backend=createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url?.includes('/banks/'))bankRequests++;res.end(JSON.stringify(req.url==='/version'?{ version:'1.0.0' }:{ ok:true }))})
  await new Promise<void>(r=>backend.listen(0,'127.0.0.1',r));const address=backend.address();if(typeof address!=='object'||address===null)throw new Error('port')
  vi.stubEnv('NISSE_MEMORY_DIR',resolve('product/memory'));vi.stubEnv('NISSE_HINDSIGHT_URL',`http://127.0.0.1:${address.port}`)
  const runtime=new MemoryRuntime(home,home,resolve('apps/desktop'),true,{ server:2000,sidecar:5000 })
  try {
    expect((await runtime.start()).phase).toBe('ready');expect(bankRequests).toBeGreaterThan(0)
    const first=runtime.url!;expect((await fetch(first+'/health')).status).toBe(401)
    const marker=join(runtime.dataRoot,'keep.txt');writeFileSync(marker,'persistent')
    expect(statSync(join(runtime.dataRoot,'runtime.json')).mode & 0o777).toBe(0o600)
    expect((await runtime.stop()).phase).toBe('disabled');await expect(fetch(first+'/health')).rejects.toThrow();expect(existsSync(join(runtime.dataRoot,'runtime.json'))).toBe(false)
    expect((await runtime.start()).phase).toBe('ready');expect(readFileSync(marker,'utf8')).toBe('persistent')
  } finally {
    await runtime.stop();vi.unstubAllEnvs()
    await new Promise<void>((r)=>{backend.close(()=>r());backend.closeAllConnections()})
    rmSync(home,{ recursive:true,force:true })
  }
},20000)
it('abort during startup never publishes a ready descriptor', async()=>{
  const home=mkdtempSync(join(tmpdir(),'mvp-abort-'));vi.stubEnv('NISSE_HINDSIGHT_URL','http://127.0.0.1:1')
  const runtime=new MemoryRuntime(home,home,resolve('apps/desktop'),true,{ server:2000,sidecar:2000 })
  try {const start=runtime.start();await runtime.stop();expect((await start).phase).toBe('disabled');expect(runtime.status().phase).toBe('disabled');expect(existsSync(join(runtime.dataRoot,'runtime.json'))).toBe(false)}finally{await runtime.stop();vi.unstubAllEnvs();rmSync(home,{ recursive:true,force:true })}
})
