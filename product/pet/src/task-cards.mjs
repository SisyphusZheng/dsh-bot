/** Read-only cards projected from official Bot Session events. */
export function createTaskCards(publish) {
  let cards = [], current
  return { event(event) {
    const data = event.data || {}, key = event.turnId
    if (event.type === 'runtime.owner') { cards = []; current = undefined }
    if (event.type === 'turn.accepted') { current = { id: data.messageId || `accepted:${event.ioSeq}`, text: '', state: 'queued', tool: '' }; cards.push(current) }
    if (event.type === 'turn.started') { current = cards.find(card => card.state === 'queued') || { id: key || `turn:${event.ioSeq}`, text: '', tool: '' }; if (!cards.includes(current)) cards.push(current); current.id = key || current.id; current.state = 'working' }
    if (key) current = cards.find(card => card.id === key) || current
    if (current) {
      if (event.type === 'user.message') current.text = String(data.text || '').slice(0, 140)
      if (event.type === 'tool.call') current.tool = String(data.toolName || data.name || '').slice(0, 80)
      if (event.type === 'tool.result') current.tool = ''
      if (event.type === 'turn.ended') { current.state = data.reason?.kind === 'completed' ? 'completed' : data.reason?.kind === 'failed' ? 'failed' : 'cancelled'; current.tool = '' }
      if (event.type === 'error') current.state = 'failed'
    }
    cards = cards.slice(-3); publish(cards.map(card => ({ ...card })))
  } }
}
