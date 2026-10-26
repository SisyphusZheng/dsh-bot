/** A descriptor discovers an endpoint; health establishes Agent readiness. */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export async function waitAgentReady(descriptorPath, { timeoutMs = 60000, intervalMs = 100, signal } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'descriptor not available'
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    try {
      const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'))
      const response = await fetch(`http://127.0.0.1:${descriptor.port}/health`, { signal: AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - Date.now()))) })
      const health = await response.json()
      if (health.agent?.lastStartupError) throw Object.assign(new Error(health.agent.lastStartupError), { fatal: true })
      if (response.ok && health.pid === descriptor.pid && health.agent?.ready === true && health.agent.sessionId) return { descriptor, health }
      lastError = 'Agent is still starting'
    } catch (error) {
      if (error.fatal) throw error
      lastError = error.message
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Agent readiness deadline: ${lastError}`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await waitAgentReady(process.argv[2])
  console.log(JSON.stringify({ pid: result.health.pid, sessionId: result.health.agent.sessionId, ready: true }))
}
