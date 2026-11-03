import assert from 'node:assert/strict'
import test from 'node:test'
import { USER_DEFAULT_PRESET, resolvePermissionPreset } from '../lib/permission-preset.mjs'

/** Fixture service mirroring the Host permission-presets surface. */
function presets({ current, defaultPreset, options = ['read-only', 'workspace-write', 'danger-full-access', 'bot-outside-write'] } = {}) {
  const catalog = { defaultOptions: options.map(value => ({ value })), options: options.map(value => ({ value })), defaultPreset }
  return {
    catalog: () => catalog,
    ...(current === undefined ? {} : { current: () => current }),
    ...(defaultPreset === undefined ? {} : { defaultPreset }),
  }
}

test('an explicit configured preset is applied unchanged', () => {
  assert.equal(resolvePermissionPreset({ requested: 'bot-outside-write', presets: presets({ current: 'danger-full-access' }), session: {} }), 'bot-outside-write')
})

test('the user selection is authoritative and is never narrowed on cold start', () => {
  const service = presets({ current: 'danger-full-access', defaultPreset: 'workspace-write' })
  assert.equal(resolvePermissionPreset({ requested: USER_DEFAULT_PRESET, presets: service, session: {} }), 'danger-full-access')
})

test('without a session choice the configured default applies', () => {
  const service = presets({ current: 'custom', defaultPreset: 'workspace-write' })
  assert.equal(resolvePermissionPreset({ requested: USER_DEFAULT_PRESET, presets: service, session: {} }), 'workspace-write')
})

test('unavailable or malformed permission state falls back to the safe bundle', () => {
  assert.equal(resolvePermissionPreset({ requested: USER_DEFAULT_PRESET, presets: null, session: {} }), 'bot-outside-write')
  assert.equal(resolvePermissionPreset({ requested: USER_DEFAULT_PRESET, presets: presets({ current: 'auto', defaultPreset: 'custom' }), session: {} }), 'bot-outside-write')
  const throwing = { catalog: () => { throw new Error('no projection') }, current: () => { throw new Error('no session') }, defaultPreset: 'not-a-preset' }
  assert.equal(resolvePermissionPreset({ requested: USER_DEFAULT_PRESET, presets: throwing, session: {} }), 'bot-outside-write')
})
