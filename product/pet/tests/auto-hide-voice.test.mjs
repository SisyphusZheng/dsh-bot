import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createPetExperience} from '../src/experience-runtime.mjs'

test('idle auto-hide yields to held gestures, handshake and recent release', async () => {
  const interval=globalThis.setInterval, clear=globalThis.clearInterval, dateNow=Date.now
  let tick, hidden=0, now=10000, e
  globalThis.setInterval=fn=>{tick=fn;return {unref(){}}}
  globalThis.clearInterval=()=>{}
  Date.now=()=>now
  try {
    e=createPetExperience({home:mkdtempSync(join(tmpdir(),'dsh-autohide-test-')),window:{isDestroyed:()=>false,isMinimized:()=>false,show(){},hide(){hidden++},focus(){},webContents:{send(){}}},emit(){},show(){},hide(){},request:async()=>({}),idle:()=>600,nativeRequire(){throw Error('no native')},shortcuts:{register:()=>true,unregister(){}}})
    e.update({autoHideSeconds:60})
    e.gesture('down');tick();assert.equal(hidden,0)
    e.gesture('up');e.voice({enabled:false,transportPhase:'connecting'});now+=4000;tick();assert.equal(hidden,0)
    e.voice({enabled:false,transportPhase:'off'});e.gesture('down');e.gesture('up');tick();assert.equal(hidden,0)
    now+=3001;tick();assert.equal(hidden,1)
  } finally {await e?.stop();Date.now=dateNow;globalThis.setInterval=interval;globalThis.clearInterval=clear}
})
