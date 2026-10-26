/** Real production-profile Web boot; only the Electron callback is an explicit fixture. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { until } from './desktop-web-acceptance.mjs'

export async function smokeHostBrowser({ root, descriptor, webUrl }) {
  const {chromium}=createRequire(join(root,'packages/experimental/inspector/package.json'))('playwright')
  assert.ok(webUrl, 'production Host did not publish its Web URL')
  const health=await(await fetch(`http://127.0.0.1:${descriptor.port}/health`)).json(),expected=health.agent.sessionId
  const browser=await chromium.launch({headless:true,...(process.env.DSH_CHROMIUM_EXECUTABLE?{executablePath:process.env.DSH_CHROMIUM_EXECUTABLE}:{}),args:process.platform==='linux'?['--no-sandbox','--single-process','--no-zygote','--disable-gpu','--disable-dev-shm-usage']:[]})
  try {
    const context=await browser.newContext()
    await context.addInitScript(sessionId=>{globalThis.dshDesktop={onPetSession(fn){try{fn(sessionId)}catch(error){console.error("pet callback",error);throw error}return()=>{}}}},expected)
    const page=await context.newPage(),errors=[]
    page.on('pageerror',error=>errors.push(error.message))
    page.on('console',message=>{if(message.type()==='error')errors.push(message.text())})
    await page.goto(webUrl)
    try { await until(async()=>{
      const state=await page.evaluate(()=>({failed:document.querySelector('[data-dsh-boot]')?.textContent?.includes('Failed to load plugins'),ready:!document.querySelector('[data-dsh-boot]')&&!!document.querySelector('#root > *')}))
      if(state.failed)throw Object.assign(new Error('production web boot failed'),{fatal:true})
      return state.ready
    },{label:'production Web boot'}) }
    catch(error) { throw new Error(`${error.message}; renderer errors: ${JSON.stringify(errors)}; boot: ${await page.locator('[data-dsh-boot]').textContent().catch(()=>null)}`) }
    await page.waitForFunction(id=>JSON.parse(localStorage.getItem('dsh.sessions.current')||'{}').sessionId===id,expected)
    assert.deepEqual(errors,[])
    console.log('PASS complete production Web UI and official same-Bot Session navigation')
    // Replace only this product's bytes with its previous raw ESM. Other shipped plugins remain real.
    const invalid=context,old=readFileSync(join(root,'nisse/packages/host-integration/src/client/index.js'),'utf8').trim(),built=readFileSync(join(root,'nisse/packages/host-integration/lib/client.js'),'utf8').replace(/\/\/# sourceMappingURL=.*$/m,'').trim()
    let replaced=false
    await invalid.route(url=>url.pathname.startsWith('/plugins/')&&url.href.includes('client.js'),async route=>{
      const response=await route.fetch(),body=await response.text()
      if(body.includes(built)){replaced=true;await route.fulfill({response,body:body.replace(built,old)})}
      else await route.fulfill({response})
    })
    const broken=page
    await broken.goto(webUrl)
    await broken.waitForFunction(()=>document.querySelector('[data-dsh-boot]')?.textContent?.includes('nisse-host-integration'))
    assert.equal(replaced,true,'negative control never reached the shipped Client bundle')
    await invalid.unrouteAll({behavior:'wait'})
    await invalid.close()
    console.log('PASS full production Web boot and official Bot Session selection in Chromium; previous raw ESM fails the same real loader (Electron callback fixture only)')
  } finally {await browser.close()}
}
