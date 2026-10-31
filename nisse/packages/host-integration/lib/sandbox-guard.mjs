/**
 * Product-side pre-execution heuristics for the Bot bridge.
 *
 * These functions NEVER authorize an operation. They classify tool calls only
 * to (a) enforce the product's best-effort screen-view switch and (b) record
 * audit hints the pet UI can explain. File-effect safety belongs to DSH:
 * under `workspace-write` the bash executor confines the whole process family
 * with the kernel sandbox, the filesystem provider fences tool-seam mutations,
 * and out-of-workspace retries are mediated by the upstream one-shot
 * escalation + approval request. A heuristic miss here therefore cannot grant
 * a file effect, and a heuristic hit cannot widen one.
 *
 * Any classifier may throw on malformed input; the caller must fail the
 * current tool call closed (deny) and report a recoverable diagnostic instead
 * of continuing to execution.
 *
 * @module nisse-host-integration/sandbox-guard
 */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Tools whose own contract is a file-system mutation (the fs tool family). */
export const FILE_WRITE_TOOL_NAMES = Object.freeze(['write', 'edit', 'apply_patch', 'multi_edit', 'write_file'])
const FILE_WRITE_TOOLS = new Set(FILE_WRITE_TOOL_NAMES)

/** Tool-name families that run a caller-composed command line. */
const SHELL_TOOL_NAME = /terminal|bash|shell|exec/i

/**
 * Tool names a packaged screen/desktop capability uses. `cua_driver_native__*`
 * and `mcp__cua-driver-mcp__*` are the official CUA entry points; the generic
 * words cover other MCP servers that expose screen capture under their own
 * names. Name matching is best effort, not a capability boundary.
 */
const SCREEN_TOOL_NAME = /screen|screenshot|screen-?capture|computer-?use|computer_use|cua|desktop[-_ ]?control|desktop[-_ ]?automation|visual/i

/** Strong description markers for a screen-reading tool (avoids matching ordinary prose). */
const SCREEN_DESCRIPTION = /screenshot|screen ?capture|capture (?:the )?screen|screen recording|desktop automation|computer use|截屏|截图|屏幕(?:录制|捕获|读取|查看)/i

/** Shell syntax that can mutate the file system (audit hint only; deliberately broad). */
const SHELL_MUTATION = /(?:^|[\s;&|()\n])(?:touch|mkdir|rmdir|rm|cp|mv|tee|dd|truncate|ln|chmod|chown|chgrp|install|mkfifo|patch|rsync|scp|tar|unzip|sed|perl|python[0-9.]*|node|ruby|php|sh|bash|zsh|os\.system)\b|>>?|<<|--in-place|\s-i(?:\s|$)/i

/** Absolute / home-relative path spellings a shell command may name. */
const SHELL_ABSOLUTE_PATH = /(?:^|[\s='"`(:])((?:\/|~\/|\$HOME\/|\$\{HOME\}\/)[^\s'"`;|&)]*)/g
/** `..`-relative spellings. */
const SHELL_RELATIVE_PATH = /(?:^|[\s='"`(:])((?:\.\.\/)[^\s'"`;|&)]*)/g
/** A path built from a variable the classifier cannot resolve. */
const SHELL_VARIABLE_PATH = /(?:^|[\s='"`(:])((?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/)[^\s'"`;|&)]*)/

/**
 * Resolve one path the way the enforcement layers compare it: canonical when it
 * exists, otherwise canonicalize the deepest existing ancestor and keep the
 * missing suffix. Cheap enough for a per-call audit hook.
 * @param {string} path - path to canonicalize; relative paths resolve against the process cwd.
 * @returns {string} the canonical path, or the resolved spelling when nothing exists.
 */
export function canonicalPath(path) {
  const absolute = resolve(path)
  let current = absolute
  let suffix = ''
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return suffix === '' ? real : join(real, suffix)
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      suffix = suffix === '' ? basename(current) : join(basename(current), suffix)
      current = parent
    }
  }
}

/**
 * Whether a canonical target lies outside the canonical workspace root.
 * @param {string} target - canonical target path.
 * @param {string} workspace - canonical workspace root.
 * @returns {boolean} true when the target is not under the workspace.
 */
export function isOutsideWorkspace(target, workspace) {
  const rel = relative(workspace, target)
  return rel === '..' || rel.startsWith('..' + sep) || rel.includes(sep + '..' + sep) || isAbsolute(rel)
}

/**
 * Classify one tool by its name and description for the product screen switch.
 * This is a best-effort product signal: the Bot profile does not mount any
 * computer-use/screenshot capability by default, and third-party tools can
 * name themselves anything.
 * @param {string} name - tool name.
 * @param {string} description - tool description, if the registry exposes one.
 * @returns {boolean} true when the call looks like it can observe the screen.
 */
export function isScreenCapableTool(name, description = '') {
  const toolName = String(name || '')
  const text = String(description || '')
  return SCREEN_TOOL_NAME.test(toolName) || SCREEN_DESCRIPTION.test(text)
}

/**
 * Classify one tool call for the audit hook.
 * @param {string} name - tool name.
 * @returns {'file-write'|'shell'|'other'} the heuristic family.
 */
export function toolFamily(name) {
  const toolName = String(name || '')
  if (FILE_WRITE_TOOLS.has(toolName)) return 'file-write'
  if (SHELL_TOOL_NAME.test(toolName)) return 'shell'
  return 'other'
}

/**
 * Extract the file target a file-writing tool names, if any.
 * @param {Record<string, unknown>} args - tool arguments.
 * @returns {string} the raw target spelling, or ''.
 */
function fileWriteTarget(args) {
  const raw = args?.path ?? args?.file_path ?? args?.filePath ?? args?.target ?? ''
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * Heuristically find paths a shell command may write. Only used for audit
 * hints; the kernel sandbox decides the effect.
 * @param {string} command - the caller-composed command line.
 * @returns {{ mutation: boolean, unknownTarget: boolean, targets: string[] }} the hint facts.
 */
export function shellWriteHints(command) {
  const text = String(command || '')
  const targets = []
  for (const pattern of [SHELL_ABSOLUTE_PATH, SHELL_RELATIVE_PATH]) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) if (match[1]) targets.push(match[1])
  }
  return { mutation: SHELL_MUTATION.test(text), unknownTarget: SHELL_VARIABLE_PATH.test(text), targets }
}

/**
 * Project one pre-execute call onto the audit facts the product hook records.
 * `outside` is `true` only when a resolvable candidate canonicalizes outside
 * the workspace; `unknown` records a path the heuristic cannot resolve (audit
 * only — the sandbox still decides).
 * @param {object} call - the call to classify.
 * @param {string} call.toolName - tool name.
 * @param {unknown} call.arguments - model-supplied arguments.
 * @param {string} call.workspace - canonical workspace root.
 * @param {string} call.cwd - working directory used to resolve relative spellings.
 * @param {string} [call.home] - home directory used to expand `~/`.
 * @returns {{ family: string, outside: boolean, unknown: boolean, targets: string[] }} audit facts.
 */
export function classifyWriteIntent({ toolName, arguments: args, workspace, cwd, home = homedir() }) {
  const family = toolFamily(toolName)
  const facts = { family, outside: false, unknown: false, targets: [] }
  const canonicalWorkspace = canonicalPath(workspace)
  const canonicalCwd = canonicalPath(cwd || workspace)
  const toCanonical = (spelling) => {
    if (spelling.startsWith('~/')) return canonicalPath(join(home, spelling.slice(2)))
    if (spelling === '~') return canonicalPath(home)
    if (isAbsolute(spelling)) return canonicalPath(spelling)
    return canonicalPath(join(canonicalCwd, spelling))
  }
  if (family === 'file-write') {
    const target = fileWriteTarget(args && typeof args === 'object' ? args : {})
    if (target === '') return facts
    const canonical = toCanonical(target)
    facts.targets = [canonical]
    facts.outside = isOutsideWorkspace(canonical, canonicalWorkspace)
    return facts
  }
  if (family === 'shell') {
    const command = String(args && typeof args === 'object' ? (args.command ?? args.cmd ?? '') : '')
    const hints = shellWriteHints(command)
    facts.unknown = hints.unknownTarget && hints.targets.length === 0
    for (const spelling of hints.targets) {
      let canonical
      try {
        canonical = toCanonical(spelling)
      } catch {
        facts.unknown = true
        continue
      }
      facts.targets.push(canonical)
      if (isOutsideWorkspace(canonical, canonicalWorkspace)) facts.outside = true
    }
    if (facts.targets.length === 0) facts.unknown = true
    else facts.unknown = facts.unknown || !hints.mutation
    return facts
  }
  return facts
}

/**
 * Distinguish a guard fault from a policy denial in the model- and
 * user-facing text, so the user knows this call was stopped by the product
 * guard itself (recoverable) rather than by the DSH policy (final).
 * @param {string} toolName - the tool the guard failed to classify.
 * @param {unknown} error - the thrown value.
 * @returns {string} the recoverable denial reason.
 */
export function guardFaultReason(toolName, error) {
  const code = error instanceof Error ? error.name || 'Error' : typeof error
  return `产品安全守卫内部故障，已拒绝本次 ${String(toolName || '工具')} 调用；`
    + '本次没有任何文件或命令被执行。这是守卫故障（非 DSH 策略拒绝）：可在 DSH 设置中重新保存权限或重启 Bot 后重试。'
    + `诊断代码：SANDBOX_GUARD_FAULT/${code}`
}

/** The denial a disabled screen switch produces (a product policy decision, not a fault). */
const SCREEN_DENIED_REASON = '屏幕查看已在 Bot 设置中关闭（DSH 设置 → Bot → 权限）。这是产品策略拒绝，不是守卫故障；文件与命令均未执行。'

/**
 * @typedef {object} SandboxGuardDeps
 * @property {(exec: object) => boolean} isOurs - whether the call belongs to the Bot session.
 * @property {() => string} workspace - the canonical Bot workspace root.
 * @property {(exec: object) => string} cwdOf - working directory for relative path resolution.
 * @property {() => boolean} screenViewAllowed - the product screen switch.
 * @property {(name: string) => string} toolDescription - registry description for a tool, or ''.
 * @property {(exec: object, operation: object) => void} recordOperation - per-call operation record for exact grants.
 * @property {(event: string, fields?: object) => void} audit - product audit sink (best effort).
 * @property {(facts: { toolName: string, family: string, outside: boolean, unknown: boolean, targets: string[], cwd: string }) => object | null} [confirmUnenforcedWrite] - product confirmation for a recognized mutating tool whose file effects no mounted provider confines; returning a PreToolDecision short-circuits this call.
 * @property {(call: object) => { family: string, outside: boolean, unknown: boolean, targets: string[] }} [classify] - classification override for tests.
 */

/**
 * Build the product pre-execute guard. The returned listener is fail-closed:
 * any exception while classifying denies THIS call with a recoverable
 * diagnostic and an audit event.
 *
 * For a recognized mutating call on a composition whose file effects are NOT
 * bounded by a mounted confining provider, `confirmUnenforcedWrite` may return
 * a product confirmation (`ask`) — a UX/permission decision for that tool
 * family, never a claim that the heuristic bounds arbitrary shell side
 * effects. On the shipped profile the filesystem and shell providers confine,
 * so the upstream one-shot escalation is the only approval path.
 * @param {SandboxGuardDeps} deps - the guard's product dependencies.
 * @returns {(exec: object, next: () => Promise<unknown>) => Promise<unknown>} the waterfall listener.
 */
export function createSandboxGuard(deps) {
  const classify = deps.classify ?? classifyWriteIntent
  const deny = (reason) => ({ kind: 'deny', reason })
  return async function sandboxGuard(exec, next) {
    const name = String(exec?.name || '')
    let ours
    try {
      ours = deps.isOurs(exec)
    } catch (error) {
      // Ownership cannot be established: treat the call as ours and refuse it
      // rather than leaking an unclassified call into execution.
      deps.audit('tool.guard_fault', { tool: name, error: String(error?.message || error) })
      return deny(guardFaultReason(name, error))
    }
    if (!ours) return next()
    try {
      const args = exec?.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}
      const cwd = deps.cwdOf(exec)
      deps.recordOperation(exec, { toolName: name, arguments: args, cwd })
      if (!deps.screenViewAllowed() && isScreenCapableTool(name, deps.toolDescription(name) || '')) {
        deps.audit('tool.denied_screen_view', { tool: name })
        return deny(SCREEN_DENIED_REASON)
      }
      const intent = classify({ toolName: name, arguments: args, workspace: deps.workspace(), cwd })
      if (intent.family !== 'other' && (intent.outside || intent.unknown)) {
        deps.audit('write.outside_workspace_hint', {
          tool: name,
          family: intent.family,
          outside: intent.outside,
          unknownTarget: intent.unknown,
          targets: intent.targets.slice(0, 8),
        })
      }
      const confirmation = intent.outside && deps.confirmUnenforcedWrite
        ? deps.confirmUnenforcedWrite({ toolName: name, family: intent.family, outside: intent.outside, unknown: intent.unknown, targets: intent.targets, cwd })
        : null
      if (confirmation) return confirmation
      return next()
    } catch (error) {
      deps.audit('tool.guard_fault', { tool: name, error: String(error?.message || error) })
      return deny(guardFaultReason(name, error))
    }
  }
}
