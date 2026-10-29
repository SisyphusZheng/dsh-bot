/** Validate the frozen source and raw evidence without relabeling acceptance. */
import{readFileSync}from'node:fs'
import{gunzipSync}from'node:zlib'
import{createHash}from'node:crypto'
import{execFileSync}from'node:child_process'
import{resolve,relative}from'node:path'
import assert from'node:assert/strict'
const dir=import.meta.dirname,root=resolve(dir,'../..'),prefix=relative(root,dir)+'/'
const read=p=>JSON.parse(readFileSync(resolve(dir,p),'utf8'))
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim()
const sha=data=>createHash('sha256').update(data).digest('hex')
const result=read('RESULTS.json'),versions=read('VERSIONS.json'),checkpoint=read('CHECKPOINT.json')
assert.equal(git('rev-parse',result.sourceCommit+'^{tree}'),result.sourceTree)
assert.equal(versions.sourceCommit,result.sourceCommit);assert.equal(versions.sourceTree,result.sourceTree)
for(const path of git('diff','--name-only',result.sourceCommit,'HEAD').split('\n').filter(Boolean))assert.ok(path.startsWith(prefix),'Changed production source: '+path)
for(const path of git('diff','--name-only','HEAD').split('\n').filter(Boolean))assert.ok(path.startsWith(prefix),'Uncommitted production source: '+path)
for(const check of [...result.checks,...checkpoint.checks,...checkpoint.packagingAndDocsChecks]){
 const raw=gunzipSync(readFileSync(resolve(dir,check.path)));assert.equal(raw.length,check.rawBytes,check.path);assert.equal(sha(raw),check.rawSha256,check.path)
}
for(const input of versions.inputs)assert.equal(sha(readFileSync(resolve(root,input.path))),input.sha256,input.path)
assert.equal(git('rev-parse',result.sourceCommit+':product/voice-worker-src'),versions.workerSourceTree)
console.log(`PASS frozen source ${result.sourceCommit}, input hashes and raw log integrity. Native/Provider blockers and full-corpus translation debt remain recorded; no test rerun.`)
