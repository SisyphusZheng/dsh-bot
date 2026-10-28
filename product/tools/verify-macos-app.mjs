/** Inspect actual native resources. Signature validity and Gatekeeper are separate facts. */
import { readdirSync, lstatSync, openSync, readSync, closeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
const magic = new Set(['feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca'])
export function machOFiles(root) {
 const result=[]
 function walk(path) {
  const stat=lstatSync(path)
  if(stat.isSymbolicLink())return
  if(stat.isDirectory()){for(const name of readdirSync(path))walk(join(path,name));return}
  if(!stat.isFile()||stat.size<4)return
  const fd=openSync(path,'r'),bytes=Buffer.alloc(8)
  try{readSync(fd,bytes,0,8,0)}finally{closeSync(fd)}
  const header=bytes.subarray(0,4).toString('hex')
  if(!magic.has(header))return
  if(header.startsWith('cafeba')||header==='bebafeca'||header==='bfbafeca'){const count=header.startsWith('cafe')?bytes.readUInt32BE(4):bytes.readUInt32LE(4);if(count<1||count>16)return}
  result.push(path)
 }
 walk(root);return result.sort()
}
function codesign(args,run) {
 const result=run('/usr/bin/codesign',args,{encoding:'utf8'})
 if(result.error||result.status!==0)throw new Error(`Signature operation failed: ${args.at(-1)}\n${result.stderr||result.error||''}`)
}
/** Internal ad-hoc builds only: repair unsigned/invalid native resources BEFORE the outer App is sealed. */
export function signAdHocResources(resources,run=spawnSync) {
 const files=machOFiles(resources);let signed=0
 for(const file of files){
  const verified=run('/usr/bin/codesign',['--verify','--strict',file],{encoding:'utf8'})
  if(verified.error)throw verified.error
  if(verified.status===0)continue
  codesign(['--force','--sign','-',file],run);codesign(['--verify','--strict',file],run);signed++
 }
 return {nativeFiles:files.length,repaired:signed}
}
export function verifyMacApp(app,run=spawnSync) {
 codesign(['--verify','--deep','--strict','--verbose=2',app],run)
 const files=machOFiles(app);if(!files.length)throw new Error('No native executable found')
 for(const file of files)codesign(['--verify','--strict','--verbose=2',file],run)
 const gatekeeper=run('/usr/sbin/spctl',['--assess','--type','execute','--verbose=4',app],{encoding:'utf8'})
 return {status:'PASS',scope:'code signatures, not notarization or native launch',nativeFiles:files.length,gatekeeper:{status:gatekeeper.status===0?'PASS':'BLOCKED-EXTERNAL',detail:String(gatekeeper.stderr||gatekeeper.error||'').trim()}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.platform!=='darwin')throw new Error('BLOCKED-ENVIRONMENT: macOS signature tools required')
 console.log(JSON.stringify(verifyMacApp(resolve(process.argv[2])),null,2))
}
