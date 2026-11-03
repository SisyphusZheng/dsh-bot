/**
 * Product identity reported by the desktop Host Integration bridge.
 *
 * The Desktop resolves the product version from the application build and the runtime version
 * from the DSH runtime manifest it launches, then passes both as environment entries. This bundle
 * deliberately carries no version literal: a second copy would drift from `product/versions.json`
 * at the next version bump. An embedding that supplies neither reports `unknown` instead of
 * guessing a version that the user could mistake for the shipped identity.
 */

const UNKNOWN = 'unknown'

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}

/**
 * Resolve the identity this bridge reports.
 * @param environment - the environment carrying the Desktop's resolved versions.
 * @returns the product version and the runtime version, each `unknown` when unset.
 */
export function productIdentity(environment = process.env) {
  return {
    productVersion: text(environment.NISSE_PRODUCT_VERSION) || UNKNOWN,
    runtimeVersion: text(environment.NISSE_RUNTIME_VERSION) || UNKNOWN,
  }
}
