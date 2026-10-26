from PyInstaller.utils.hooks import collect_all, copy_metadata
names = ['hindsight_api', 'pg0', 'onnxruntime', 'tokenizers', 'tiktoken']
datas, binaries, hiddenimports = [], [], []
for name in names:
    data, binary, hidden = collect_all(name)
    datas += data
    binaries += binary
    hiddenimports += hidden
datas += copy_metadata('hindsight-api-slim')
a = Analysis(['hindsight-entry.py'], pathex=['.'], binaries=binaries, datas=datas,
             hiddenimports=hiddenimports + ['asyncpg.pgproto.pgproto'], excludes=[], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='HindsightAPI', console=True,
          strip=False, upx=False, target_arch=None, codesign_identity=None, entitlements_file=None)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='HindsightAPI')
