import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createInteractionAttention} from '../src/desktop-attention.mjs'
test('system attention deduplicates requests, excludes private details, closes stale notices and respects opt-out',()=>{
 let enabled=true,opened=0;const shown=[]
 const attention=createInteractionAttention({enabled:()=>enabled,open:()=>opened++,show:value=>{const notice={...value,closed:false,close(){this.closed=true}};shown.push(notice);return notice}})
 const snapshot={pid:1,requests:[{id:'a',sessionId:'s',kind:'approval',operation:{command:'PRIVATE'}}]}
 attention.sync(snapshot);attention.sync(snapshot);assert.equal(shown.length,1);assert.ok(!JSON.stringify(shown).includes('PRIVATE'))
 shown[0].click();assert.equal(opened,1)
 attention.sync({...snapshot,requests:[]});assert.equal(shown[0].closed,true);shown[0].click();assert.equal(opened,1)
 enabled=false;attention.sync({pid:2,requests:snapshot.requests});assert.equal(shown.length,1)
 enabled=true;attention.sync({pid:2,requests:snapshot.requests});assert.equal(shown.length,2)
 attention.stop();assert.equal(shown[1].closed,true)
})
test('unsupported notifications never acknowledge or cancel Agent requests',()=>{const attention=createInteractionAttention({show:()=>null,open:()=>assert.fail('unexpected open')});attention.sync({pid:1,requests:[{id:'q',sessionId:'s',kind:'question'}]});attention.stop()})
