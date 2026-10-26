/** Require the authenticated Memory adapter to answer; a descriptor alone is insufficient. */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { until } from './desktop-web-acceptance.mjs'

export async function waitMemoryReady(path, options = {}) {
  return until(async () => {
    const descriptor = JSON.parse(readFileSync(path, 'utf8'))
    const response = await fetch(descriptor.url + '/health', { headers: { authorization: `Bearer ${descriptor.token}` }, signal: AbortSignal.timeout(2000) })
    const health = await response.json()
    return response.ok && health.ok === true ? descriptor : null
  }, { timeoutMs: 300000, label: 'memory authenticated health', ...options })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await waitMemoryReady(process.argv[2])
  console.log('PASS memory authenticated health')
}
