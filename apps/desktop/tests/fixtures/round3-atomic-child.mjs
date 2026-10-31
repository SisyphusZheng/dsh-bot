// Child-process entry for the round-3 atomic-profile tests. It runs against the
// TypeScript source through tsx, so the assertions exercise the same code the
// Electron main process runs instead of a reimplementation.
const [mode, ...args] = process.argv.slice(2)
const { BotRuntime, updateProfileManifest, writeBotProfileFile } = await import('../../src/bot-runtime.ts')

/** Busy-wait inside the critical section so a missing lock would deterministically lose an update. */
function spin(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) { /* spin */ }
}

if (mode === 'prepare') {
  const [home, resources, runtimeRoot] = args
  const runtime = new BotRuntime(home, resources, undefined, runtimeRoot)
  await runtime.prepare({})
  process.stdout.write('ok\n')
} else if (mode === 'manifest-add') {
  const [home, key, delayMs] = args
  const file = `${home}/profiles/desktop/package.json`
  await updateProfileManifest(file, (manifest) => {
    const dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
    spin(Number(delayMs) || 0)
    dependencies[key] = '1'
    manifest.dependencies = dependencies
  })
  process.stdout.write('ok\n')
} else if (mode === 'write-file') {
  const [file, content, modeBits] = args
  await writeBotProfileFile(file, content, Number(modeBits) || 0o600)
  process.stdout.write('ok\n')
} else if (mode === 'write-json-big') {
  // Build the payload inside the child: argv cannot carry multi-megabyte content.
  const [file, padBytes] = args
  const content = `${JSON.stringify({ name: 'new', private: true, dependencies: {}, pad: 'x'.repeat(Number(padBytes)) }, null, 2)}\n`
  await writeBotProfileFile(file, content, 0o644)
  process.stdout.write('ok\n')
} else if (mode === 'loop-write') {
  const [file, first, second, count] = args
  for (let index = 0; index < Number(count); index += 1) await writeBotProfileFile(file, index % 2 === 0 ? first : second, 0o600)
  process.stdout.write('ok\n')
} else {
  throw new Error(`unknown child mode: ${mode}`)
}
