import {test} from 'node:test'
import assert from 'node:assert/strict'
import {apply} from '../src/client/index.js'
test('pet selection uses official workspace navigation and unregisters at teardown',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'dshDesktop'),opened=[]
 let listener,cleanup
 try{
  globalThis.dshDesktop={onPetSession(fn){listener=fn;return()=>{listener=undefined}}}
  apply({sessions:{list:{getSnapshot:()=>({phase:'ready',byId:{'the-bot-session':{}}}),subscribe:()=>()=>{}}},uiWorkspace:{openSession:id=>opened.push(id)},effect:fn=>{cleanup=fn()}})
  listener('the-bot-session');assert.deepEqual(opened,['the-bot-session']);cleanup();assert.equal(listener,undefined)
 }finally{if(previous)Object.defineProperty(globalThis,'dshDesktop',previous);else delete globalThis.dshDesktop}
})
test('buffered cold-start navigation waits for the official Session snapshot and keeps the latest request',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'dshDesktop'),opened=[]
 let update,listener,cleanup,stopped=false,snapshot={phase:'pending',byId:{}}
 try{
  globalThis.dshDesktop={onPetSession(fn){listener=fn;fn('first');return()=>{listener=undefined}}}
  apply({sessions:{list:{getSnapshot:()=>snapshot,subscribe:fn=>{update=fn;return()=>{stopped=true}}}},uiWorkspace:{openSession:id=>opened.push(id)},effect:fn=>{cleanup=fn()}})
  assert.deepEqual(opened,[])
  listener('latest');snapshot={phase:'ready',byId:{first:{}}};update();assert.deepEqual(opened,[])
  snapshot={phase:'ready',byId:{first:{},latest:{}}};update();assert.deepEqual(opened,['latest'])
  update();assert.deepEqual(opened,['latest']);cleanup();assert.equal(stopped,true);assert.equal(listener,undefined)
 }finally{if(previous)Object.defineProperty(globalThis,'dshDesktop',previous);else delete globalThis.dshDesktop}
})
test('ordinary Web clients do not acquire a desktop capability',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'dshDesktop')
 try{delete globalThis.dshDesktop;apply({effect(){throw new Error('unexpected desktop listener')}})}finally{if(previous)Object.defineProperty(globalThis,'dshDesktop',previous)}
})
