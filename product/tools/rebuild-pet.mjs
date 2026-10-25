/** Overlay the repository's product pet sources onto the pinned native dependency bundle. */
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const require=createRequire(new URL('../../apps/desktop/package.json',import.meta.url))
const asar=createRequire(require.resolve('app-builder-lib'))('@electron/asar')
const app=resolve(process.argv[2]),archive=join(app,'Contents/Resources/app.asar'),temp=mkdtempSync(join(tmpdir(),'dsh-pet-'))
try {
  asar.extractAll(archive,temp)
  const manifest=JSON.parse(readFileSync(join(temp,'package.json'))),entry=resolve(temp,manifest.main)
  if(!entry.startsWith(temp+'/'))throw new Error('invalid pet entry')
  const source=resolve(import.meta.dirname,'../pet/src'),destination=dirname(entry)
  cpSync(source,destination,{recursive:true})
  const validate=dir=>{for(const name of readdirSync(dir,{withFileTypes:true})){const path=join(dir,name.name);if(name.isDirectory())validate(path);else if(/\.(mjs|js|cjs)$/.test(path)){const text=readFileSync(path,'utf8');for(const m of text.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"](\.[^'"]+)['"]/g)){if(!existsSync(resolve(dirname(path),m[1])))throw new Error(`pet import missing: ${path} -> ${m[1]}`)}}}}
  validate(destination)
  await asar.createPackageWithOptions(temp,archive,{unpackDir:'node_modules'})
  if(process.platform==='darwin'){
    const hash=createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex')
    const integrity={'Resources/app.asar':{algorithm:'SHA256',hash}}
    execFileSync('/usr/bin/plutil',['-replace','ElectronAsarIntegrity','-json',JSON.stringify(integrity),join(app,'Contents/Info.plist')])
  }
  console.log('PASS pet source overlay, relative-import closure and ASAR rebuild')
}finally{rmSync(temp,{recursive:true,force:true})}
