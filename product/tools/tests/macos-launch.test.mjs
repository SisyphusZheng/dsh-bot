import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {machOFiles,verifyMacApp,signAdHocResources} from '../verify-macos-app.mjs'
import {matchingPids} from '../find-macos-app-pid.mjs'
test('normal launch ownership handles Translocation/spaces and excludes helpers and profile collisions',()=>{
 const profile='/tmp/acceptance one/user-data',bin='/private/AppTranslocation/uuid/d/dsh bot.app/Contents/MacOS/dsh-bot'
 const rows=[`11 ${bin} --user-data-dir=${profile} --remote-debugging-port=0`,`12 ${bin} --type=renderer --user-data-dir=${profile}`,`13 ${bin} --user-data-dir=${profile}-other`,`14 ${bin} --user-data-dir=/old`].join('\n')
 assert.deepEqual(matchingPids(rows,profile),[11]);assert.deepEqual(matchingPids(rows+'\n15 '+bin+' --user-data-dir='+profile,profile),[11,15])
})
test('invalid inner code fails verification, is repaired before sealing, and valid signatures are retained',t=>{
 const root=mkdtempSync(join(tmpdir(),'signature-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'Resources'))
 const binary=join(root,'Resources','worker');writeFileSync(binary,Buffer.from('cffaedfe00000000','hex'));writeFileSync(join(root,'readme'),'text');writeFileSync(join(root,'Java.class'),Buffer.from('cafebabe0000003d','hex'))
 assert.deepEqual(machOFiles(root),[binary]);const calls=[]
 assert.throws(()=>verifyMacApp(root,(command,args)=>{calls.push([command,args]);return {status:args.at(-1)===binary?1:0,stderr:'inner invalid'}}),/inner invalid/);assert.equal(calls.length,2)
 let signed=false;const repair=[]
 const first=signAdHocResources(root,(_command,args)=>{repair.push(args);if(args.includes('--sign'))signed=true;return {status:signed?0:1}})
 assert.equal(first.repaired,1);assert.equal(repair.length,3);assert.deepEqual(repair[1],['--force','--sign','-',binary])
 assert.equal(signAdHocResources(root,()=>({status:0})).repaired,0)
 assert.throws(()=>signAdHocResources(root,()=>({status:1,stderr:'sign rejected'})),/sign rejected/)
 const good=verifyMacApp(root,(command)=>({status:command.endsWith('spctl')?1:0,stderr:'unsigned beta'}));assert.equal(good.status,'PASS');assert.equal(good.gatekeeper.status,'BLOCKED-EXTERNAL')
})
