/** Build the current Pipecat frontend and lifecycle resources from source. */
import { build } from 'esbuild'
import { mkdirSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'),
  dest = resolve(root, 'apps/desktop/resources/pet')
mkdirSync(dest, { recursive: true })
await build({
  entryPoints: [resolve(root, 'product/pet/src/voice-client.mjs')],
  outfile: resolve(dest, 'voice-client.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome130',
  minify: true,
  nodePaths: [resolve(root, 'apps/desktop/node_modules')],
  legalComments: 'eof',
  jsx: 'automatic',
})
for (const file of ['voice-worker-runtime.mjs', 'voice-worker-supervisor.mjs', 'bubble-window.mjs', 'desktop-surface-layout.mjs', 'orb-placement.mjs', 'companion-presentation.mjs', 'activity-bubble.mjs', 'pause-on-input.mjs'])
  copyFileSync(resolve(root, 'product/pet/src', file), resolve(dest, file))
copyFileSync(resolve(root, 'product/pet/APACHE-2.0.txt'), resolve(dest, 'APACHE-2.0.txt'))
