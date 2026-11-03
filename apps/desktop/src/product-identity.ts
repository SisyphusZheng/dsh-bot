/** Product identity the Desktop passes to the DSH host process. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Read the runtime version from the DSH runtime manifest the host process will load.
 * @param dshDirectory - the runtime directory handed to the host process.
 * @returns the manifest version, or an empty string when the manifest is missing or unreadable.
 */
export function runtimeManifestVersion(dshDirectory: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(dshDirectory, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : ''
  } catch {
    // An unreadable manifest yields an unknown identity; reporting a guessed version would be worse.
    return ''
  }
}

/**
 * Build the identity environment entries the DSH host process reports to users and snapshots.
 *
 * The Host Integration bundle carries no version literal of its own: a second copy would drift
 * from `product/versions.json` at the next version bump. The product version is the application
 * build Electron reports, and the runtime version is the manifest of the runtime being launched.
 * @param appVersion - the application version Electron reports for this build.
 * @param dshDirectory - the runtime directory handed to the host process.
 * @returns the environment entries to merge into the host spawn environment.
 */
export function hostProductIdentity(appVersion: string, dshDirectory: string): NodeJS.ProcessEnv {
  const identity: NodeJS.ProcessEnv = { NISSE_PRODUCT_VERSION: appVersion }
  const runtimeVersion = runtimeManifestVersion(dshDirectory)
  if (runtimeVersion !== '') identity.NISSE_RUNTIME_VERSION = runtimeVersion
  return identity
}
