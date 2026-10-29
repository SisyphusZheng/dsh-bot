import {test} from 'node:test'
import assert from 'node:assert/strict'
import {questionVoiceAction as parse} from '../src/question-voice.mjs'
const q={options:[{label:'拿铁'},{label:'美式'},{label:'茶'}]}
test('closed ordinal and unique label grammar supports normal Chinese but rejects guesses',()=>{
 for(const [text,id] of [['第一个选项','0'],['选择第2项','1'],['嗯，就选最后一个选项吧。','2'],['选茶','2']])assert.deepEqual(parse(text,q),{type:'choice',id})
 for(const text of ['第四个','大概那个','选美','啊听一下','第一和最后一个'])assert.equal(parse(text,q),null)
 assert.equal(parse('选茶',{options:[{label:'茶'},{label:'茶'}]}),null)
 assert.deepEqual(parse('其他回答：温水',q),{type:'input',value:'温水'})
})
