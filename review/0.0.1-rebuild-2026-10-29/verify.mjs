/** Verify recorded bytes and frozen source identity; does not rerun tests. */
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {gunzipSync} from 'node:zlib'
import {execFileSync} from 'node:child_process'
import {resolve,relative} from 'node:path'
import assert from 'node:assert/strict'
const dir=import.meta.dirname,root=resolve(dir,'../..'),prefix=relative(root,dir)+'/'
const read=name=>JSON.parse(readFileSync(resolve(dir,name),'utf8'))
const sha=data=>createHash('sha256').update(data).digest('hex')
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim()
const result=read('RESULTS.json'),versions=read('VERSIONS.json')
assert.equal(git('rev-parse',result.sourceCommit+'^{tree}'),result.sourceTree)
assert.equal(versions.sourceCommit,result.sourceCommit);assert.equal(versions.sourceTree,result.sourceTree)
assert.equal(git('rev-parse',versions.voiceWorker.buildHeadAtStart+':product/voice-worker-src'),versions.voiceWorker.identicalWorkerSourceTreeAtBuildAndFreeze)
assert.equal(git('rev-parse',result.sourceCommit+':product/voice-worker-src'),versions.voiceWorker.identicalWorkerSourceTreeAtBuildAndFreeze)
for(const path of git('diff','--name-only',result.sourceCommit,'HEAD').split('\n').filter(Boolean))assert.ok(path.startsWith(prefix),'Production source changed: '+path)
for(const path of git('diff','--name-only','HEAD').split('\n').filter(Boolean))assert.ok(path.startsWith(prefix),'Uncommitted production change: '+path)
for(const check of result.checks){const raw=gunzipSync(readFileSync(resolve(dir,check.log)));assert.equal(raw.length,check.rawBytes,check.log);assert.equal(sha(raw),check.rawSha256,check.log)}
for(const input of versions.inputHashes)assert.equal(sha(readFileSync(resolve(root,input.path))),input.sha256,input.path)
const files=gunzipSync(readFileSync(resolve(dir,'evidence/linux-worker-files.json.gz')))
assert.equal(sha(files),versions.voiceWorker.fileManifestRawSha256)
const manifest=JSON.parse(files);assert.equal(manifest.length,versions.voiceWorker.files)
assert.equal(manifest.find(file=>file.path==='VoiceWorker').sha256,versions.voiceWorker.entrySha256)
assert.equal(manifest.reduce((bytes,file)=>bytes+(file.bytes||0),0),versions.voiceWorker.totalBytes)
console.log(`PASS frozen source ${result.sourceCommit}; ${result.checks.length} raw logs and input/artifact manifests. Recorded FAIL/BLOCKED/DEFERRED results remain unchanged. No tests or native acceptance rerun.`)
