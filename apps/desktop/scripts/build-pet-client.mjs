/** Build the current Pipecat frontend and lifecycle resources from source. */
import { build } from 'esbuild'
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { build as buildClient } from 'tsdown'
const root = resolve(import.meta.dirname, '../../..'),
  dest = resolve(root, 'apps/desktop/resources/pet')
mkdirSync(dest, { recursive: true })
const markdown = await build({
  absWorkingDir: root,
  entryPoints: [resolve(root, 'product/pet/src/bubble-markdown.mjs')],
  outfile: resolve(dest, 'bubble-markdown.js'),
  bundle: true, format: 'iife', globalName: 'petMarkdown', platform: 'browser',
  target: 'chrome130', minify: true, legalComments: 'eof', metafile: true,
})
const markdownPackages = new Set()
for (const input of Object.keys(markdown.metafile.inputs)) {
  if (!input.includes('node_modules/')) continue
  let dir = dirname(resolve(root, input))
  while (!existsSync(resolve(dir, 'package.json'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`Markdown dependency has no package metadata: ${input}`)
    dir = parent
  }
  markdownPackages.add(dir)
}
const markdownLicenses = [...markdownPackages].sort().map(dir => {
  const meta = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
  const license = readdirSync(dir).find(name => /^licen[cs]e(?:[.-].*)?$/i.test(name))
  if (!license) throw new Error(`Missing bundled Markdown license: ${meta.name}`)
  return `${meta.name}@${meta.version}\n\n${readFileSync(resolve(dir, license), 'utf8').trim()}`
})
writeFileSync(resolve(dest, 'bubble-markdown.LICENSE.txt'), markdownLicenses.join('\n\n---\n\n') + '\n')
// The Host package's ./client is consumed as a classic script, never as Node ESM.
await buildClient({ config: resolve(root, 'nisse/packages/host-integration/tsdown.config.ts'), configLoader: 'native' })
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
for (const file of ['voice-worker-runtime.mjs', 'voice-worker-supervisor.mjs', 'bubble-window.mjs', 'window-layer-policy.mjs', 'desktop-surface-layout.mjs', 'orb-placement.mjs', 'companion-presentation.mjs', 'question-voice.mjs', 'desktop-attention.mjs', 'activity-bubble.mjs', 'pause-on-input.mjs', 'experience-runtime.mjs', 'experience-store.mjs', 'voice-input.mjs', 'global-option.mjs', 'onboarding.mjs', 'desktop-presence.mjs', 'i18n.mjs', 'skin-store.mjs', 'skin-catalog.mjs', 'legacy-preferences.mjs'])
  copyFileSync(resolve(root, 'product/pet/src', file), resolve(dest, file))
copyFileSync(resolve(root, 'product/pet/APACHE-2.0.txt'), resolve(dest, 'APACHE-2.0.txt'))

const wakeDest = resolve(dest, 'wake-word')
mkdirSync(wakeDest, { recursive: true })
for (const file of ['runtime.mjs', 'keyword-phrase.mjs']) copyFileSync(resolve(root, 'product/pet/src/wake-word', file), resolve(wakeDest, file))
await build({ entryPoints: [resolve(root, 'product/pet/src/wake-word/worker.mjs')], outfile: resolve(wakeDest, 'worker.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node22', nodePaths: [resolve(root, 'apps/desktop/node_modules')], banner: { js: "import { createRequire as _createRequire } from 'node:module';const require = _createRequire(import.meta.url);" } })
