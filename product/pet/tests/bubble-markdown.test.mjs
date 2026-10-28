import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { renderBubbleMarkdown } from '../src/bubble-markdown.mjs'

test('bubble Markdown renders headings, emphasis, lists and code as a recorded DOM fixture', () => {
  const dom = new JSDOM('<div id="text"></div>'), target = dom.window.document.getElementById('text')
  renderBubbleMarkdown(target, '## 结果\n\n**完成**，保留 `code`。\n\n- 第一项\n- 第二项\n\n```sh\necho ok\n```')
  assert.equal(target.innerHTML + '\n', readFileSync(new URL('./expected/bubble-markdown.html', import.meta.url), 'utf8'))
  dom.window.close()
})

test('streaming fragments and model HTML never create scripts, links or remote media', () => {
  const dom = new JSDOM('<div id="text"></div>'), target = dom.window.document.getElementById('text')
  for (const source of ['**还在', '**完成**', '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[打开](javascript:alert(1))\n\n![图片](https://example.invalid/track.png)']) {
    renderBubbleMarkdown(target, source)
    assert.equal(target.querySelector('script,img,a,iframe,style'), null)
    assert.equal(target.querySelector('[onclick],[onerror]'), null)
  }
  assert.match(target.textContent, /alert\(1\)/)
  assert.match(target.textContent, /打开/)
  dom.window.close()
})
