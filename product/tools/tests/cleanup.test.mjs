import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,existsSync,rmSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
test('cleanup previews first and removes only the reviewed app copy while retaining data and logs',()=>{
 const root=mkdtempSync(join(tmpdir(),'pet-clean-')),tools=join(root,'product/tools'),run=join(root,'.mvv-build/acceptance-123')
 try{
  mkdirSync(tools,{recursive:true});copyFileSync(new URL('../clean-builds.mjs',import.meta.url),join(tools,'clean-builds.mjs'))
  mkdirSync(join(run,'dsh-bot.app'),{recursive:true});writeFileSync(join(run,'dsh-bot.app/binary'),'app')
  mkdirSync(join(run,'user-data/dsh-home/memory'),{recursive:true});writeFileSync(join(run,'user-data/dsh-home/memory/database'),'personal memory');writeFileSync(join(run,'acceptance.log'),'evidence')
  const call=args=>spawnSync(process.execPath,[join(tools,'clean-builds.mjs'),...args],{encoding:'utf8'})
  assert.equal(call([]).status,0);assert.equal(existsSync(join(run,'dsh-bot.app')),true)
  assert.notEqual(call(['../outside','--apply']).status,0)
  assert.equal(call(['acceptance-123','--apply']).status,0)
  assert.equal(existsSync(join(run,'dsh-bot.app')),false);assert.equal(readFileSync(join(run,'user-data/dsh-home/memory/database'),'utf8'),'personal memory');assert.equal(readFileSync(join(run,'acceptance.log'),'utf8'),'evidence')
  symlinkSync(root,join(run,'dsh-bot.app'),'dir');assert.notEqual(call(['acceptance-123','--apply']).status,0)
 }finally{rmSync(root,{recursive:true,force:true})}
})
