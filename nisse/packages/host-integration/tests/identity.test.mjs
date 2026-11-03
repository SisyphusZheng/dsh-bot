import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { productIdentity } from '../lib/identity.mjs'

const root = resolve(import.meta.dirname, '../../../..')
const lib = resolve(import.meta.dirname, '../lib')

test('the bridge reports the versions the Desktop resolved', () => {
  assert.deepEqual(productIdentity({ NISSE_PRODUCT_VERSION: '0.0.1', NISSE_RUNTIME_VERSION: '0.2.1-rc.3' }),
    { productVersion: '0.0.1', runtimeVersion: '0.2.1-rc.3' })
})

test('an embedding that supplies no identity reports unknown instead of a guessed version', () => {
  assert.deepEqual(productIdentity({}), { productVersion: 'unknown', runtimeVersion: 'unknown' })
  assert.deepEqual(productIdentity({ NISSE_PRODUCT_VERSION: '  ', NISSE_RUNTIME_VERSION: '' }),
    { productVersion: 'unknown', runtimeVersion: 'unknown' })
})

test('the bridge carries no copy of the declared product version', () => {
  const declared = JSON.parse(readFileSync(join(root, 'product', 'versions.json'), 'utf8')).product.version
  // Only an exact quoted version literal counts: prose such as "0.0.1 起默认权限…" is not an identity copy.
  const literal = new RegExp(`['"\`]${declared.replaceAll('.', '\\.')}['"\`]`)
  const modules = readdirSync(lib).filter((name) => name.endsWith('.mjs') || name.endsWith('.js'))
  assert.ok(modules.includes('identity.mjs'))
  for (const module of modules) {
    assert.equal(literal.test(readFileSync(join(lib, module), 'utf8')), false,
      `${module} hardcodes the product version ${declared}; read it from the Desktop environment instead`)
  }
})
