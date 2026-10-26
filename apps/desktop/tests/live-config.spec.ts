import { it, expect } from 'vitest'
import { WebSocketServer } from 'ws'
import { testVoiceProvider, testLlmProvider } from '../src/bot-providers.ts'
import { startBotConfigServer } from '../src/bot-config-server.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
it('rejects unauthenticated local operations and credential forwarding to a changed destination', async () => {
  const home = mkdtempSync(join(tmpdir(), 'live-config-'))
  let called = false
  const server = await startBotConfigServer(home, 0, {
      onRestart: () => {
        called = true
      },
    }),
    base = `http://127.0.0.1:${server.port}`
  try {
    for (const path of [
      '/bot/settings',
      '/bot/config',
      '/bot/status',
      '/bot/restart',
      '/bot/test/llm',
      '/bot/test/voice',
      '/bot/memory/export',
      '/bot/approval',
    ]) {
      const response = await fetch(base + path, {
        method: path.includes('settings') || path.includes('status') ? 'GET' : 'POST',
      })
      expect(response.status, path).toBe(401)
      expect(await response.text()).not.toContain(server.token)
    }
    expect(called).toBe(false)
    const page = await fetch(base + '/bot/settings?token=' + server.token)
    expect(page.status).toBe(200)
    expect(page.headers.get('referrer-policy')).toBe('no-referrer')
    const headers = { 'x-dsh-bot-token': server.token, 'content-type': 'application/json' }
    expect(
      (
        await fetch(base + '/bot/config', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            llm: { provider: 'custom', baseUrl: 'https://first.example/v1', model: 'mock', apiKey: 'fake-key' },
          }),
        })
      ).status,
    ).toBe(200)
    const response = await fetch(base + '/bot/test/llm', {
      method: 'POST',
      headers,
      body: JSON.stringify({ llm: { baseUrl: 'https://second.example/v1' } }),
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('KEY_REQUIRED_FOR_NEW_DESTINATION')
  } finally {
    await server.close()
    rmSync(home, { recursive: true, force: true })
  }
})
for (const rejected of [false, true])
  it(`voice probe needs negotiated ASR and actual TTS audio: reject=${rejected}`, async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>(done => server.once('listening', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No address')
    const seen: string[] = []
    server.on('connection', (socket, req) => {
      expect(req.headers.authorization).toBe('Bearer fake-voice')
      const tts = req.url?.includes('tts')
      seen.push(tts ? 'tts' : 'asr')
      socket.send(JSON.stringify({ type: 'session.created' }))
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString())
        if (message.type === 'session.update')
          socket.send(JSON.stringify({ type: rejected ? 'error' : 'session.updated' }))
        if (message.type === 'input_text_buffer.commit')
          socket.send(JSON.stringify({ type: 'response.audio.delta', delta: Buffer.from('pcm').toString('base64') }))
      })
    })
    try {
      const result = await testVoiceProvider(
        {
          provider: 'dashscope',
          baseUrl: `ws://127.0.0.1:${address.port}/realtime`,
          apiKey: 'fake-voice',
          model: 'qwen3-asr-flash-realtime',
        },
        { timeoutMs: 2000 },
      )
      expect(result.ok).toBe(!rejected)
      expect(result.detail).not.toContain('fake-voice')
      expect(seen).toEqual(rejected ? ['asr'] : ['asr', 'tts'])
    } finally {
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>(done => server.close(() => done()))
    }
  })

it('redacts a provider error that reflects the submitted key', async () => {
  const result = await testLlmProvider(
    { provider: 'custom', baseUrl: 'https://example.test/v1', model: 'mock', apiKey: 'fake-sensitive-key' },
    { fetch: async () => new Response('invalid key: fake-sensitive-key', { status: 401 }) },
  )
  expect(JSON.stringify(result)).not.toContain('fake-sensitive-key')
  expect(result.ok).toBe(false)
})
