/** Explicit recovery submits a new user instruction; it never replays tools itself. */
import {randomUUID} from 'node:crypto'
export const RECOVERY_WARNING = '上次操作可能已经产生副作用。继续会先核对已完成内容；重新提交可能重复操作。请确认后再执行。'
const TERMINALS = new Set(['error','failed','aborted','interrupted','blocked','max-tokens'])
const failure = (message, status = 409) => Object.assign(new Error(message), {status})
export function latestRecoverableTask(events) {
 let task = null
 for(const event of events){
  if(event.type==='turn/start')task={turn:event.data.turn,message:null,terminal:null}
  if(event.type==='user/message'&&task&&event.data?.source?.kind==='user')task.message=event.data
  if(event.type==='turn/end'&&task&&event.data.turn===task.turn)task.terminal=event.data.reason?.kind
 }
 if(!task?.message||!TERMINALS.has(task.terminal))throw failure('No interrupted task available')
 const content=task.message.content
 if(!Array.isArray(content)||content.some(part=>part.type!=='text'))throw failure('Open the main window to recover non-text input')
 const text=content.map(part=>part.text).join('\n').trim()
 if(!text||text.length>20000)throw failure('Original instruction cannot be safely shown; use the main window')
 return {turn:task.turn,terminal:task.terminal,text}
}
export function createTaskRecovery({load,isCurrent,execute,now=Date.now,ttlMs=60000}){
 const previews=new Map()
 const prune=()=>{for(const [id,item]of previews)if(item.expiresAt<=now())previews.delete(id)}
 return {
  async preview(){
   const snapshot=await load()
   if(snapshot.status!=='idle'||snapshot.pending)throw failure('Task is still active')
   const task=latestRecoverableTask(snapshot.events)
   if(!isCurrent(snapshot))throw failure('Task changed while reading')
   prune();if(previews.size>=8)previews.delete(previews.keys().next().value)
   const token=randomUUID(),expiresAt=now()+ttlMs;previews.set(token,{snapshot,task,expiresAt})
   return {token,sessionId:snapshot.sessionId,turn:task.turn,terminal:task.terminal,originalText:task.text,warning:RECOVERY_WARNING,expiresAt}
  },
  async submit(body){
   const {token,mode,confirmSideEffects}=body&&typeof body==='object'?body:{}
   if(!['continue','retry'].includes(mode)||confirmSideEffects!==true)throw failure('Choose a recovery mode and confirm side effects',400)
   prune();const preview=previews.get(token)
   if(!preview)throw failure('Recovery request expired or already used')
   if(!isCurrent(preview.snapshot)){previews.delete(token);throw failure('Task changed; inspect it again')}
   previews.delete(token)
   const text=mode==='retry'?preview.task.text:'请先核对上一轮任务已完成的工作和工具副作用，不重复已经完成的操作，只继续未完成部分。若无法确认，请先询问我。原目标：\n'+preview.task.text
   return execute(text,preview.snapshot,mode)
  },
  clear(){previews.clear()},
 }
}
