import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { DshCredentialStore } from '../src/secret-store.ts'
import { startBotConfigServer as createBotConfigServer } from '../src/bot-config-server.ts'
import type { BotConfig } from '../src/bot-settings-model.ts'

const authTokens=new Map<number,string>()
async function startBotConfigServer(...args:Parameters<typeof createBotConfigServer>){
  const server=await createBotConfigServer(...args)
  authTokens.set(server.port,server.token)
  return server
}
const folders: string[] = []
const servers: Array<() => Promise<void>> = []
function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-bot-regressions-'))
  folders.push(directory)
  return directory
}
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.()
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function http(port: number, path: string, method = 'GET', body: object | null = null, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
    const json = body === null ? '' : JSON.stringify(body)
    const req = request({
      host: '127.0.0.1', port, path, method,
      headers: { 'x-dsh-bot-token':authTokens.get(port)||'', ...(json ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) } : {}), ...headers },
    }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += String(chunk) })
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, data: JSON.parse(text) as Record<string, unknown> }) }
        catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.end(json)
  })
}

describe('dsh-bot security and config regressions', () => {
  it('rejects cross-origin browser mutations and DNS rebinding Host names', async () => {
    const dir = folder()
    const server = await startBotConfigServer(dir, 0)
    servers.push(server.close)
    const foreignOrigin = await http(server.port, '/bot/memory/forget', 'POST', {}, {
      origin: 'https://untrusted.example',
    })
    expect(foreignOrigin.status).toBe(403)
    const foreignHost = await http(server.port, '/bot/config', 'GET', null, {
      host: 'untrusted.example',
    })
    expect(foreignHost.status).toBe(403)
    const crossSite = await http(server.port, '/bot/memory/delete', 'POST', { id: 'x' }, {
      'sec-fetch-site': 'cross-site',
    })
    expect(crossSite.status).toBe(403)
    const sameOrigin = await http(server.port, '/bot/config', 'GET', null, {
      origin: `http://127.0.0.1:${server.port}`,
    })
    expect(sameOrigin.status).toBe(200)
  })

  it('passes the actual pre-save snapshot to runtime configuration hooks', async () => {
    const dir = folder()
    let before: BotConfig | undefined
    let after: BotConfig | undefined
    const server = await startBotConfigServer(dir, 0, {
      onConfigSaved: (next, previous) => { before = previous; after = next },
    })
    servers.push(server.close)
    const result = await http(server.port, '/bot/config', 'PUT', { llm: { model: 'regression-model' } })
    expect(result.status).toBe(200)
    expect(before?.llm.model).not.toBe('regression-model')
    expect(after?.llm.model).toBe('regression-model')
  })

  // Mutations are asynchronous: they take the cross-process writer lock the
  // running DSH runtime also uses, so a refusal surfaces as a rejected promise.
  it('preserves malformed DSH credential files instead of replacing them', async () => {
    const dir = folder()
    const file = join(dir, '.credentials.yaml')
    const malformed = 'version: 1\nrefs: [not closed\n'
    writeFileSync(file, malformed, { mode: 0o600 })
    const store = new DshCredentialStore(dir)
    await expect(store.set('new', 'secret')).rejects.toThrow(/not valid YAML/)
    expect(readFileSync(file, 'utf8')).toBe(malformed)
  })

  it('creates a fresh credential document with restrictive permissions', async () => {
    const dir = folder()
    const store = new DshCredentialStore(dir)
    await store.set('probe', 'ok')
    expect(store.get('probe')).toBe('ok')
    expect(statSync(join(dir, '.credentials.yaml')).mode & 0o077).toBe(0)
  })
})
