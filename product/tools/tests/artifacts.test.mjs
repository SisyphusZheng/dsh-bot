import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {resolve,join} from 'node:path'
import {createRequire} from 'node:module'
import {spawnSync,execFileSync} from 'node:child_process'
const root=resolve(import.meta.dirname,'../../..'),desktop=createRequire(join(root,'apps/desktop/package.json'))
const {createPackage}=createRequire(desktop.resolve('app-builder-lib/package.json'))('@electron/asar')
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()
const call=args=>spawnSync(process.execPath,[join(root,'product/tools/macos-artifacts.mjs'),...args],{encoding:'utf8'})
test('recorded artifact bytes must match; same-name replacement and wrong source are rejected',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pet-artifact-')),artifact=join(dir,`dsh-bot-${commit.slice(0,8)}-fixture.dmg`),manifest=join(dir,'build.json')
 try{
  writeFileSync(artifact,'explicit hash fixture, not a DMG')
  assert.equal(call(['record',artifact,manifest]).status,0)
  assert.equal(call(['verify',artifact,manifest]).status,0)
  writeFileSync(artifact,'different bytes, same filename');assert.notEqual(call(['verify',artifact,manifest]).status,0)
  const record=JSON.parse(readFileSync(manifest));record.sourceCommit='0'.repeat(40);writeFileSync(manifest,JSON.stringify(record));assert.notEqual(call(['verify',artifact,manifest]).status,0)
 }finally{rmSync(dir,{recursive:true,force:true})}
})
test('actual ASAR metadata identifies a clean candidate and rejects a dirty or old app',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pet-asar-')),source=join(dir,'source'),app=join(dir,'fixture.app'),resources=join(app,'Contents/Resources')
 try{
  mkdirSync(source);mkdirSync(resources,{recursive:true})
  const plugin=join(resources,'host-integration');mkdirSync(join(plugin,'lib'),{recursive:true})
  writeFileSync(join(plugin,'package.json'),JSON.stringify({name:'nisse-host-integration',exports:{'./client':'./lib/client.js'}}))
  const classic='window.__ModuleLoader__.load({id:"nisse-host-integration",factory:()=>({inject:["uiWorkspace"],apply(){}})})'
  writeFileSync(join(plugin,'lib/client.js'),classic)
  for(const [sha,dirty,valid] of [[commit,false,true],[commit,true,false],['0'.repeat(40),false,false]]){
   writeFileSync(join(source,'package.json'),JSON.stringify({name:'explicit-fixture',dshBuildCommit:sha,dshBuildDirty:dirty}))
   await createPackage(source,join(resources,'app.asar'))
   const result=call(['app',app]);assert.equal(result.status===0,valid,result.stderr)
  }
  writeFileSync(join(source,'package.json'),JSON.stringify({name:'explicit-fixture',dshBuildCommit:commit,dshBuildDirty:false}))
  await createPackage(source,join(resources,'app.asar'))
  writeFileSync(join(plugin,'lib/client.js'),'export function apply() {}')
  const invalid=call(['app',app]);assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/Unexpected token 'export'/)
 }finally{rmSync(dir,{recursive:true,force:true})}
})
