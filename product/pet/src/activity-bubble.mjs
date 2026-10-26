// 活动气泡（P1）：DSH 事件 → 桌宠头顶的「小动作」气泡。
//
// DSH 拥有 turn；桌宠只把 bridge /events 的能力映射成看得懂的小图标：
// 思考 / 阅读 / 搜索 / 写文件 / 用电脑。写文件、读文件要显示文件名。
//
// 关键交互规则：
//   - 活动气泡必须点击穿透（不挡用户操作）→ `clickThrough: true`，
//     气泡渲染层看到这个字段就永远不请求可交互；
//   - 审批气泡仍然可点「是/否」→ 由 approvalBubblePayload 单独处理，
//     不走这里；
//   - tool.result 之后短暂显示「完成」再收起，避免一直挂着。
//
// 纯函数，无 electron/网络依赖。

export const ACTIVITY_HOLD_MS = 2_600
export const ACTIVITY_RESULT_HOLD_MS = 1_600

export const ACTIVITY_ICONS = Object.freeze({
  think: '💭',
  read: '📖',
  search: '🔍',
  write: '✍️',
  computer: '🖥️',
  tool: '⚙️',
  done: '✅',
  error: '⚠️',
})

const TOOL_KIND_PATTERNS = Object.freeze([
  ['computer', /computer|screenshot|screen|browser|click|type_text|use_computer/i],
  ['write', /write|edit|apply_patch|str_replace|create_file|append|patch|delete_file|move_file|rename/i],
  ['read', /read|view|open_file|filesystem_read|cat\b|show_file|list_dir|glob\b/i],
  ['search', /search|grep|find|query|web_search|lookup/i],
])

/** Classify one tool name into an activity kind. */
export function classifyTool(name) {
  const text = String(name || '').trim()
  if (!text) return 'tool'
  for (const [kind, pattern] of TOOL_KIND_PATTERNS) {
    if (pattern.test(text)) return kind
  }
  return 'tool'
}

const FILE_KEYS = Object.freeze([
  'file_path', 'filePath', 'path', 'target_file', 'targetFile', 'filename',
  'file', 'notebook_path', 'absolute_path',
])

const BASENAME = /([^/\\]+)$/

/** Pull a file name out of the bridge's arguments preview (JSON-ish text). */
export function extractFileName(preview) {
  const text = String(preview || '')
  if (!text) return ''
  for (const key of FILE_KEYS) {
    const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
    const match = text.match(pattern)
    if (match?.[1]) return cleanFileName(match[1])
  }
  // 非 JSON 的参数（bash 命令等）：取最后一个看起来像文件路径的片段。
  const bare = text.match(/(?:^|[\s"'`=])((?:~|\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)*\.[A-Za-z0-9]{1,8})(?:$|[\s"'`,)])/)
  if (bare?.[1]) return cleanFileName(bare[1])
  return ''
}

function cleanFileName(value) {
  const decoded = String(value || '')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .trim()
  if (!decoded) return ''
  const base = decoded.match(BASENAME)?.[1] || decoded
  return base.slice(0, 60)
}

/** Activity label in Chinese, e.g. 「写文件 · report.md」. */
export function activityLabel(kind, fileName = '') {
  const base = {
    think: '思考中…',
    read: '读文件',
    search: '搜索',
    write: '写文件',
    computer: '用电脑',
    tool: '用工具',
    done: '完成',
    error: '出错了',
  }[kind] || '处理中'
  const file = String(fileName || '').trim()
  if (!file) return kind === 'think' ? base : `${base}…`
  return `${base} · ${file}`
}

function toolDisplayName(data) {
  return String(data?.name || data?.toolName || '').trim()
}

/**
 * Bridge event → activity bubble payload, or null when the event is not an
 * activity. The caller (main.mjs) shows approval/speech bubbles separately.
 */
export function activityBubblePayload(event) {
  const type = String(event?.type || '')
  const data = event?.data && typeof event.data === 'object' ? event.data : {}
  if (type === 'turn.started' || type === 'turn.accepted' || type === 'user.message') {
    return {
      kind: 'activity',
      icon: ACTIVITY_ICONS.think,
      text: '让我想想…',
      clickThrough: true,
      activity: 'think',
    }
  }
  if (type === 'tool.call') {
    const name = toolDisplayName(data)
    const kind = classifyTool(name)
    const fileName = extractFileName(data.argumentsPreview)
    return {
      kind: 'activity',
      icon: ACTIVITY_ICONS[kind],
      text: activityLabel(kind, fileName),
      clickThrough: true,
      activity: kind,
      toolName: name,
      fileName,
    }
  }
  if (type === 'tool.result') {
    const name = toolDisplayName(data)
    const kind = classifyTool(name)
    const fileName = extractFileName(data.resultPreview) || extractFileName(data.argumentsPreview)
    const failed = data.isError === true
    return {
      kind: 'activity',
      icon: failed ? ACTIVITY_ICONS.error : ACTIVITY_ICONS.done,
      text: failed ? activityLabel('error', '') : `搞定：${activityLabel(kind, fileName)}`,
      clickThrough: true,
      activity: failed ? 'error' : 'done',
      toolName: name,
      fileName,
      holdMs: ACTIVITY_RESULT_HOLD_MS,
    }
  }
  return null
}

/** Whether this bridge event ends any visible activity (bubble should hide). */
export function activityEndsTurn(event) {
  const type = String(event?.type || '')
  return type === 'turn.settled'
    || type === 'turn.ended'
    || (type === 'agent.status' && event?.data?.status === 'idle')
    || type === 'error'
    || type === 'agent.error'
}

/** Activity bubbles never take clicks; only approval/speech choices may. */
export function activityClickThrough(payload) {
  return Boolean(payload && payload.kind === 'activity' || payload?.clickThrough === true)
}
