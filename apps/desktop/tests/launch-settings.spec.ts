/** Launch-at-login is a real operating-system setting; close-to-background follows the opt-out. */
import { afterEach, expect, it, vi } from 'vitest'

const desktop = vi.hoisted(() => ({ app: { isPackaged: true, setLoginItemSettings: vi.fn() } }))
vi.mock('electron', () => desktop)

const { applyLaunchAtLogin, closeKeepsRunning } = await import('../src/launch-settings.ts')

afterEach(() => {
  desktop.app.isPackaged = true
  desktop.app.setLoginItemSettings.mockClear()
})

it('reconciles the login item with the persisted choice', () => {
  applyLaunchAtLogin(true)
  expect(desktop.app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true })
  applyLaunchAtLogin(false)
  expect(desktop.app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false })
})

it('never registers the unpackaged development binary as a login item', () => {
  desktop.app.isPackaged = false
  applyLaunchAtLogin(true)
  expect(desktop.app.setLoginItemSettings).not.toHaveBeenCalled()
})

it('keeps the application running on window close unless the user opted out', () => {
  expect(closeKeepsRunning(undefined)).toBe(true)
  expect(closeKeepsRunning(true)).toBe(true)
  expect(closeKeepsRunning(false)).toBe(false)
})
