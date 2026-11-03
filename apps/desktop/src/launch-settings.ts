/** Launch-at-login and close-to-background behavior owned by the Desktop app settings. */

import { app } from 'electron'

/**
 * Apply the persisted launch-at-login choice to the operating system.
 *
 * Unpackaged development builds are skipped: registering the Electron binary as a login item
 * would not start this product and would outlive the development session.
 * @param enabled - the persisted `app.autoStart` value.
 */
export function applyLaunchAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: enabled })
}

/**
 * Decide whether closing the main window keeps the application and the pet running.
 * @param keepRunning - the persisted `app.keepRunning` value; absent means the documented default.
 * @returns true when the process must continue after the window closes.
 */
export function closeKeepsRunning(keepRunning: boolean | undefined): boolean {
  return keepRunning !== false
}
