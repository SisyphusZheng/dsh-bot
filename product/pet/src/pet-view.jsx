/** Restores the original sprite renderer independently of the DSH React document. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import DesktopSpriteOrb from './DesktopSpriteOrb.jsx'

export function createPetView(element, onError) {
  const root = createRoot(element)
  let view = { state: 'idle', baseWorking: false, cue: null, dragDirection: '' }
  const render = () => {
    element.dataset.state = view.state
    root.render(<DesktopSpriteOrb skin="whale-girl" {...view} onError={onError} onCueComplete={id => {
      if (view.cue?.id === id) { view = { ...view, cue: null }; render() }
    }} />)
  }
  render()
  return { update(next) { view = { ...view, ...next }; render() }, dispose() { root.unmount() } }
}
