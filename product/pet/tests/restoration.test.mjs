import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, copyFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { reduceOnboarding, emptyProgress, configEditFromProgress, seedFromConfig } from '../src/onboarding.mjs'
import { readLegacyPet } from '../src/legacy-preferences.mjs'
import { createExperienceStore } from '../src/experience-store.mjs'
import { validateSkinPackage, importSkin, skinAssetPath, effectiveOrbSkin } from '../src/skin-store.mjs'
import { createTaskCards } from '../src/task-cards.mjs'
test('retry emits real probes and full edits retain canonical approval/config fields',()=>{
 let p=seedFromConfig(emptyProgress(),{llm:{provider:'custom',model:'existing',baseUrl:'https://example.test'},approval:{mode:'ask-before-acting'},behavior:{allowScreenView:false}});p={...p,stepId:'llm_key',substate:'failed'}
 assert.deepEqual(reduceOnboarding(p,{type:'choice',id:'retry'}).effects,[{type:'test-llm'}]);const e=configEditFromProgress(p,{persona:{promptOverride:'keep',name:'pet'}})
 assert.ok(reduceOnboarding({...p,stepId:'done'},{type:'choice',id:'open-settings'}).effects.some(x=>x.type==='open-dsh-settings'))
 assert.equal(e.persona.promptOverride,'keep');assert.equal(e.llm.model,'existing');assert.equal(e.approval.mode,'ask-before-acting');assert.equal(e.behavior.allowScreenView,false)
 assert.deepEqual(reduceOnboarding({...p,stepId:'voice_wake'},{type:'choice',id:'retry'}).effects,[{type:'test-voice'}]);assert.equal(reduceOnboarding({...p,stepId:'voice_wake',answers:{...p.answers,voice:{provider:'local'}}},{type:'test-result',target:'voice',result:{ok:false,error:'LOCAL_PROVIDER'}}).state.substate,'failed')
})
test('legacy prefs and position migrate without credentials or original-file mutation',()=>{
 const root=mkdtempSync(join(tmpdir(),'pet-legacy-')),dest=join(root,'new');mkdirSync(dest)
 try{const env='QWEN_AUDIO_DESKTOP_LANGUAGE=en\nQWEN_AUDIO_ORB_SKIN=whale-girl\nQWEN_AUDIO_WAKE_WORD_ENABLED=true\nQWEN_AUDIO_WAKE_WORD_PHRASE=你好小鲸\nDASHSCOPE_API_KEY=private-fixture\n';writeFileSync(join(root,'settings.env'),env);writeFileSync(join(root,'ui-state.json'),JSON.stringify({orbPosition:{x:100,y:200}}));writeFileSync(join(root,'pet-experience.json'),JSON.stringify({voiceInput:{mode:'always'}}))
 const migrated=readLegacyPet(root,dest),store=createExperienceStore({directory:dest});store.save(migrated);assert.equal(migrated.localConfig.language,'en');assert.equal(migrated.localConfig.wakeWordEnabled,true);assert.equal(migrated.voiceInput.mode,'always');assert.equal(JSON.parse(readFileSync(join(dest,'position.json'),'utf8')).x,100);assert.equal(readFileSync(join(root,'settings.env'),'utf8'),env);assert.ok(!readFileSync(store.path,'utf8').includes('private-fixture'))
 store.saveOnboarding({answers:{voice:{apiKey:'secret'},llm:{apiKey:'secret'}}});assert.ok(!readFileSync(store.path,'utf8').includes('secret'));writeFileSync(store.path,'broken');assert.throws(()=>store.save({localConfig:{}}));assert.equal(readFileSync(store.path,'utf8'),'broken')
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('skin packages allow nested declared assets and reject escapes and symlinks',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pet-skin-')),source=join(root,'skin'),skinsRoot=join(root,'skins');mkdirSync(join(source,'images'),{recursive:true})
 try{const original=resolve('apps/desktop/resources/whale-girl'),m=JSON.parse(readFileSync(join(original,'pet.json'),'utf8'));m.id='my-pet';m.spritesheetPath='images/sheet.webp';writeFileSync(join(source,'pet.json'),JSON.stringify(m));copyFileSync(join(original,'spritesheet.webp'),join(source,'images/sheet.webp'));assert.equal(validateSkinPackage(source).id,'my-pet');await importSkin({source,skinsRoot});assert.equal(effectiveOrbSkin('my-pet',{skinsRoot}),'my-pet');assert.equal(skinAssetPath('my-pet','images/sheet.webp',skinsRoot),join(skinsRoot,'my-pet/images/sheet.webp'));assert.throws(()=>skinAssetPath('my-pet','../../private',skinsRoot));assert.equal(effectiveOrbSkin('../../private',{skinsRoot}),'whale-girl');rmSync(join(source,'images/sheet.webp'));symlinkSync(join(original,'spritesheet.webp'),join(source,'images/sheet.webp'));assert.throws(()=>validateSkinPackage(source),/符号链接/)
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('cards derive real turn identity, preserve completion and reset on Host replacement',()=>{
 let cards;const p=createTaskCards(v=>cards=v);p.event({ioSeq:1,type:'turn.accepted',data:{messageId:'m1'}});assert.equal(cards[0].state,'queued');p.event({ioSeq:2,type:'turn.started',turnId:'s:1'});p.event({type:'user.message',turnId:'s:1',data:{text:'整理文件'}});p.event({type:'tool.call',turnId:'s:1',data:{toolName:'read'}});assert.equal(cards[0].text,'整理文件');assert.equal(cards[0].tool,'read');p.event({type:'turn.ended',turnId:'s:1',data:{reason:{kind:'completed'}}});assert.equal(cards[0].state,'completed');p.event({type:'runtime.owner'});assert.deepEqual(cards,[])
})
