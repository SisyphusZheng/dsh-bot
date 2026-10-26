/** Inspect the actual packaged renderer through a temporary loopback DevTools port. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { waitAgentReady } from './wait-agent-ready.mjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
export async function until(check, { timeoutMs = 60000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = 'not available'
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value } catch (error) {
      if (error.fatal) throw error
      last = error.message
    }
    await pause(intervalMs)
  }
  throw new Error(`${label} deadline: ${last}`)
}

/** One page connection; closing it never requests Browser.close or terminates the App. */
export async function connectPage(url) {
  const socket = new WebSocket(url), pending = new Map()
  let serial = 0
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), operation = pending.get(message.id)
    if (!operation) return
    pending.delete(message.id); clearTimeout(operation.timer)
    if (message.error) operation.reject(new Error(message.error.message)); else operation.resolve(message.result)
  })
  const fail = () => { for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(new Error('DevTools connection closed')) } pending.clear() }
  socket.addEventListener('close', fail)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('DevTools connection deadline')) }, 10000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('DevTools connection failed')) }, { once: true })
  })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools ${method} deadline`)) }, 10000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  return {
    call,
    async evaluate(expression) {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
      return result.result.value
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return
      const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }))
      socket.close(); await closed
    },
  }
}

export async function acceptDesktopWeb(userData, bridgePath, evidencePath) {
  const [port] = await until(() => readFileSync(join(userData, 'DevToolsActivePort'), 'utf8').trim().split('\n'), { label: 'DevTools startup' })
  if (!/^\d+$/.test(port)) throw new Error('Invalid DevTools port')
  const pages = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
    return (await response.json()).filter(item => item.type === 'page')
  }
  let pet, main
  try {
    const petTarget = await until(async () => (await pages()).find(item => /^http:\/\/127\.0\.0\.1:\d+\/[^/]+\/index\.html$/.test(item.url)), { label: 'pet document' })
    pet = await connectPage(petTarget.webSocketDebuggerUrl)
    const point = await until(() => pet.evaluate(`(() => {
      const canvas = document.querySelector('canvas'); if (!canvas) return null;
      const rect = canvas.getBoundingClientRect(), {data} = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height);
      for(let y=Math.floor(canvas.height/2);y<canvas.height;y++) for(let x=Math.floor(canvas.width/2);x<canvas.width;x++)
        if(data[(y*canvas.width+x)*4+3]>200) return {x:rect.x+x/canvas.width*rect.width,y:rect.y+y/canvas.height*rect.height};
      return null;
    })()`), { label: 'painted pet sprite' })
    await pet.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    for (const clickCount of [1, 2]) {
      await pet.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount, ...point })
      await pet.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount, ...point })
    }
    const appTarget = await until(async () => (await pages()).find(item => item.url.startsWith('dsh-app://app/')), { label: 'double-click opens DSH' })
    main = await connectPage(appTarget.webSocketDebuggerUrl)
    await until(async () => {
      const state = await main.evaluate(`(() => {const boot=document.querySelector('[data-dsh-boot]');return {boot:!!boot,failed:boot?.textContent?.includes('Failed to load plugins'),text:boot?.textContent, mounted:!!document.querySelector('#root > *')};})()`)
      if (state.failed) throw Object.assign(new Error(`web boot failed: ${state.text}`), { fatal: true })
      return !state.boot && state.mounted
    }, { label: 'web boot' })
    const { health } = await waitAgentReady(bridgePath)
    const expected = health.agent.sessionId
    await until(async () => (await main.evaluate(`JSON.parse(localStorage.getItem('dsh.sessions.current') || '{}').sessionId`)) === expected, { label: 'pet selects the actual Bot Session' })
    const shot = await main.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(evidencePath.replace(/\.json$/, '.png'), Buffer.from(shot.data, 'base64'))
    const result = { status: 'PASS', webBoot: 'PASS', petDoubleClick: 'PASS', botSessionSelection: 'PASS', sessionId: expected, scope: 'actual packaged documents and official workspace selection; OS click-through/TCC remain manual' }
    writeFileSync(evidencePath, JSON.stringify(result, null, 2) + '\n')
    return result
  } catch (error) {
    if (main) {
      try {
        const shot = await main.call('Page.captureScreenshot', { format: 'png' })
        writeFileSync(evidencePath.replace(/\.json$/, '.png'), Buffer.from(shot.data, 'base64'))
      } catch (captureError) { console.error('Unable to capture failed renderer:', captureError.message) }
    }
    writeFileSync(evidencePath, JSON.stringify({ status: 'FAIL', error: error.message }, null, 2) + '\n')
    throw error
  } finally { await main?.close(); await pet?.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [userData, bridge, evidence] = process.argv.slice(2)
  await acceptDesktopWeb(userData, bridge, evidence)
  console.log('PASS web boot, actual sprite double-click and matching Bot Session selection')
}
