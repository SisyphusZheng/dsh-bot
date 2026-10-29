#!/usr/bin/env node
/**
 * Native bubble placement check against a running Electron app.
 *
 * Prereq: the app was launched with --remote-debugging-port=0 and writes
 * <user-data>/DevToolsActivePort plus dsh-home/bot/bridge.json.
 *
 * This is a measurement tool, not a replacement for LaunchServices acceptance.
 * It triggers one short assistant turn, then reads the real native window
 * frames through CDP. The bubble must stay near the pet and inside the screen.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const userData = process.argv[2]
if (!userData) {
  console.error('usage: node product/tools/verify-bubble-placement.mjs <user-data-dir>')
  process.exit(2)
}
const devtools = readFileSync(join(userData, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/)
const port = devtools[0]
const descriptor = JSON.parse(readFileSync(join(userData, 'dsh-home/bot/bridge.json'), 'utf8'))
const { chromium } = await import('playwright').catch(() => import(resolve(root, 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs')))

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const cdp = await browser.newBrowserCDPSession()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const targets = async () => (await cdp.send('Target.getTargets')).targetInfos
const mainTarget = async () => {
  for (let i = 0; i < 40; i++) {
    const hit = (await targets()).find(t => t.type === 'page' && t.title === 'dsh-bot' && !t.url.includes('/bubble.html'))
    if (hit) return hit
    await sleep(250)
  }
  throw new Error('pet page target not found')
}
const bubbleTarget = async () => {
  for (let i = 0; i < 60; i++) {
    const hit = (await targets()).find(t => t.type === 'page' && t.url.includes('/bubble.html'))
    if (hit) return hit
    await sleep(250)
  }
  return null
}
const windowOf = async targetId => (await cdp.send('Browser.getWindowForTarget', { targetId })).bounds

const pet = await mainTarget()
const petBounds = await windowOf(pet.targetId)

// Fire one short turn through the same authenticated bridge the pet uses.
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 2000)
void fetch(`http://127.0.0.1:${descriptor.port}/voice/turn`, {
  method: 'POST',
  headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ text: '只回复：气泡位置验证' }),
  signal: controller.signal,
}).catch(() => {}).finally(() => clearTimeout(timer))

const bubble = await bubbleTarget()
if (!bubble) {
  await browser.close()
  console.log(JSON.stringify({ status: 'FAIL', reason: 'bubble window did not appear', pet: petBounds }, null, 2))
  process.exit(1)
}
const bubbleBounds = await windowOf(bubble.targetId)
await browser.close()

const distance = Math.hypot(
  bubbleBounds.left + bubbleBounds.width / 2 - (petBounds.left + petBounds.width / 2),
  bubbleBounds.top + bubbleBounds.height / 2 - (petBounds.top + petBounds.height / 2),
)
const screen = { left: 0, top: 0, width: 2560, height: 1440 } // bounds are checked for sanity only
const onScreen = bubbleBounds.left >= 0 && bubbleBounds.top >= 0 &&
  bubbleBounds.left + bubbleBounds.width <= screen.width + 2000 &&
  bubbleBounds.top + bubbleBounds.height <= screen.height + 1000
const pass = distance < 500 && bubbleBounds.height > 0 && onScreen
console.log(JSON.stringify({ status: pass ? 'PASS' : 'FAIL', distancePx: Math.round(distance), pet: petBounds, bubble: bubbleBounds, onScreen }, null, 2))
process.exit(pass ? 0 : 1)
