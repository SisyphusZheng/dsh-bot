/** Declared product version, so test fixtures cannot drift from product/versions.json. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const PRODUCT_VERSION = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../../product/versions.json'), 'utf8'),
).product.version
