/** Closed question vocabulary; no fuzzy labels or inferred intent. */
export function questionVoiceAction(text, question) {
  const raw=String(text||'').trim(), compact=raw.replace(/[，。！？、,!?\s]/g,'')
  if (/^(提交选择|提交答案|确认选择)$/.test(compact)) return {type:'secondary',id:'submit'}
  if (/^(跳过这题|跳过此题)$/.test(compact)) return {type:'secondary',id:'skip'}
  const custom=raw.match(/^(?:其他回答|我的回答是)[：:\s]*(.+)$/s)
  if(custom?.[1]?.trim())return {type:'input',value:custom[1].trim()}
  const options=question.options||[]
  const labels=options.map((o,i)=>({label:o.label.replace(/\s/g,''),i})).filter(o=>o.label===compact||`选${o.label}`===compact||`选择${o.label}`===compact)
  if(labels.length===1)return {type:'choice',id:String(labels[0].i)}
  const body=compact.replace(/^(?:嗯|啊|好|好的)?(?:就)?(?:选择|选)?/,'').replace(/(?:选项)?(?:吧|谢谢)?$/,'')
  if(body==='最后一个'||body==='最后一项')return options.length?{type:'choice',id:String(options.length-1)}:null
  const ordinal=body.match(/^第?([一二两三四五六七八九十]|[1-9][0-9]?)(?:个|项)?$/)
  const number=ordinal ? ({一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10}[ordinal[1]]??Number(ordinal[1])) : 0
  return number>0&&number<=options.length?{type:'choice',id:String(number-1)}:null
}
