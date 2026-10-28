import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const fixture = vi.hoisted(() => ({ verify: vi.fn(), sign: vi.fn(), order: [] as string[] }))
vi.mock('/apps/desktop/lib/types/runtime-tree.js', () => ({ verifyDesktopRuntime: fixture.verify }))
vi.mock('../../../product/tools/verify-macos-app.mjs', () => ({ signAdHocResources: fixture.sign }))
vi.mock('../scripts/windows-asar-unpack.mjs', () => ({ prepareWindowsAsarUnpack: vi.fn(), verifyWindowsAsarUnpack: vi.fn() }))
let home: string
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'product-signing-'))
  for (const path of ['voice', 'memory/runtime/hindsight', 'memory/runtime/models', 'memory/runtime/pg0', 'memory/scripts', 'memory/adapter/m1-c-hindsight']) mkdirSync(join(home, path), { recursive: true })
  for (const name of ['sidecar.mjs', 'VERSION.json']) writeFileSync(join(home, 'memory', name), '{}')
  vi.stubEnv('NISSE_VOICE_WORKER_DIR', join(home, 'voice'))
  vi.stubEnv('NISSE_MEMORY_DIR', join(home, 'memory'))
})
afterAll(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })
beforeEach(() => {
  fixture.order.length = 0; fixture.verify.mockReset(); fixture.sign.mockReset()
  fixture.verify.mockImplementation(async () => { fixture.order.push('runtime') })
  fixture.sign.mockImplementation(() => { fixture.order.push('resources') })
})
async function config(platform: 'darwin' | 'win32' = 'darwin') {
  const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
  return createElectronBuilderConfig({ DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_TARGET_PLATFORM: platform, DSH_DESKTOP_TARGET_ARCH: platform === 'darwin' ? 'arm64' : 'x64', DSH_DESKTOP_APP_ID: 'com.example.product', DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com', DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }), DOWNLOAD_TEST_ORIGIN: 'https://updates.example.com', DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef' }, platform, platform === 'darwin' ? 'arm64' : 'x64')
}
const context = () => ({ appOutDir: join(home, 'out'), packager: { getResourcesDir: () => join(home, 'out/Resources') } })
it('repairs native resources after runtime verification and before the outer signing stage', async () => {
  await (await config()).afterPack(context() as never)
  expect(fixture.order).toEqual(['runtime', 'resources'])
  expect(fixture.sign).toHaveBeenCalledWith(join(home, 'out/Resources'))
})
it('does not sign a package whose runtime verification failed', async () => {
  fixture.verify.mockRejectedValue(new Error('wrong runtime'))
  await expect((await config()).afterPack(context() as never)).rejects.toThrow('wrong runtime')
  expect(fixture.sign).not.toHaveBeenCalled()
})
it('does not apply macOS ad-hoc signing to Windows packages', async () => {
  await (await config('win32')).afterPack(context() as never)
  expect(fixture.verify).toHaveBeenCalledOnce(); expect(fixture.sign).not.toHaveBeenCalled()
})
