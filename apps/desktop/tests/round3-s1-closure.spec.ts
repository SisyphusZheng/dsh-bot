/**
 * Round-3 S1 closure: the migration notice must travel data → rendered settings
 * UI (not only an unconsumed API field), and the default-permission copy must
 * match the platform temp-grant semantics the sandbox actually enforces.
 *
 * The page is a generated self-contained HTML document, so the test boots its
 * real `<script>` body in a minimal DOM and drives the same fetch/status/render
 * path the desktop shell uses.
 */
import { describe, expect, it } from 'vitest'
import {
  PERMISSION_DOWNGRADE_NOTICE,
  managedProfilePatch,
} from '../src/bot-runtime.ts'
import { buildBotSettingsPage } from '../src/bot-settings-page.ts'

type Handler = (event?: { target: FakeNode }) => void

/** Minimal DOM node covering every property the generated settings script touches. */
class FakeNode {
  readonly tagName: string
  children: FakeNode[] = []
  className = ''
  textContent = ''
  dataset: Record<string, string> = {}
  value = ''
  checked = false
  disabled = false
  type = ''
  placeholder = ''
  min = ''
  max = ''
  step = ''
  rows = 0
  onclick: Handler | null = null
  onchange: Handler | null = null
  oninput: Handler | null = null
  private html = ''
  constructor(tagName: string) { this.tagName = tagName }
  set innerHTML(value: string) { this.html = value; if (value === '') this.children = [] }
  get innerHTML(): string { return this.html }
  appendChild<T extends FakeNode>(child: T): T { this.children.push(child); return child }
  get text(): string {
    const own = this.textContent
    return [own, ...this.children.map(child => child.text)].filter(part => part !== '').join(' ')
  }
  find(predicate: (node: FakeNode) => boolean): FakeNode | undefined {
    if (predicate(this)) return this
    for (const child of this.children) {
      const found = child.find(predicate)
      if (found !== undefined) return found
    }
    return undefined
  }
  findAll(predicate: (node: FakeNode) => boolean, output: FakeNode[] = []): FakeNode[] {
    if (predicate(this)) output.push(this)
    for (const child of this.children) child.findAll(predicate, output)
    return output
  }
}

/** Minimal localStorage stand-in with the same string contract. */
class FakeStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

interface PageHarness {
  switchTab: (id: string) => void
  panels: FakeNode
  storage: FakeStorage
  panelsText: () => string
}

const CATALOG = JSON.stringify({
  voice: [{ id: 'dashscope', label: 'DashScope' }],
  llm: [{ id: 'custom', label: 'Custom' }],
})
const CONFIG = {
  voice: { provider: 'dashscope' },
  llm: { provider: 'custom', model: 'mvp' },
  persona: {},
  app: { responseStyle: 'concise' },
  approval: { mode: 'ask-each', onceMinutes: 10 },
  behavior: { allowScreenView: false },
}

/** Boot the generated page against a fixed `/bot/status` payload. */
function bootPage(status: Record<string, unknown>, acknowledgedNotice?: string): PageHarness {
  const elements: Record<string, FakeNode> = {
    tabs: new FakeNode('div'),
    panels: new FakeNode('div'),
    status: new FakeNode('span'),
    save: new FakeNode('button'),
  }
  const storage = new FakeStorage()
  if (acknowledgedNotice !== undefined) storage.setItem('bot.permissionNoticeAck', acknowledgedNotice)
  const document = { createElement: (tag: string) => new FakeNode(tag), getElementById: (id: string) => elements[id] }
  const window = { __memoryTimer: null, confirm: () => true, localStorage: storage }
  const fetchStub = (path: string) => Promise.resolve({
    status: 200,
    json: () => Promise.resolve(path === '/bot/config' ? { ok: true, config: CONFIG } : path === '/bot/status' ? { ok: true, status } : { ok: true }),
  })
  const page = buildBotSettingsPage(CATALOG)
  const script = /<script>([\s\S]*)<\/script>/.exec(page)?.[1] ?? ''
  const factory = new Function('document', 'window', 'fetch', 'setInterval', 'clearInterval', `${script}\nreturn { switchTab: switchTab, render: render };`) as (
    document: unknown,
    window: unknown,
    fetch: unknown,
    setInterval: unknown,
    clearInterval: unknown,
  ) => { switchTab: (id: string) => void; render: () => void }
  const pageApi = factory(document, window, fetchStub, setInterval, clearInterval)
  return {
    switchTab: pageApi.switchTab,
    panels: elements.panels as FakeNode,
    storage,
    panelsText: () => (elements.panels as FakeNode).text,
  }
}

/** Let the page's config/status promises settle and re-render. */
async function flushPage(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

describe('default-permission promise matches the enforced sandbox boundary', () => {
  it('managed patch names the workspace AND platform temp directories instead of claiming every outside write is denied', () => {
    const patch = managedProfilePatch({}, '/home/bot-home', false, null)
    expect(patch).toContain('平台临时目录')
    expect(patch).not.toContain('仅在 Bot 工作区内读写')
    expect(patch).not.toContain('只在 Bot 工作区内读写')
    // The only remaining "outside" refusal wording must be about positions other than the temp grants.
    expect(patch).toContain('其他位置的写入会被 DSH 沙箱拒绝')
  })

  it('settings page renders the same promise (workspace + platform temp directories)', () => {
    const page = buildBotSettingsPage(CATALOG)
    expect(page).toContain('平台临时目录')
    expect(page).not.toContain('Bot 只能在 Bot 工作区内自由读写')
  })

  it('migration notice states the narrowing, the temp-dir boundary, the no-widening guarantee and the recovery path', () => {
    expect(PERMISSION_DOWNGRADE_NOTICE).toContain('全文访问')
    expect(PERMISSION_DOWNGRADE_NOTICE).toContain('工作区写入')
    expect(PERMISSION_DOWNGRADE_NOTICE).toContain('平台临时目录')
    expect(PERMISSION_DOWNGRADE_NOTICE).toContain('只会收紧权限，不会放宽')
    expect(PERMISSION_DOWNGRADE_NOTICE).toContain('/permission danger-full-access')
  })
})

describe('migration notice is user-visible in the settings UI', () => {
  it('shows the migrated notice in the permissions panel and hides it after 我知道了', async () => {
    const harness = bootPage({ permissionNotice: PERMISSION_DOWNGRADE_NOTICE })
    await flushPage()
    harness.switchTab('permissions')
    await flushPage()
    const text = harness.panelsText()
    expect(text).toContain('权限已收紧（一次性说明）')
    expect(text).toContain('全文访问')
    expect(text).toContain('工作区写入')
    expect(text).toContain('平台临时目录')
    expect(text).toContain('只会收紧权限，不会放宽')
    expect(text).toContain('/permission danger-full-access')

    const acknowledge = harness.panels.findAll(node => node.tagName === 'button' && node.textContent === '我知道了')[0]
    expect(acknowledge).toBeDefined()
    acknowledge?.onclick?.()
    await flushPage()
    expect(harness.panelsText()).not.toContain('权限已收紧（一次性说明）')
    expect(harness.storage.getItem('bot.permissionNoticeAck')).toBe(PERMISSION_DOWNGRADE_NOTICE)
  })

  it('a page view after the acknowledgement does not repeat the notice', async () => {
    const harness = bootPage({ permissionNotice: PERMISSION_DOWNGRADE_NOTICE }, PERMISSION_DOWNGRADE_NOTICE)
    await flushPage()
    harness.switchTab('permissions')
    await flushPage()
    expect(harness.panelsText()).not.toContain('权限已收紧（一次性说明）')
  })

  it('does not show any notice when this launch did not migrate a legacy profile', async () => {
    const harness = bootPage({ permissionNotice: '', permission: { preset: 'bot-outside-write', sandbox: 'workspace-write', approval: 'ask', verified: true } })
    await flushPage()
    harness.switchTab('permissions')
    await flushPage()
    const text = harness.panelsText()
    expect(text).not.toContain('权限已收紧（一次性说明）')
    expect(text).toContain('审批粒度')
  })
})
