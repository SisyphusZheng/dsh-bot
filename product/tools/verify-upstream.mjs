/** Verify the complete official rc.3 tree and explicitly reviewed product overrides. */
import { readFileSync, lstatSync, readlinkSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
const root=resolve(import.meta.dirname,'../..'), manifest=JSON.parse(gunzipSync(readFileSync(resolve(root,'product/upstream-integrity.json.gz'))))
const overrides=JSON.parse(readFileSync(resolve(root,'product/upstream-allowlist.json'))), errors=[]
for(const path of Object.keys(overrides)) if(!manifest.files[path]) errors.push(`unknown allowlist path: ${path}`)
for(const [path, original] of Object.entries(manifest.files)) {
  const expected=overrides[path] || original
  try {
    const full=resolve(root,path),stat=lstatSync(full)
    let bytes=stat.isSymbolicLink()?Buffer.from(readlinkSync(full)):readFileSync(full)
    if(path.endsWith('.cmd')) bytes=Buffer.from(bytes.toString().replaceAll('\r\n','\n'))
    const sha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    const mode=stat.isSymbolicLink()?'120000':stat.mode & 0o111?'100755':'100644'
    if(sha!==expected.sha || mode!==expected.mode) errors.push(`${path}: expected ${expected.sha}/${expected.mode}, got ${sha}/${mode}`)
  }catch(error){errors.push(`${path}: ${error.message}`)}
}
if(errors.length){console.error(errors.join('\n'));process.exitCode=1}else console.log(`PASS ${Object.keys(manifest.files).length} official files, ${Object.keys(overrides).length} explicit product overrides; ${manifest.commit}`)
