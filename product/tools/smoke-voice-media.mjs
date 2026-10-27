/** Shipped SDK -> real WebRTC/Pipecat -> explicit local provider and Bridge fixtures. */
import { createServer, request as httpRequest } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../..'), directory = mkdtempSync(join(tmpdir(), 'pet-media-'))
const { chromium } = createRequire(join(root, 'packages/experimental/inspector/package.json'))('playwright')
let port, bridgePort
let child, browser, log = '', statuses = [], requests = []
const evidence = resolve(root, '.mvv-build/evidence/voice-media'); mkdirSync(evidence, { recursive: true })
const files = new Map(['pet.html', 'voice-client.js'].map(name => ['/' + name, join(root, 'apps/desktop/resources/pet', name)]))
for (const name of ['pet.json', 'spritesheet.webp']) files.set('/skins/whale-girl/' + name, join(root, 'apps/desktop/resources/whale-girl', name))
const server = createServer((req, res) => {
  if (req.url === '/api/offer') { const proxy = httpRequest({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: { 'content-type': 'application/json', 'x-spike-token': 'media-fixture' } }, reply => { res.writeHead(reply.statusCode, { 'content-type': 'application/json' }); reply.pipe(res) }); proxy.on('error', () => { res.writeHead(502); res.end() }); req.pipe(proxy); return }
  const file = files.get(req.url); if (!file) { res.writeHead(404); res.end(); return }
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline' blob:; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; media-src 'self' blob:")
  res.setHeader('content-type', file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : 'image/webp'); res.end(readFileSync(file))
})
try {
  child = spawn(resolve(process.argv[2] || '.mvv-build/voice-venv/bin/python'), [join(root, 'product/voice-worker-src/fixtures/media_fixture.py'), '0', '0', '0', join(directory, 'bridge.json')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', MEDIA_HOLD_TURN: '1' } })
  child.stdout.on('data', d => { log += d }); child.stderr.on('data', d => { log += d })
  const deadline = Date.now() + 90000
  while (true) { try { const endpoints=JSON.parse(readFileSync(join(directory,'bridge.json'),'utf8')); port=endpoints.workerPort; bridgePort=endpoints.port; if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break } catch {} if (Date.now() > deadline || child.exitCode !== null || child.signalCode !== null) throw new Error('worker not ready\n' + log); await new Promise(r => setTimeout(r, 100)) }
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true, ...(process.env.DSH_CHROMIUM_EXECUTABLE ? { executablePath: process.env.DSH_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox', '--no-zygote', '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-gpu', '--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
  const context = await browser.newContext({ viewport: { width: 172, height: 204 } }); await context.grantPermissions(['microphone'], { origin })
  await context.exposeBinding('reportVoice', (_source, value) => statuses.push(value))
  await context.addInitScript(({ origin }) => { window.petBridge = { state: async () => ({ phase: 'available', offerUrl: origin + '/api/offer' }), voiceStatus: value => window.reportVoice(value), onVoice() {}, onVoiceCommand: f => { window.voiceCommand = f }, onPresentation() {}, hit() {}, dragStart() {}, dragMove() {}, dragEnd() {}, openMain() {}, menu() {}, cancel() {} } }, { origin })
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', message => { log += '\n[browser] ' + message.text() }); page.on('request', request => requests.push(request.url()))
  await page.goto(origin + '/pet.html'); await page.locator('#pet').hover(); await page.waitForFunction(() => getComputedStyle(document.getElementById('controls')).opacity === '1'); await page.locator('#microphone').click()
  await page.waitForFunction(() => document.body.dataset.microphone === 'on', null, { timeout: 45000 })
  const until = async check => { const end = Date.now() + 20000; while (!check()) { if (Date.now() > end) throw new Error('voice output deadline'); await new Promise(r => setTimeout(r, 50)) } }
  await until(() => statuses.some(x => x.kind === 'speech' && /你好，我在呢/.test(x.text)))
  await until(() => statuses.some(x => x.kind === 'input' && /请记录测试偏好/.test(x.text)))
  await until(() => statuses.some(x => x.kind === 'speech' && /已收到测试请求/.test(x.text)))
  await page.waitForFunction(() => document.getElementById('speaker').currentTime > 0.1)
  await page.waitForFunction(() => Number(document.getElementById('level').getAttribute('aria-valuenow')) > 0)
  // Discard the current capture during an unfinished Bridge task. Media and task survive.
  const captureId = statuses.find(x => x.kind === 'input')?.captureId
  assert.ok(captureId)
  assert.equal(statuses.find(x=>x.kind==='media')?.mediaSettings.echoCancellation,true)
  await page.evaluate(captureId => window.voiceCommand({action:'discard',captureId}), captureId)
  await page.waitForFunction(() => document.body.dataset.microphone === 'off')
  const before = await (await fetch(`http://127.0.0.1:${bridgePort}/fixture-state`)).json()
  assert.deepEqual(before,{started:1,finished:0,cancels:0,disconnects:0})
  assert.equal(await page.evaluate(() => document.getElementById('speaker').srcObject.getTracks().some(t=>t.readyState==='live')),true)
  await fetch(`http://127.0.0.1:${bridgePort}/fixture-release`,{method:'POST'})
  let metrics
  for (let attempt = 0; attempt < 100; attempt++) { const stats = await (await fetch(`http://127.0.0.1:${port}/stats`, { headers: { 'x-spike-token': 'media-fixture' } })).json(); metrics = Object.values(stats.sessions)[0]; if (metrics?.tts?.responses === 2 && metrics?.dsh?.turns_completed === 1) break; await new Promise(r => setTimeout(r, 50)) }
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${bridgePort}/fixture-state`)).json(),{started:1,finished:1,cancels:0,disconnects:0})
  assert.equal(metrics.tts.responses, 2, 'one welcome synthesis and one Bridge response'); assert.equal(metrics.dsh.turns_completed, 1)
  assert.ok(requests.every(url => url.startsWith(origin + '/') || url.startsWith('blob:')), 'no media CDN or telemetry requests')
  assert.ok(!statuses.some(x=>x.kind==='input'&&/^(嗯。|你好，我在呢。)$/.test(x.text)), 'echo/noise reached the input bubble')
  assert.ok(!log.includes('[g3-probe]'),'debug probes must be off by default')
  writeFileSync(join(evidence, 'metrics.json'), JSON.stringify(metrics, null, 2)); await page.screenshot({ path: join(evidence, 'listening.png') })
  await page.evaluate(() => window.voiceCommand({ action: 'mute' })); await page.waitForFunction(() => document.body.dataset.microphone === 'off')
  assert.equal(await page.evaluate(() => document.getElementById('speaker').srcObject.getTracks().some(track => track.readyState === 'live')), true)
  await page.evaluate(() => window.voiceCommand({ action: 'enable' })); await page.waitForFunction(() => document.body.dataset.microphone === 'on')
  await page.evaluate(() => window.voiceCommand({ action: 'disable' })); await page.waitForFunction(() => !document.getElementById('speaker').srcObject); assert.deepEqual(errors, [])
  console.log('PASS shipped SDK + real Pipecat/WebRTC handshake, microphone meter, ASR text, one welcome, Bridge reply, audio-track playback, AEC constraints, capture discard during an active task (zero cancel/disconnect), mute/resume/disconnect. Provider/Bridge fixtures; not macOS or real-provider acceptance.')
} catch (error) { throw new Error(`${error.stack}\n${log.slice(-16000)}`) }
finally {
  await browser?.close(); await new Promise(r => { server.close(r); server.closeAllConnections() })
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(r => child.once('close', r)), new Promise(r => setTimeout(r, 5000))]); if (child.exitCode === null && child.signalCode === null) { const ended = new Promise(r => child.once('close', r)); child.kill('SIGKILL'); await ended } }
  writeFileSync(join(evidence, 'worker.log'), log); writeFileSync(join(evidence, 'statuses.json'), JSON.stringify(statuses, null, 2)); rmSync(directory, { recursive: true, force: true })
}
