/** Exact, revocable product grants. Official DSH still evaluates all tool guards. */
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  throw new Error('Unsupported operation parameters')
}
export function operationKey(operation) {
  if (!operation || typeof operation.toolName !== 'string' || !operation.toolName || typeof operation.cwd !== 'string' || !operation.cwd || !Object.hasOwn(operation, 'arguments')) throw new Error('Exact operation unavailable')
  return createHash('sha256').update(canonical({ toolName: operation.toolName, cwd: operation.cwd, arguments: operation.arguments })).digest('hex')
}
export function createApprovalPolicies(file) {
  let rules = [], error = ''
  try {
    if (!lstatSync(file).isFile()) throw new Error('Grant file is not a regular file')
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (data.version !== 1 || !Array.isArray(data.rules) || data.rules.length > 1000) throw new Error('Invalid grant store')
    const ids = new Set()
    rules = data.rules.map(rule => {
      if (!rule || typeof rule.id !== 'string' || ids.has(rule.id) || !/^[a-f0-9]{64}$/.test(rule.key) || typeof rule.toolName !== 'string' || typeof rule.createdAt !== 'string') throw new Error('Invalid grant')
      ids.add(rule.id)
      return { id: rule.id, key: rule.key, toolName: rule.toolName, createdAt: rule.createdAt }
    })
  } catch (cause) { if (cause.code !== 'ENOENT') { error = '持续授权文件不可读或损坏；已停用，原文件未覆盖。'; rules = [] } }
  function save(next) {
    if (error) throw new Error(error)
    const temporary = file + '.' + randomUUID() + '.tmp'
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, rules: next }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      renameSync(temporary, file)
      rules = next
    } finally { try { unlinkSync(temporary) } catch (cause) { if (cause.code !== 'ENOENT') throw cause } }
  }
  return {
    snapshot: () => ({ rules: rules.map(rule => ({ ...rule })), ...(error ? { error } : {}) }),
    match(operation) { if (error) return null; try { const key = operationKey(operation); return rules.find(rule => rule.key === key) || null } catch { return null } },
    grant(operation) {
      const key = operationKey(operation), existing = rules.find(rule => rule.key === key)
      if (existing) return existing
      if (rules.length >= 1000) throw new Error('Too many grants; revoke unused grants first')
      const rule = { id: randomUUID(), key, toolName: operation.toolName, createdAt: new Date().toISOString() }
      save([...rules, rule]); return rule
    },
    revoke(id) { const next = rules.filter(rule => rule.id !== id), removed = rules.length - next.length; save(next); return removed },
  }
}
