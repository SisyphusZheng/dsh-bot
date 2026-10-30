/** Shipped SDK -> real WebRTC/Pipecat -> explicit local provider and Bridge fixtures. */
import { createServer, request as httpRequest } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../..'), directory = mkdtempSync(join(tmpdir(), 'pet-media-'))
const greeting = '你好，我在呢。想聊什么，或者有什么需要我帮忙的？'
const passive = process.env.DSH_MEDIA_PASSIVE === '1', interaction = process.env.DSH_MEDIA_INTERACTION || ''
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
  child = spawn(resolve(process.argv[2] || '.mvv-build/voice-venv/bin/python'), [join(root, 'product/voice-worker-src/fixtures/media_fixture.py'), '0', '0', '0', join(directory, 'bridge.json')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', MEDIA_HOLD_TURN: '1', MEDIA_INTERACTION: interaction, DSH_VOICE_GREETING: greeting } })
  child.stdout.on('data', d => { log += d }); child.stderr.on('data', d => { log += d })
  const deadline = Date.now() + 90000
  while (true) { try { const endpoints=JSON.parse(readFileSync(join(directory,'bridge.json'),'utf8')); port=endpoints.workerPort; bridgePort=endpoints.port; if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break } catch {} if (Date.now() > deadline || child.exitCode !== null || child.signalCode !== null) throw new Error('worker not ready\n' + log); await new Promise(r => setTimeout(r, 100)) }
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true, ...(process.env.DSH_CHROMIUM_EXECUTABLE ? { executablePath: process.env.DSH_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox', '--no-zygote', '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-gpu', '--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
  const context = await browser.newContext({ viewport: { width: 172, height: 204 } }); await context.grantPermissions(['microphone'], { origin })
  await context.exposeBinding('reportVoice', async (_source, value) => {statuses.push(value);if(value.kind==='question-answer')await questionPresenter?.voiceAnswer(value.data)})
  await context.addInitScript(({ origin, passive }) => { window.petBridge = { preferences:async()=>({voiceInput:{mode:passive?'always':'hold'},language:'zh'}),state: async () => ({ phase: 'available', offerUrl: origin + '/api/offer' }), voiceStatus: value => window.reportVoice(value), onVoice() {}, onVoiceCommand: f => { window.voiceCommand = f }, onPresentation() {}, hit() {}, dragStart() {}, dragMove() {}, dragEnd() {}, openMain() {}, menu() {}, cancel() {} } }, { origin, passive })
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', message => { log += '\n[browser] ' + message.text() }); page.on('request', request => requests.push(request.url()))
  await page.goto(origin + '/pet.html'); await page.locator('#pet').hover(); await page.waitForFunction(() => getComputedStyle(document.getElementById('controls')).opacity === '1'); if(!passive) await page.locator('#microphone').click()
  await page.waitForFunction(() => document.body.dataset.microphone === 'on', null, { timeout: 45000 })
  const until = async check => { const end = Date.now() + 20000; while (!check()) { if (Date.now() > end) throw new Error('voice output deadline'); await new Promise(r => setTimeout(r, 50)) } }
  // Worker v2 contract: business text (greeting/reply/prompt) comes from the fixture Host as
  // speech.append commands and is spoken as TTS. The worker no longer emits RTVI greeting /
  // input-confirmation / question-answer business statuses; those are asserted from the Host
  // fixture state/speech and from /stats metrics instead.
  const fixtureJson = async path => (await fetch(`http://127.0.0.1:${bridgePort}${path}`, { headers: { Authorization: 'Bearer bridge-fixture' } })).json()
  const spokenTexts = async () => (await fixtureJson('/fixture-speech')).spoken
  const diagnostics = async () => { try { const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json(); const stats = await (await fetch(`http://127.0.0.1:${port}/stats`, { headers: { 'x-spike-token': 'media-fixture' } })).json(); const state = await fixtureJson('/fixture-state'); const speech = await fixtureJson('/fixture-speech'); return JSON.stringify({ worker: { mode: health.mode, transport: health.transport, host: health.host, last_error: health.last_error }, stats: Object.values(stats.sessions || {})[0]?.dsh, fixtureState: state, spoken: speech.spoken, statuses: statuses.map(x => x.kind) }) } catch (error) { return 'diagnostics failed: ' + error.message } }
  const untilSpoken = async (pattern, label) => { const end = Date.now() + 30000; while (Date.now() < end) { if ((await spokenTexts()).some(text => pattern.test(text))) return; await new Promise(r => setTimeout(r, 100)) } throw new Error('Host speech.append deadline: ' + label + '\n' + await diagnostics()) }
  await until(() => statuses.some(x => x.kind === 'input' && /请记录测试偏好/.test(x.text)))
  await untilSpoken(/你好，我在呢/, 'welcome greeting')
  assert.equal((await spokenTexts()).filter(text => /你好，我在呢/.test(text)).length, 1, 'welcome greeting must be spoken exactly once')
  assert.ok(!statuses.some(x => x.kind === 'greeting' || x.kind === 'input-confirmation' || x.kind === 'question-answer' || x.kind === 'queue-state'), 'legacy RTVI business statuses must be gone after the worker v2 migration')
  await untilSpoken(/已收到测试请求/, 'Bridge reply')
  if(interaction) await untilSpoken(interaction==='question'?/需要你回答/:/需要你批准/, 'interaction prompt')
  if(passive) assert.match(await page.locator('#voice-state').innerText(),/常听/)
  if(interaction==='question'){
    // The desktop answer path is covered by the Host kernel tests; here the fixture Host records the
    // answer only after the injected final ASR fact reaches it through the worker's voice.facts.
    await fetch(`http://127.0.0.1:${bridgePort}/fixture-inject-answer`,{method:'POST'})
    let answered={answers:[]}
    const answerEnd=Date.now()+20000
    while(Date.now()<answerEnd){ answered=await fixtureJson('/fixture-answers'); if(answered.answers.length) break; await new Promise(r=>setTimeout(r,100)) }
    assert.equal(answered.answers.length,1,'fixture Host must receive exactly one answer through voice.facts')
    assert.equal(answered.answers[0].answer.answers[0].selected[0],'新文章')
    assert.equal((await fixtureJson('/fixture-state')).started,1,'Question answer must not create a new task')
    await untilSpoken(/已记录你的选择/, 'answer receipt')
  }
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
  const expectedMinResponses = interaction ? 3 : 2
  let metrics, stats
  for (let attempt = 0; attempt < 200; attempt++) { stats = await (await fetch(`http://127.0.0.1:${port}/stats`, { headers: { 'x-spike-token': 'media-fixture' } })).json(); metrics = Object.values(stats.sessions)[0]; const state = await fixtureJson('/fixture-state'); if ((metrics?.tts?.responses ?? 0) >= expectedMinResponses && state.finished === 1) break; await new Promise(r => setTimeout(r, 50)) }
  assert.deepEqual(await fixtureJson('/fixture-state'),{started:1,finished:1,cancels:0,disconnects:0})
  assert.ok(metrics.tts.responses >= expectedMinResponses, `welcome, Bridge reply and optional interaction prompt must be spoken (got ${metrics.tts.responses}, expected >= ${expectedMinResponses})`)
  // Worker v2 /stats contract: business turn counters are gone; media/fact/command counters are the evidence.
  const dsh = metrics.dsh
  assert.equal(dsh.turns_completed, undefined, 'dsh.turns_completed must be removed by the worker v2 migration')
  assert.ok(dsh.final_facts >= 1, 'final ASR facts were sent to the Host')
  assert.ok(dsh.facts_sent >= 1, 'voice.facts batches were sent')
  assert.ok(dsh.playbacks_started >= 1, 'Host speech.append started a playback')
  assert.ok(dsh.playbacks_ended >= 1, 'playbacks reported ended')
  assert.ok(dsh.speech_appends >= 1, 'speech.append commands were applied')
  assert.ok(dsh.commands_applied >= 1, 'Host commands were applied')
  assert.ok(dsh.transport_connected >= 1, 'voice.session connected was sent')
  assert.equal(dsh.facts_failed, 0)
  assert.equal(dsh.ack_failures, 0)
  const speech=await fixtureJson('/fixture-speech')
  assert.ok(speech.spoken.every(text=>!text.includes('**')&&!text.includes('PRIVATE-COMMAND')))
  assert.equal(speech.spoken.filter(text=>/你好，我在呢/.test(text)).length,1,'welcome greeting spoken once (no duplicate TTS for the ASR echo)')
  if(interaction) assert.equal(speech.spoken.filter(text=>interaction==='question'?text.includes('需要你回答'):text.includes('需要你批准')).length,1)
  assert.ok(requests.every(url => url.startsWith(origin + '/') || url.startsWith('blob:')), 'no media CDN or telemetry requests')
  assert.equal((await fixtureJson('/fixture-state')).started,1,'ASR echo/noise fragments must not start an extra Host turn')
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
