// @vitest-environment jsdom
/** Artifact test: build the product Client before running this file. */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { createClientModuleSystem, type ClientModuleLoaderTarget } from '@deepseek-ai/dsh-client-modules/client'
import { bootClient } from '../../../packages/client/web/src/boot-client.ts'
import { expect, it, onTestFinished, vi } from 'vitest'

it('loads the shipped classic script through the official module system and disposes navigation', async () => {
  let listener: ((id: string) => void) | undefined
  const opened: string[] = []
  vi.stubGlobal('dshDesktop', { onPetSession(fn: (id: string) => void) { listener = fn; return () => { listener = undefined } } })
  onTestFinished(() => { vi.unstubAllGlobals() })
  const target: ClientModuleLoaderTarget = {
    mode: 'queue', pendingQueue: [],
    load(registration) { this.pendingQueue.push(registration) },
    create(options) { return createClientModuleSystem(target, { id: '@deepseek-ai/dsh-client-modules', exports: {} }, options) },
  }
  Object.defineProperty(window, '__ModuleLoader__', { configurable: true, value: target })
  onTestFinished(() => { Reflect.deleteProperty(window, '__ModuleLoader__') })
  const id = 'nisse-host-integration'
  const boot = { rev: 'fixture', entries: [{ id, url: '/client.js', rev: '1' }, { id: 'workspace-provider', url: '/provider.js', rev: '1' }], batches: [{ phase: 'application', url: '/batch.js', rev: '1', entries: ['workspace-provider', id] }] }
  const modules = target.create({ boot, staticModules: {
    'workspace-provider': { apply(ctx: Context) {
      ctx.reflect.provide('uiWorkspace', { openSession: (sessionId: string) => opened.push(sessionId) })
      ctx.reflect.provide('sessions', { list: { getSnapshot: () => ({ phase: 'ready', byId: { 'actual-bot-session': {} } }), subscribe: () => () => {} } })
    } },
  }, loadBundle: async () => {
    const bytes = readFileSync('nisse/packages/host-integration/lib/client.js', 'utf8')
    // Same classic-script grammar as the actual <script> transport; ESM is a syntax error.
    new Function('window', bytes)(window)
  } })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await bootClient({ ctx, modules, manifest: modules.manifest })
  expect(listener).toBeTypeOf('function')
  listener?.('actual-bot-session')
  expect(opened).toEqual(['actual-bot-session'])
  await ctx.fiber.dispose()
  expect(listener).toBeUndefined()
})

it('rejects the previous raw ESM at the classic-script parser', () => {
  const previous = readFileSync('nisse/packages/host-integration/src/client/index.js', 'utf8')
  expect(() => new Function(previous)).toThrow(SyntaxError)
})
