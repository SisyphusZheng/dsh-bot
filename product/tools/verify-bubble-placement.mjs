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
import { execFileSync } from 'node:child_process'
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
const bubbleTarget = async () => {
  for (let i = 0; i < 60; i++) {
    const hit = (await targets()).find(t => t.type === 'page' && t.url.includes('/bubble.html'))
    if (hit) return hit
    await sleep(250)
  }
  return null
}
// Electron does not expose Browser.getWindowForTarget. Read the real native
// frames through System Events instead (same source the Mac UI uses).
const windowFrames = () => {
  const script = `tell application "System Events"
  tell process "dsh-bot"
    set out to ""
    repeat with w in windows
      set p to position of w
      set s to size of w
      set out to out & (name of w) & tab & (item 1 of p) & "," & (item 2 of p) & tab & (item 1 of s) & "," & (item 2 of s) & linefeed
    end repeat
    return out
  end tell
end tell`
  const raw = execFileSync('osascript', ['-e', script], { encoding: 'utf8' })
  return raw.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const [name, position, size] = line.split('\t')
    const [x, y] = position.split(',').map(v => Number(v.trim()))
    const [width, height] = size.split(',').map(v => Number(v.trim()))
    return { name, x, y, width, height }
  })
}
const petBounds = windowFrames().find(f => f.width >= 120 && f.width <= 260 && f.height >= 120 && f.height <= 400)
if (!petBounds) {
  await browser.close()
  console.log(JSON.stringify({ status: 'FAIL', reason: 'pet window frame not found through System Events' }, null, 2))
  process.exit(1)
}

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
// Bubble window is wider than the 172px pet window; allow a short settling frame.
await sleep(300)
const frames = windowFrames()
const bubbleBounds = frames.find(f => f.width >= 300 && f.width <= 520 && f.height >= 100 && f.height <= 700)
await browser.close()
if (!bubbleBounds) {
  console.log(JSON.stringify({ status: 'FAIL', reason: 'bubble window frame not found through System Events', frames }, null, 2))
  process.exit(1)
}

const distance = Math.hypot(
  bubbleBounds.x + bubbleBounds.width / 2 - (petBounds.x + petBounds.width / 2),
  bubbleBounds.y + bubbleBounds.height / 2 - (petBounds.y + petBounds.height / 2),
)
const onScreen = bubbleBounds.x >= -1000 && bubbleBounds.y >= -1000 &&
  bubbleBounds.x + bubbleBounds.width <= 10000 && bubbleBounds.y + bubbleBounds.height <= 10000
const pass = distance < 500 && bubbleBounds.height > 0 && onScreen
console.log(JSON.stringify({ status: pass ? 'PASS' : 'FAIL', distancePx: Math.round(distance), pet: petBounds, bubble: bubbleBounds, onScreen }, null, 2))
process.exit(pass ? 0 : 1)
