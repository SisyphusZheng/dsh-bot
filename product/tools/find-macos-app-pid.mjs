/** Attribute normal launches by unique user-data path, including App Translocation. */
import {spawnSync} from 'node:child_process'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
export function matchingPids(table,userData){
 const marker='--user-data-dir='+userData
 return table.split('\n').flatMap(line=>{
  const match=line.trim().match(/^(\d+)\s+(.+)$/);if(!match)return []
  const command=match[2],index=command.indexOf(marker),tail=command.slice(index+marker.length)
  return index>=0&&(index===0||/\s/.test(command[index-1]))&&(!tail||/\s/.test(tail[0]))&&/\/Contents\/MacOS\/dsh-bot(?:\s|$)/.test(command)&&!/--type(?:=|\s)/.test(command)?[Number(match[1])]:[]
 })
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const table=spawnSync('/bin/ps',['-axo','pid=,command='],{encoding:'utf8'});if(table.error||table.status!==0)throw new Error('Cannot inspect launch')
 const ids=matchingPids(table.stdout,process.argv[2]).filter(pid=>{const r=spawnSync('/bin/ps',['-p',String(pid),'-o','comm='],{encoding:'utf8'});return r.status===0&&/\/Contents\/MacOS\/dsh-bot$/.test(r.stdout.trim())})
 if(ids.length>1)throw new Error('Ambiguous App ownership');if(ids.length===1)console.log(ids[0])
}
