/** Build the product Client with the official classic-script module registration. */
import { clientBundle } from '../../../packages/client/tsdown.client.ts'

const configs = clientBundle(import.meta.dirname, [])({})
export default configs.filter(config => config.platform === 'browser').map(config => ({
  ...config,
  cwd: import.meta.dirname,
  entry: { client: 'src/client/index.js' },
}))
