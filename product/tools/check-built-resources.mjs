/** Check compiled product resources without presenting this as native macOS acceptance. */
import {readFileSync,statSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {resolve,relative} from 'node:path'
import assert from 'node:assert/strict'
import { verifyHostClient } from './verify-host-client.mjs'
const root=resolve(import.meta.dirname,'../..'),main=readFileSync(resolve(root,'apps/desktop/lib/main.js'),'utf8')
for(const legacy of ['NissePet.app','qwen-audio-agent','WHALEGIRL_VOICE_PERSONA_MODULE'])assert.ok(!main.includes(legacy),`legacy runtime reference in main bundle: ${legacy}`)
const paths=['apps/desktop/lib/main.js','apps/desktop/lib/preload-app.cjs','apps/desktop/resources/pet/pet.html','apps/desktop/resources/pet/bubble.html','apps/desktop/resources/pet/bubble.css','apps/desktop/resources/pet/bubble.js','apps/desktop/resources/pet/bubble-preload.cjs','apps/desktop/resources/pet/companion-presentation.mjs','apps/desktop/resources/pet/bubble-window.mjs','apps/desktop/resources/pet/THIRD_PARTY_NOTICES.txt','apps/desktop/resources/pet/pet-preload.cjs','apps/desktop/resources/pet/voice-client.js','apps/desktop/resources/pet/voice-worker-runtime.mjs','apps/desktop/resources/pet/voice-worker-supervisor.mjs','apps/desktop/resources/whale-girl/spritesheet.webp','nisse/packages/host-integration/lib/client.js','nisse/packages/host-integration/lib/index.js','nisse/packages/host-integration/lib/interactions.mjs','nisse/packages/host-integration/lib/approval-policies.mjs','nisse/packages/host-integration/lib/task-recovery.mjs']
paths.push(...['bubble-markdown.js','experience-runtime.mjs','experience-store.mjs','legacy-preferences.mjs','voice-input.mjs','global-option.mjs','onboarding.mjs','desktop-presence.mjs','i18n.mjs','skin-store.mjs','skin-catalog.mjs','wake-word/runtime.mjs','wake-word/worker.mjs','wake-word/keyword-phrase.mjs','wake-model/MODEL.json'].map(name=>'apps/desktop/resources/pet/'+name))
for(const dependency of ['koffi','sherpa-onnx-node','extract-zip'])assert.ok(createRequire(resolve(root,'apps/desktop/package.json')).resolve(dependency))
const files=paths.map(path=>{const bytes=readFileSync(resolve(root,path));assert.ok(bytes.length>0,path);return {path,bytes:statSync(resolve(root,path)).size,sha256:createHash('sha256').update(bytes).digest('hex')}})
assert.match(readFileSync(resolve(root,'apps/desktop/resources/pet/bubble-markdown.LICENSE.txt'),'utf8'), /mdast-util-from-markdown@/)
const entry=createRequire(resolve(root,'apps/cli/package.json')).resolve('@deepseek-ai/dsh-llm')
verifyHostClient(resolve(root,'nisse/packages/host-integration'))
assert.ok(statSync(entry).size>0)
console.log(JSON.stringify({status:'PASS',scope:'compiled cross-platform resources, not a DMG',llmEntry:relative(root,entry),files},null,2))
