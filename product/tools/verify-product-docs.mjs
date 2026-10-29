/** Product documentation checks; the full upstream website corpus is a separate check. */
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
const root=resolve(import.meta.dirname,'../..')
function check(label,script,args=[],referenceOnly=false){
 const env={...process.env}
 // Help reference generation is a network-free fixture. Do not let a shell SOCKS
 // diagnostic change its recorded text. Application and Provider policies stay intact.
 if(referenceOnly){delete env.ALL_PROXY;delete env.all_proxy}
 try{
  const output=execFileSync(process.execPath,['--import','tsx/esm',script,...args],{cwd:root,env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024})
  process.stdout.write(output);console.log('PASS '+label)
 }catch(error){if(error.stdout)process.stdout.write(error.stdout);if(error.stderr)process.stderr.write(error.stderr);throw new Error(label+' failed',{cause:error})}
}
check('maintained product bilingual documents','scripts/verify-translation-pairing.ts',['docs/roadmap/CHIEF-0.0.1.md','nisse/packages/host-integration/README.md','product/pet/README.md'])
check('client catalog freshness','scripts/gen-client-catalog.ts',['--check'])
check('CLI help reference in isolated process','scripts/gen-cli-help.ts',['--check'],true)
check('repository Markdown links','scripts/verify-md-links.ts')
console.log('PASS product documentation scope; no full-corpus translation or website-build claim')
