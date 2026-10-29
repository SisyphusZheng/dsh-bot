/** Native notifications contain no command arguments, private paths or answers. */
export function createInteractionAttention({enabled=()=>true,show,open}) {
 const seen=new Set(), active=new Map()
 return {
  sync(snapshot){
   const requests=snapshot.requests||[],keys=new Set(requests.map(r=>`${snapshot.pid}:${r.sessionId}:${r.id}`))
   for(const [key,notice] of active)if(!keys.has(key)||!enabled()){notice.close();active.delete(key)}
   const request=requests[0];if(!request||!enabled())return
   const key=`${snapshot.pid}:${request.sessionId}:${request.id}`
   if(seen.has(key))return
   try{
    const notice=show({title:request.kind==='approval'?'Nisse 需要你的批准':'Nisse 在等你回答',body:'请查看桌宠气泡；也可以打开主窗口处理。',click:()=>{if(active.has(key))open()}})
    if(!notice)return
    active.set(key,notice);seen.add(key);if(seen.size>128)seen.delete(seen.values().next().value)
   }catch{/* Unsupported/denied system notifications never affect Agent work. */}
  },
  stop(){for(const notice of active.values())notice.close();active.clear()},
 }
}
