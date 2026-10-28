import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApprovalPolicies, operationKey } from '../lib/approval-policies.mjs'
const op = { toolName: 'bash', cwd: '/work', arguments: { command: 'echo sensitive-fixture', timeout: 3 } }
test('grants persist hashes only, reload, match exactly and revoke', t => {
 const home=mkdtempSync(join(tmpdir(),'exact-grants-'));t.after(()=>rmSync(home,{recursive:true,force:true}));const file=join(home,'grants.json')
 const grants=createApprovalPolicies(file), rule=grants.grant(op)
 assert.equal(statSync(file).mode&0o777,0o600);assert.doesNotMatch(readFileSync(file,'utf8'),/sensitive-fixture|\/work/)
 assert.equal(operationKey(op),operationKey({...op,arguments:{timeout:3,command:op.arguments.command}}))
 const reload=createApprovalPolicies(file);assert.equal(reload.match(op).id,rule.id)
 for(const changed of [{...op,cwd:'/else'},{...op,toolName:'shell'},{...op,arguments:{...op.arguments,command:'different'}}])assert.equal(reload.match(changed),null)
 assert.equal(reload.revoke('unknown'),0);assert.equal(reload.revoke(rule.id),1);assert.equal(createApprovalPolicies(file).match(op),null)
})
test('corrupt grant files fail closed and are never silently overwritten', t=>{
 const home=mkdtempSync(join(tmpdir(),'corrupt-grants-'));t.after(()=>rmSync(home,{recursive:true,force:true}));const file=join(home,'grants.json')
 for(const text of ['{broken',JSON.stringify({version:2,rules:[]}),JSON.stringify({version:1,rules:[{id:'x',key:'bad'}]})]){
  writeFileSync(file,text);const grants=createApprovalPolicies(file);assert.equal(grants.match(op),null);assert.ok(grants.snapshot().error)
  assert.throws(()=>grants.grant(op));assert.throws(()=>grants.revoke('x'));assert.equal(readFileSync(file,'utf8'),text)
 }
})
test('missing parameters and non-JSON values cannot create an exact grant',()=>{
 for(const value of [{}, {...op,arguments:undefined}, {...op,arguments:{x:NaN}}])assert.throws(()=>operationKey(value))
})
