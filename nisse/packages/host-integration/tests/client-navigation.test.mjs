import {test} from 'node:test'
import assert from 'node:assert/strict'
import {apply} from '../lib/client.js'
test('pet selection uses official workspace navigation and unregisters at teardown',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'dshDesktop'),opened=[]
 let listener,cleanup
 try{
  globalThis.dshDesktop={onPetSession(fn){listener=fn;return()=>{listener=undefined}}}
  apply({uiWorkspace:{openSession:id=>opened.push(id)},effect:fn=>{cleanup=fn()}})
  listener('the-bot-session');assert.deepEqual(opened,['the-bot-session']);cleanup();assert.equal(listener,undefined)
 }finally{if(previous)Object.defineProperty(globalThis,'dshDesktop',previous);else delete globalThis.dshDesktop}
})
test('ordinary Web clients do not acquire a desktop capability',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'dshDesktop')
 try{delete globalThis.dshDesktop;apply({effect(){throw new Error('unexpected desktop listener')}})}finally{if(previous)Object.defineProperty(globalThis,'dshDesktop',previous)}
})
