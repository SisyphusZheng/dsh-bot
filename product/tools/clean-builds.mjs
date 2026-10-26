/** Preview by default; delete only explicitly named, inactive build/acceptance directories. */
import { lstatSync, readdirSync, realpathSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'
const root = resolve(import.meta.dirname, '../..'), stage = join(root, '.mvv-build')
const args = process.argv.slice(2), apply = args.includes('--apply'), requested = args.filter(arg => arg !== '--apply')
function bytes(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) return stat.size
  return stat.isDirectory() ? readdirSync(path).reduce((sum, name) => sum + bytes(join(path, name)), 0) : stat.size
}
function active(path) {
  for (const descriptor of ['user-data/dsh-home/bot/bridge.json', 'user-data/dsh-home/memory/runtime.json']) {
    try {
      const data = JSON.parse(readFileSync(join(path, descriptor)))
      if (Number.isInteger(data.pid)) { try { process.kill(data.pid, 0); return true } catch (error) { if (error.code !== 'ESRCH') return true } }
    } catch (error) { if (error.code !== 'ENOENT') return true }
  }
  return false
}
const candidates = existsSync(stage) ? readdirSync(stage).filter(name => /^acceptance-\d+$/.test(name)) : []
if (!requested.length) {
  for (const name of candidates) console.log(`${name}\t${(bytes(join(stage, name)) / 1024 ** 3).toFixed(2)} GiB\t${active(join(stage, name)) ? 'ACTIVE — keep' : 'inactive'}`)
  console.log('Preview only. Delete a reviewed directory: node product/tools/clean-builds.mjs acceptance-<id> --apply')
} else {
  for (const name of requested) {
    if (!candidates.includes(name)) throw new Error(`Not an owned acceptance directory: ${name}`)
    const path = join(stage, name)
    if (lstatSync(path).isSymbolicLink() || relative(realpathSync(stage), realpathSync(path)) !== name) throw new Error('Refusing linked path')
    if (active(path)) throw new Error(`Acceptance app may still be running: ${name}`)
    // Keep the entire evidence directory; only the app copy/cache is disposable.
    console.log(`${apply ? 'Removing' : 'Would remove'} ${name}/dsh-bot.app and ${name}/user-data/Cache; logs and personal databases remain`)
    if (apply) {
      for (const child of ['dsh-bot.app', 'user-data/Cache', 'user-data/Code Cache', 'user-data/GPUCache']) {
        const target = join(path, child)
        if (!existsSync(target)) continue
        if (lstatSync(target).isSymbolicLink()) throw new Error(`Refusing linked build resource: ${child}`)
        rmSync(target, { recursive: true })
      }
    }
  }
}
