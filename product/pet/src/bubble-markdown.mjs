/** Render CommonMark as inert DOM; model output cannot create executable HTML or remote media. */
import { fromMarkdown } from 'mdast-util-from-markdown'

const tags = { paragraph: 'p', strong: 'strong', emphasis: 'em', inlineCode: 'code', blockquote: 'blockquote', listItem: 'li' }

/** @param {Element} container Destination owned by the bubble renderer. @param {string} source Untrusted model text. */
export function renderBubbleMarkdown(container, source) {
  const document = container.ownerDocument
  function append(parent, node) {
    if (node.type === 'text' || node.type === 'html') {
      parent.appendChild(document.createTextNode(node.value))
      return
    }
    if (node.type === 'image' || node.type === 'imageReference') {
      parent.appendChild(document.createTextNode(node.alt || ''))
      return
    }
    if (node.type === 'code') {
      const pre = document.createElement('pre'), code = document.createElement('code')
      code.textContent = node.value
      pre.appendChild(code); parent.appendChild(pre)
      return
    }
    const tag = node.type === 'list' ? node.ordered ? 'ol' : 'ul'
      : node.type === 'heading' ? 'h' + node.depth
        : node.type === 'break' ? 'br' : node.type === 'thematicBreak' ? 'hr' : tags[node.type]
    const target = tag ? document.createElement(tag) : parent
    if (node.type === 'list' && node.ordered && node.start !== null) target.start = node.start
    if (node.type === 'inlineCode') target.textContent = node.value
    for (const child of node.children || []) append(target, child)
    // Links keep their readable label, without granting model output navigation.
    if (target !== parent) parent.appendChild(target)
  }
  container.replaceChildren()
  append(container, fromMarkdown(String(source || '')))
}
