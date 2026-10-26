/** Verify the bytes exposed by a Host package's ./client export as a classic script. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Script } from 'node:vm'
export function verifyHostClient(packageDir) {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const path = join(packageDir, manifest.exports['./client'])
  let registration
  new Script(readFileSync(path, 'utf8'), { filename: path }).runInNewContext({ window: { __ModuleLoader__: { load(value) {
    if (registration) throw new Error('Duplicate Client registration')
    registration = value
  } } } })
  if (registration?.id !== manifest.name || typeof registration.factory !== 'function') throw new Error('Missing or mismatched Client registration')
  const plugin = registration.factory(() => { throw new Error('Unexpected Client dependency') })
  if (typeof plugin.apply !== 'function' || !plugin.inject?.includes('uiWorkspace')) throw new Error('Client navigation plugin is missing')
  return { id: manifest.name, path }
}
