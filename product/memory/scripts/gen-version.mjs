/** Record actual staged bytes; legacy manifests are provenance, not current build output. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, lstatSync, readlinkSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
const root=resolve(process.argv[2] || new URL('..',import.meta.url).pathname)
const versions=JSON.parse(readFileSync(new URL('../../versions.json',import.meta.url)))
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
function walk(dir,base=dir,out=[]){for(const name of readdirSync(dir).sort()){const full=join(dir,name),stat=lstatSync(full);if(stat.isDirectory())walk(full,base,out);else out.push({path:relative(base,full),mode:(stat.mode&0o777).toString(8),bytes:stat.size,sha256:sha(stat.isSymbolicLink()?Buffer.from(readlinkSync(full)):readFileSync(full)),symlink:stat.isSymbolicLink()})}return out}
const components=['runtime/hindsight','runtime/models','runtime/pg0','adapter','scripts'].map(path=>{const files=walk(join(root,path));return {path,files:files.length,sha256:sha(JSON.stringify(files)),manifest:files}})
const output={schema:'dsh-bot.memory/v2',generatedAt:new Date().toISOString(),product:versions.product,runtime:versions.runtime,nativeInput:versions.nativeInput,dependencies:versions.memory,components,sidecarSha256:sha(readFileSync(join(root,'sidecar.mjs')))}
writeFileSync(join(root,'VERSION.json'),JSON.stringify(output,null,2)+'\n')
console.log('Recorded actual staged memory payload hashes')
