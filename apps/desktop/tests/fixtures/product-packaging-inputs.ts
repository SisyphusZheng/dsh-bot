/** Resource mappings for configuration tests; no runtime health is simulated. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export function productPackagingInputs(): { root: string; dispose(): void } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-product-packaging-'))
  const previous = new Map<string, string | undefined>()
  const dispose = (): void => {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
  try {
    for (const path of ['voice', 'memory/runtime/hindsight', 'memory/runtime/models', 'memory/runtime/pg0',
      'memory/scripts', 'memory/adapter/m1-c-hindsight']) mkdirSync(join(root, path), { recursive: true })
    for (const file of ['sidecar.mjs', 'VERSION.json']) writeFileSync(join(root, 'memory', file), '{}\n')
    const inputs = { NISSE_VOICE_WORKER_DIR: join(root, 'voice'), NISSE_MEMORY_DIR: join(root, 'memory') }
    for (const [key, value] of Object.entries(inputs)) {
      previous.set(key, process.env[key])
      process.env[key] = value
    }
    return { root, dispose }
  } catch (error) { dispose(); throw error }
}
