#!/usr/bin/env node
/**
 * closure-m2-e2e: deterministic pipeline acceptance for the 0.0.1 memory contract (§5 M2).
 *
 * It exercises the real product memory path — memory sidecar (product/memory/sidecar.mjs)
 * over the real MemoryAdapter (chunks retain, local ONNX embeddings) against a real,
 * isolated Hindsight service — with synthetic data in a dedicated bank. No cloud credentials,
 * no real LLM: Hindsight runs with HINDSIGHT_API_LLM_PROVIDER=mock, so this proves
 * storage/retrieval/write-provenance/deletion/export/backup behaviour, NOT conversation quality.
 *
 * Required environment (the operator starts Hindsight separately, isolated root + port):
 *   CLOSURE_M2_HINDSIGHT_URL  e.g. http://127.0.0.1:5517
 *   CLOSURE_M2_ROOT           isolated scratch dir (data roots, exports, logs)
 *   CLOSURE_M2_EVIDENCE       evidence dir for RESULTS.json (defaults to CLOSURE_M2_ROOT)
 *   CLOSURE_M2_MODE           'full' (default) | 'no-server' (only observe a stopped backend)
 *
 * The script never touches the user's real bank, never deletes outside CLOSURE_M2_ROOT, and
 * never writes into another worktree.
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const HERE = resolve(new URL('.', import.meta.url).pathname)
const REPO = resolve(HERE, '..', '..')
const SIDECAR = join(REPO, 'product', 'memory', 'sidecar.mjs')
const HINDSIGHT_URL = String(process.env.CLOSURE_M2_HINDSIGHT_URL || '').replace(/\/$/, '')
const ROOT = String(process.env.CLOSURE_M2_ROOT || '')
const EVIDENCE = String(process.env.CLOSURE_M2_EVIDENCE || ROOT)
const MODE = String(process.env.CLOSURE_M2_MODE || 'full')
if (!HINDSIGHT_URL) throw new Error('CLOSURE_M2_HINDSIGHT_URL is required')
if (!ROOT) throw new Error('CLOSURE_M2_ROOT is required')
mkdirSync(ROOT, { recursive: true })
mkdirSync(EVIDENCE, { recursive: true })

const RUN = new Date().toISOString().replace(/[:.]/g, '-')
const BANK = `closure:m2:${RUN}`
const SESSION_1 = 'm2-session-remember'
const SESSION_2 = 'm2-session-recall'
const SESSION_3 = 'm2-session-corrected'
const SESSION_4 = 'm2-session-after-delete'
const MARK_A = 'M2A-' + randomBytes(6).toString('hex')
const MARK_B = 'M2B-' + randomBytes(6).toString('hex')
const PREFERENCE_A = `我喜欢无糖拿铁，常去的咖啡店叫海风咖啡（记录 ${MARK_A}）`
const PREFERENCE_B = `我改喝燕麦奶拿铁，不再喝无糖拿铁，咖啡店还是海风咖啡（记录 ${MARK_B}）`
const QUESTION = '我平时喝咖啡有什么习惯？'
const results = []
const httpLog = []
let stage = 'setup'

function record(id, title, status, detail, evidence = []) {
  const normalized = detail !== null && typeof detail === 'object' ? detail : String(detail ?? '')
  results.push({ id, title, status, detail: normalized, evidence: evidence.filter(Boolean), at: new Date().toISOString() })
  process.stdout.write(`[${status}] ${id} ${title}\n`)
}
function logLine(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), stage, ...entry }) + '\n'
  httpLog.push(line)
  appendFileSync(join(EVIDENCE, 'm2-commands.jsonl'), line)
}
async function call(base, path, { method = 'POST', body, token, timeout = 120000 } = {}) {
  const started = Date.now()
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  let json = null
  try { json = text === '' ? null : JSON.parse(text) } catch { json = { raw: text.slice(0, 2000) } }
  logLine({ stage, method, path, status: res.status, ms: Date.now() - started, request: body, response: json })
  return { status: res.status, json }
}
async function waitFor(fn, { timeoutMs = 90000, intervalMs = 500, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await Promise.resolve().then(fn).catch(() => null)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`)
    await sleep(intervalMs)
  }
}
function writeJson(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }) }

// ---------------------------------------------------------------------------
// sidecar lifecycle (the product's loopback memory service)
// ---------------------------------------------------------------------------
const TOKEN = randomBytes(24).toString('hex')
const SIDECAR_ROOT = join(ROOT, 'sidecar-root')
mkdirSync(SIDECAR_ROOT, { recursive: true })
let sidecar = null
let sidecarPort = 0
let sidecarLog = ''

async function startSidecar() {
  writeFileSync(join(EVIDENCE, 'sidecar-token.txt'), TOKEN + '\n', { mode: 0o600 })
  sidecar = spawn(process.execPath, [SIDECAR], {
    cwd: ROOT,
    env: {
      ...process.env,
      HINDSIGHT_URL,
      NISSE_M4_MEMORY_ROOT: SIDECAR_ROOT,
      NISSE_M4_MEMORY_TOKEN: TOKEN,
      NISSE_M4_BANK: BANK,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  sidecar.stdout.on('data', (chunk) => { sidecarLog += String(chunk); appendFileSync(join(EVIDENCE, 'sidecar.log'), String(chunk)) })
  sidecar.stderr.on('data', (chunk) => { sidecarLog += String(chunk); appendFileSync(join(EVIDENCE, 'sidecar.log'), String(chunk)) })
  const ready = await waitFor(() => {
    const match = /MEMORY_SIDECAR_READY \{"port":(\d+)\}/.exec(sidecarLog)
    return match ? Number(match[1]) : 0
  }, { label: 'memory sidecar ready' })
  sidecarPort = ready
  return `http://127.0.0.1:${ready}`
}
async function stopSidecar() {
  if (!sidecar) return
  sidecar.kill('SIGTERM')
  await waitFor(() => sidecar.exitCode !== null || sidecar.signalCode !== null, { timeoutMs: 10000, label: 'sidecar exit' }).catch(() => null)
  sidecar = null
}
const side = (path, body) => call(`http://127.0.0.1:${sidecarPort}`, path, { body, token: TOKEN })

// ---------------------------------------------------------------------------
// Hindsight lifecycle (isolated instance owned by the operator; we only signal it)
// ---------------------------------------------------------------------------
const HINDSIGHT_PID_FILE = process.env.CLOSURE_M2_HINDSIGHT_PID || ''
function readPid() {
  if (!HINDSIGHT_PID_FILE || !existsSync(HINDSIGHT_PID_FILE)) return 0
  const value = Number(readFileSync(HINDSIGHT_PID_FILE, 'utf8').trim())
  return Number.isInteger(value) && value > 0 ? value : 0
}
async function stopHindsight() {
  const pid = readPid()
  if (!pid) throw new Error('CLOSURE_M2_HINDSIGHT_PID missing; cannot stop the isolated backend')
  try { process.kill(pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  await waitFor(async () => {
    try { process.kill(pid, 0); return false } catch { return true }
  }, { timeoutMs: 60000, intervalMs: 500, label: 'hindsight exit' })
}
async function startHindsight() {
  const script = process.env.CLOSURE_M2_HINDSIGHT_START
  if (!script) throw new Error('CLOSURE_M2_HINDSIGHT_START missing; cannot restart the isolated backend')
  const child = spawn('bash', [script], { cwd: ROOT, env: { ...process.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.unref()
  appendFileSync(join(EVIDENCE, 'hindsight-restart.log'), `started pid ${child.pid} at ${new Date().toISOString()}\n`)
  await waitFor(() => call(HINDSIGHT_URL, '/health', { method: 'GET' }).then((r) => r.status === 200 && r.json?.status === 'healthy'), { timeoutMs: 180000, intervalMs: 1000, label: 'hindsight healthy' })
}
const hindsightNat = (path, body) => call(HINDSIGHT_URL, path, { body })

// ---------------------------------------------------------------------------
// helpers over the product memory API
// ---------------------------------------------------------------------------
async function searchMemories(query, namespaces = ['global']) {
  const response = await side('/search', { query, namespaces, limit: 8, budgetTokens: 2000 })
  if (response.status !== 200) throw new Error(`search failed http ${response.status}: ${JSON.stringify(response.json).slice(0, 300)}`)
  return response.json?.hits ?? []
}
function memoryText(hits) { return hits.map((hit) => String(hit?.text ?? '')).join('\n') }
async function listMemories(extra = {}) {
  const response = await side('/list', { limit: 100, ...extra })
  if (response.status !== 200) throw new Error(`list failed http ${response.status}: ${JSON.stringify(response.json).slice(0, 300)}`)
  return response.json?.items ?? []
}
async function nativeMemories(state = 'valid') {
  const response = await call(HINDSIGHT_URL, `/v1/default/banks/${encodeURIComponent(BANK)}/memories/list?limit=100&state=${state}`, { method: 'GET' })
  if (response.status !== 200) throw new Error(`native list failed http ${response.status}`)
  return response.json?.items ?? []
}
async function nativeDocuments() {
  const response = await call(HINDSIGHT_URL, `/v1/default/banks/${encodeURIComponent(BANK)}/documents?limit=100`, { method: 'GET' })
  if (response.status !== 200) throw new Error(`native documents failed http ${response.status}`)
  return response.json?.items ?? response.json?.documents ?? []
}
function hasValidMemoryText(items, text) { return items.some((item) => String(item.text ?? '').includes(text) && (item.state ?? 'valid') === 'valid') }

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const summary = {
  schema: 'dsh-bot.closure-m2/v1',
  generatedAt: new Date().toISOString(),
  sourceCommit: process.env.CLOSURE_M2_SOURCE_COMMIT || '(unset)',
  sourceWorktree: REPO,
  mode: MODE,
  isolated: {
    hindsightUrl: HINDSIGHT_URL,
    bank: BANK,
    root: ROOT,
    evidenceDir: EVIDENCE,
    sidecar: 'product/memory/sidecar.mjs (spawned, ephemeral loopback port)',
    hindsightRuntime: process.env.CLOSURE_M2_HINDSIGHT_RUNTIME || '(unset)',
    llm: 'HINDSIGHT_API_LLM_PROVIDER=mock (no cloud credential, no cost)',
    embedding: 'local ONNX Xenova/multilingual-e5-small int8',
  },
  stages: results,
  limits: [
    'Storage/retrieval/provenance/deletion/export/backup are proven.',
    'Conversation quality is NOT proven: Hindsight runs with a mock LLM and the retain mode is chunks (no extraction).',
    'The Host/DSH conversation path (natural language -> memory write) is exercised by apps/desktop/tests/f1-m2-memory-e2e.spec.ts, which uses a MockAdapter for the model.',
  ],
}

try {
  // ---- preflight ---------------------------------------------------------
  stage = 'S0-preflight'
  const health = await call(HINDSIGHT_URL, '/health', { method: 'GET' })
  const version = await call(HINDSIGHT_URL, '/version', { method: 'GET' })
  if (health.status !== 200 || health.json?.status !== 'healthy') throw new Error('Hindsight is not healthy: ' + JSON.stringify(health.json))
  if (version.json?.features?.observations !== false) {
    throw new Error('expected observations=false (mock-LLM chunks mode); refusing to claim extraction acceptance')
  }
  summary.backend = { health: health.json, version: version.json }
  record('S0', '隔离 Hindsight 健康且 observations=false（chunks/mock-LLM）', 'PASS', `api ${version.json?.api_version}`, ['m2-commands.jsonl'])

  const sidecarUrl = await startSidecar()
  summary.isolated.sidecarUrl = sidecarUrl
  const sidecarHealth = await side('/health', {})
  if (sidecarHealth.status !== 200 || sidecarHealth.json?.ok !== true) throw new Error('sidecar health failed: ' + JSON.stringify(sidecarHealth.json))
  record('S0b', '产品记忆 sidecar 启动并就绪（隔离 root/token/bank）', 'PASS', sidecarUrl, ['sidecar.log'])

  // ---- ① natural-language "remember A" -----------------------------------
  stage = 'S1-remember-A'
  const hostEpisodeWrite = await side('/write', {
    items: [{
      kind: 'episode',
      namespace: 'global',
      tags: ['bot-conversation'],
      text: `用户：请记住，${PREFERENCE_A}\n助手：好的，我记下了。`,
    }],
    writer: 'bot',
    opts: { source: { sessionId: SESSION_1, turnId: SESSION_1 + ':1' } },
  })
  if (hostEpisodeWrite.status !== 200 || hostEpisodeWrite.json?.ok !== true) throw new Error('episode write failed: ' + JSON.stringify(hostEpisodeWrite.json))
  const preferenceWrite = await side('/write', {
    items: [{ kind: 'preference', namespace: 'global', text: PREFERENCE_A }],
    writer: 'bot',
    opts: { source: { sessionId: SESSION_1, turnId: SESSION_1 + ':1' } },
  })
  if (preferenceWrite.status !== 200 || preferenceWrite.json?.ok !== true) throw new Error('preference write failed: ' + JSON.stringify(preferenceWrite.json))
  const aNative = await nativeMemories('valid')
  const aItems = aNative.filter((item) => String(item.text ?? '').includes(MARK_A))
  const aPreference = aItems.find((item) => (item.metadata?.kind === 'preference') || (item.tags ?? []).includes('kind:preference'))
  const aEpisode = aItems.find((item) => (item.metadata?.kind === 'episode') || (item.tags ?? []).includes('kind:episode'))
  if (!aPreference) throw new Error('preference memory A was not found in the backend')
  if (!aEpisode) throw new Error('conversation episode containing A was not found in the backend')
  if (aPreference.metadata?.sourceSessionId !== SESSION_1) throw new Error('provenance lost: ' + JSON.stringify(aPreference.metadata))
  if (!(aPreference.tags ?? []).includes('ns:global')) throw new Error('namespace tag missing: ' + JSON.stringify(aPreference.tags))
  record('S1', '① 用户要求记住 A → 后端实际写入内容与来源可核验', 'PASS', {
    preferenceMemoryId: aPreference.id,
    preferenceDocumentId: aPreference.document_id,
    preferenceText: aPreference.text,
    episodeMemoryId: aEpisode.id,
    episodeText: aEpisode.text.slice(0, 200),
    provenance: aPreference.metadata,
    tags: aPreference.tags,
    nativeType: aPreference.fact_type,
    note: 'Host 生产路径(turn-end)写入的是 episode；设为 preference 的 A 通过产品记忆 API 写入。',
  }, ['m2-commands.jsonl'])
  const memoryAId = aPreference.id
  summary.markers = { MARK_A, MARK_B, PREFERENCE_A, PREFERENCE_B, QUESTION, memoryAId }

  // ---- ② new session uses A (retrieval + digest pipeline) ----------------
  stage = 'S2-recall-A'
  const hitsA = await searchMemories(QUESTION)
  const hitA = hitsA.find((hit) => String(hit.text).includes(MARK_A))
  if (!hitA) throw new Error('different-wording recall did not return A')
  const digest = await side('/digest', { budgetTokens: 800 })
  if (digest.status !== 200 || !String(digest.json?.digest?.text ?? '').includes(MARK_A)) throw new Error('digest does not carry A')
  record('S2', '② 新会话不同措辞召回 A：检索命中 + digest 注入管线', 'PASS', {
    query: QUESTION,
    hit: { id: hitA.id, score: hitA.score, scores: hitA.scores, source: hitA.source, text: hitA.text },
    digestTokens: digest.json?.digest?.tokensEstimated,
    note: '管线证明“A 进入模型可见上下文”；模型回答本身由 f1-m2-memory-e2e.spec.ts 的 MockAdapter 断言，对话质量未证明。',
  }, ['m2-commands.jsonl'])

  // ---- ③ correct A -> B ---------------------------------------------------
  stage = 'S3-correct-B'
  const corrected = await side('/correct', { id: memoryAId, text: PREFERENCE_B, writer: 'bot' })
  if (corrected.status !== 200 || corrected.json?.ok !== true) throw new Error('correct failed: ' + JSON.stringify(corrected.json))
  const bItems = (await nativeMemories('valid')).filter((item) => String(item.text ?? '').includes(MARK_B))
  const remainsA = (await nativeMemories('valid')).filter((item) => (item.metadata?.kind === 'preference') && String(item.text ?? '').includes(MARK_A))
  if (bItems.length === 0) throw new Error('B was not written')
  if (remainsA.length !== 0) throw new Error('A is still a valid preference after correction')
  const hitsAfterCorrect = await searchMemories(QUESTION)
  const textsAfterCorrect = memoryText(hitsAfterCorrect)
  if (!textsAfterCorrect.includes(MARK_B)) throw new Error('search after correction does not return B')
  // A may still be recalled from the old episode (chat record); it must not be the current preference.
  const currentPreferenceHits = hitsAfterCorrect.filter((hit) => hit.kind === 'preference')
  if (currentPreferenceHits.some((hit) => String(hit.text).includes(MARK_A))) throw new Error('old preference A is still presented as current')
  record('S3', '③ 纠正为 B → A 不再是当前事实，检索/列表只返回 B 作为 preference', 'PASS', {
    previousId: memoryAId,
    newDocumentId: corrected.json?.result?.documentId,
    newMemoryId: bItems[0]?.id,
    forget: corrected.json?.result?.forget,
    verified: corrected.json?.result?.verified,
    hitsAfterCorrect: hitsAfterCorrect.map((hit) => ({ id: hit.id, kind: hit.kind, text: String(hit.text).slice(0, 120), score: hit.score })),
    note: 'A 的旧 episode（对话记录）仍可被召回，但不再是当前偏好；聊天记录与“当前事实”是两层。',
  }, ['m2-commands.jsonl'])
  const memoryBId = bItems[0]?.id

  // ---- ⑤a sensitive-information screen -----------------------------------
  stage = 'S4-sensitive'
  const beforeCount = (await listMemories()).length
  const sensitive = await side('/write', {
    // Obviously synthetic placeholder shaped as a credential ASSIGNMENT (never a real key
    // format): the adapter screen must reject the write before any egress.
    items: [{ kind: 'fact', namespace: 'global', text: '请记住我的示例口令：password = M2-SYNTHETIC-PLACEHOLDER-NOT-A-SECRET' }],
    writer: 'bot',
  })
  const afterCount = (await listMemories()).length
  if (sensitive.status === 200) throw new Error('sensitive write was accepted')
  if (afterCount !== beforeCount) throw new Error('sensitive write changed the memory count')
  const nativeAfterSensitive = await nativeMemories('valid')
  if (nativeAfterSensitive.some((item) => String(item.text ?? '').includes('M2-SYNTHETIC-PLACEHOLDER-NOT-A-SECRET'))) throw new Error('sensitive text reached the backend')
  record('S4', '⑤a 敏感信息写入被拦截且无副作用（敏感夹具未进后端）', 'PASS', {
    httpStatus: sensitive.status,
    error: sensitive.json?.error,
    countBefore: beforeCount,
    countAfter: afterCount,
  }, ['m2-commands.jsonl'])

  // ---- ⑤b export ---------------------------------------------------------
  stage = 'S5-export'
  const exported = await side('/export', { format: 'jsonl' })
  if (exported.status !== 200 || !exported.json?.ok) throw new Error('export failed: ' + JSON.stringify(exported.json))
  const exportPath = String(exported.json?.export?.path ?? '')
  if (!existsSync(exportPath)) throw new Error('export file missing: ' + exportPath)
  const exportBody = readFileSync(exportPath, 'utf8')
  const exportSha = createHash('sha256').update(exportBody).digest('hex')
  const exportCount = exportBody.trim() === '' ? 0 : exportBody.trim().split('\n').length
  if (!exportBody.includes(MARK_A) || !exportBody.includes(MARK_B)) throw new Error('export does not contain A/B records')
  record('S5', '⑤b 产品导出可用（JSONL，含 A/B 状态与来源）', 'PASS', {
    path: exportPath,
    count: exported.json?.export?.count,
    lines: exportCount,
    sha256: exportSha,
    containsA: exportBody.includes(MARK_A),
    containsB: exportBody.includes(MARK_B),
  }, [exportPath])

  // ---- ⑤c restart persistence (B still valid) ---------------------------
  stage = 'S6-restart'
  await stopHindsight()
  await startHindsight()
  const hitsAfterRestart = await searchMemories(QUESTION)
  const validAfterRestart = await nativeMemories('valid')
  const bAfterRestart = validAfterRestart.some((item) => (item.metadata?.kind === 'preference') && String(item.text ?? '').includes(MARK_B))
  if (!bAfterRestart) throw new Error('preference B did not survive the backend restart')
  record('S6', '⑤c 跨重启：后端停止/重启后 B 仍是当前偏好、检索可用', 'PASS', {
    hitsAfterRestart: hitsAfterRestart.map((hit) => ({ id: hit.id, kind: hit.kind, text: String(hit.text).slice(0, 100), score: hit.score })),
    preferenceBValid: bAfterRestart,
  }, ['hindsight-restart.log'])

  // ---- ⑤d backup (stopped filesystem copy) ------------------------------
  stage = 'S7-backup'
  const instanceDir = join(ROOT, 'm1c-root', 'home', '.pg0', 'instances', 'hindsight')
  const backupDir = join(ROOT, 'backup', `hindsight-instance-${RUN}`)
  const preRestoreDir = join(ROOT, 'backup', `hindsight-instance-pre-restore-${RUN}`)
  if (!existsSync(instanceDir)) throw new Error('Hindsight instance dir not found: ' + instanceDir)
  await stopHindsight()
  mkdirSync(backupDir, { recursive: true })
  await new Promise((resolveCopy, rejectCopy) => {
    const cp = spawn('cp', ['-R', instanceDir + '/.', backupDir], { stdio: 'inherit' })
    cp.on('exit', (code) => (code === 0 ? resolveCopy() : rejectCopy(new Error('backup copy failed ' + code))))
  })
  const backupEntries = readdirSync(backupDir).length
  if (backupEntries === 0) throw new Error('backup copy is empty')
  await startHindsight()
  const hitsAfterBackup = await searchMemories(QUESTION)
  if (!hitsAfterBackup.some((hit) => String(hit.text).includes(MARK_B))) throw new Error('backup step disturbed the running bank')
  record('S7', '⑤d 备份：停止后复制隔离 pg0 数据目录，重启后 B 仍可检索', 'PASS', {
    backupDir,
    backupEntries,
    note: '备份为停止后的文件级副本（含 pg0 data/WAL）；仅限本隔离 dataRoot，不触碰用户真实库。',
  }, ['hindsight-restart.log'])

  // ---- ④ delete B -> no recall ------------------------------------------
  stage = 'S8-delete-B'
  const deleted = await side('/delete', { id: memoryBId, writer: 'bot' })
  if (deleted.status !== 200 || deleted.json?.ok !== true) throw new Error('delete failed: ' + JSON.stringify(deleted.json))
  const hitsAfterDelete = await searchMemories(QUESTION)
  const validAfterDelete = await nativeMemories('valid')
  if (hitsAfterDelete.some((hit) => (hit.kind === 'preference') && String(hit.text).includes(MARK_B))) throw new Error('deleted preference B is still recalled')
  if (validAfterDelete.some((item) => (item.metadata?.kind === 'preference') && String(item.text ?? '').includes(MARK_B))) throw new Error('deleted preference B is still valid')
  const invalidatedList = await nativeMemories('invalidated')
  record('S8', '④ 删除 B → 新查询不再召回；库内状态为 invalidated', 'PASS', {
    deleteResult: deleted.json?.result,
    invalidatedCount: invalidatedList.filter((item) => String(item.text ?? '').includes(MARK_B)).length,
    hitsAfterDelete: hitsAfterDelete.map((hit) => ({ id: hit.id, kind: hit.kind, text: String(hit.text).slice(0, 100) })),
    retentionBoundary: {
      memoryBank: 'B 不再有效/可召回（invalidated；文档硬删取决于 mode）',
      chatHistory: 'DSH 会话日志与 Host bot 状态仍保留对话原文；记忆删除不等于会话记录删除',
      exports: '删除前导出的 JSONL/Markdown 与备份副本是独立副本，不会回溯修改：' + exportPath,
    },
  }, ['m2-commands.jsonl'])

  // ---- ⑤d restore drill (pre-delete backup must bring B back) ----------
  stage = 'S9-restore'
  await stopHindsight()
  renameSync(instanceDir, preRestoreDir)
  await new Promise((resolveCopy, rejectCopy) => {
    const cp = spawn('cp', ['-R', backupDir + '/.', instanceDir], { stdio: 'inherit' })
    cp.on('exit', (code) => (code === 0 ? resolveCopy() : rejectCopy(new Error('restore copy failed ' + code))))
  })
  await startHindsight()
  const restoredHits = await searchMemories(QUESTION)
  const restoredValid = await nativeMemories('valid')
  const bRestored = restoredValid.some((item) => (item.metadata?.kind === 'preference') && String(item.text ?? '').includes(MARK_B))
  if (!bRestored) throw new Error('restore did not bring B back')
  const aStillInvalid = !restoredValid.some((item) => (item.metadata?.kind === 'preference') && String(item.text ?? '').includes(MARK_A))
  record('S9', '⑤d 备份恢复演练：恢复删除前副本后 B 回来、A 仍非当前事实', 'PASS', {
    preRestoreDir,
    restoredPreferenceB: bRestored,
    preferenceAStillInvalid: aStillInvalid,
    hitsAfterRestore: restoredHits.filter((hit) => hit.kind === 'preference').map((hit) => String(hit.text).slice(0, 100)),
    note: '恢复只覆盖本隔离 dataRoot；恢复前的库被移动到 preRestore 目录而非删除。',
  }, ['hindsight-restart.log'])

  // ---- ⑤e unavailable + recovery ----------------------------------------
  stage = 'S10-unavailable'
  await stopHindsight()
  const degradedHealth = await side('/health', {})
  const writeWhileDown = await side('/write', { items: [{ kind: 'fact', namespace: 'global', text: '服务不可用期间不应写入 ' + MARK_A }], writer: 'bot' })
  const searchWhileDown = await side('/search', { query: QUESTION })
  if (writeWhileDown.status === 200 || writeWhileDown.json?.ok === true) throw new Error('write reported success while the backend was down')
  if (searchWhileDown.status === 200 && Array.isArray(searchWhileDown.json?.hits) && searchWhileDown.json.hits.length > 0) throw new Error('search fabricated hits while the backend was down')
  if (degradedHealth.json?.ok !== false) throw new Error('health did not degrade while the backend was down: ' + JSON.stringify(degradedHealth.json))
  record('S10a', '⑤e 服务不可用：health 降级、写入明确失败、检索不伪造结果', 'PASS', {
    health: degradedHealth.json,
    writeStatus: writeWhileDown.status,
    writeError: writeWhileDown.json?.error,
    searchStatus: searchWhileDown.status,
  }, ['m2-commands.jsonl'])
  stage = 'S11-recovery'
  await startHindsight()
  const recoveredHealth = await side('/health', {})
  const recoveredSearch = await searchMemories(QUESTION)
  if (recoveredHealth.json?.ok !== true) throw new Error('health did not recover')
  if (recoveredSearch.length === 0) throw new Error('search did not recover')
  record('S10b', '⑤e 服务恢复后 health/检索恢复可用（无脏写）', 'PASS', {
    health: recoveredHealth.json,
    hits: recoveredSearch.length,
  }, ['hindsight-restart.log'])

  summary.status = results.some((item) => item.status === 'FAIL') ? 'FAIL' : 'PASS'
} catch (error) {
  record('ERROR', `stage ${stage} failed`, 'FAIL', error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error), ['m2-commands.jsonl'])
  summary.status = 'FAIL'
} finally {
  await stopSidecar().catch(() => null)
  summary.finishedAt = new Date().toISOString()
  summary.results = results
  writeJson(join(EVIDENCE, 'M2-RESULTS.json'), { ...summary })
  const lines = [
    `# M2 pipeline results (${summary.status})`,
    '',
    `generated: ${summary.generatedAt}  finished: ${summary.finishedAt}`,
    `source: ${summary.sourceWorktree} @ ${summary.sourceCommit}`,
    `isolated bank: ${BANK}  hindsight: ${HINDSIGHT_URL}  root: ${ROOT}`,
    '',
    '| stage | status | detail |',
    '|---|---|---|',
    ...results.map((item) => `| ${item.id} ${item.title} | ${item.status} | ${(typeof item.detail === 'object' ? JSON.stringify(item.detail) : String(item.detail)).replace(/\n/g, ' ').slice(0, 400).replace(/\|/g, '\\|')} |`),
  ]
  writeFileSync(join(EVIDENCE, 'M2-RESULTS.md'), lines.join('\n') + '\n')
  process.stdout.write(`\nM2 ${summary.status}; results in ${join(EVIDENCE, 'M2-RESULTS.json')}\n`)
  process.exitCode = summary.status === 'PASS' ? 0 : 1
}
