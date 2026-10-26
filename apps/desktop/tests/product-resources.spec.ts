import { it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
it('packages the runtime, adapter and foreground wrapper under one memory contract', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'mvp-resources-'))
  try {
    for(const p of ['pet','voice','memory/runtime/hindsight','memory/runtime/models','memory/runtime/pg0','memory/adapter/m1-c-hindsight','memory/scripts'])mkdirSync(join(dir,p),{ recursive:true })
    for(const p of ['inject-bundle.js','memory/sidecar.mjs','memory/VERSION.json'])writeFileSync(join(dir,p),'')
    vi.stubEnv('NISSE_VOICE_WORKER_DIR',join(dir,'voice'));vi.stubEnv('NISSE_MEMORY_DIR',join(dir,'memory'))
    vi.stubEnv('DSH_DESKTOP_BUILD_COMMIT','a'.repeat(40));vi.stubEnv('DSH_DESKTOP_BUILD_DIRTY','0');vi.stubEnv('DSH_DESKTOP_APP_ID','ai.dshbot.app');vi.stubEnv('DSH_DESKTOP_UNSIGNED','1');vi.stubEnv('DSH_DESKTOP_TARGET_PLATFORM','darwin')
    const { createElectronBuilderConfig }=await import('../electron-builder.config.mjs')
    const config=createElectronBuilderConfig({ ...process.env,DSH_DESKTOP_UNSIGNED:'1' },'darwin','arm64')
    expect(config.artifactName).toBe('dsh-bot-${version}-aaaaaaaa-${os}-${arch}-unsigned.${ext}')
    expect(config.extraMetadata).toMatchObject({ dshBuildCommit:'a'.repeat(40),dshBuildDirty:false })
    const paths=config.extraResources.map(x=>x.to)
    expect(paths).toEqual(expect.arrayContaining(['memory/runtime/hindsight','memory/runtime/models','memory/runtime/pg0','memory/scripts','memory/adapter/m1-c-hindsight','memory/sidecar.mjs','host-integration']))
    expect(paths).toContain('pet');expect(paths).not.toContain('pet/NissePet.app');expect(paths).not.toContain('voice-client/inject-bundle.js');expect(paths).not.toContain('whalegirl-g2-bridge');expect(config.mac.extendInfo.CFBundleLocalizations).toContain('zh_CN');expect(config.mac.hardenedRuntime).toBe(false)
  }finally{vi.unstubAllEnvs();rmSync(dir,{ recursive:true,force:true })}
})
