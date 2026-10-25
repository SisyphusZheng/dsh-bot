#!/usr/bin/env node
/** Generate VERSION.json for the staged memory packaging payload. */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { hostname } from 'node:os'

const ROOT = process.argv[2] || '/tmp/wg-memory-staging'
const fileSha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else if (entry.isFile()) out.push({ full, rel: relative(base, full), bytes: statSync(full).size })
  }
  return out
}

function component(name, path, sources) {
  const files = walk(path)
  const lines = []
  let bytes = 0
  for (const file of files.sort((a, b) => a.rel.localeCompare(b.rel))) {
    const digest = fileSha(file.full)
    bytes += file.bytes
    lines.push(`${file.rel}\t${file.bytes}\t${digest}`)
  }
  const treeSha = createHash('sha256').update(lines.join('\n')).digest('hex')
  return { name, path: relative(ROOT, path), bytes, files: files.length, fileTreeSha256: treeSha, sources }
}

const components = [
  component('hindsight-runtime', join(ROOT, 'runtime', 'hindsight'), 'PyInstaller onedir build of hindsight-api 1.0.0 (slim venv, arm64, adhoc-signed)'),
  component('embeddings-model', join(ROOT, 'runtime', 'models'), 'Xenova/multilingual-e5-small onnx/model_int8.onnx + tokenizer files (HF cache snapshot 761b726d, symlinks dereferenced)'),
  component('pg0-installation', join(ROOT, 'runtime', 'pg0'), 'pg0 embedded PostgreSQL installation 18.1.0 (pre-seeded; prevents first-run download)'),
  component('memory-adapter', join(ROOT, 'adapter'), 'copy of nisse/spike/m1-c-hindsight (src byte-identical) + @vectorize-io/hindsight-client 1.0.0 runtime files (MIT); sidecar relative-import target'),
]

const sidecarPath = join(ROOT, 'sidecar.mjs')
const runServer = join(ROOT, 'runtime', 'hindsight', 'scripts', 'run-server.sh')
const version = {
  schema: 'whalegirl.memory-packaging-version/v1',
  generatedAt: new Date().toISOString(),
  host: hostname(),
  platform: process.platform,
  arch: process.arch,
  product: { name: 'WhaleGirl Bot', productVersion: '0.1.0', dshBaseline: 'dsh-v0.2.1-rc.2 (fork baseline d521e6579d)' },
  components,
  clientPackage: {
    name: '@vectorize-io/hindsight-client',
    version: '1.0.0',
    license: 'MIT',
    files: ['package.json', 'dist/index.mjs', 'README.md'],
    note: 'only runtime files staged; bundle is self-contained (no runtime npm dependencies)',
  },
  files: {
    'sidecar.mjs': { bytes: statSync(sidecarPath).size, sha256: fileSha(sidecarPath), source: 'nisse/m4/memory/sidecar.mjs (byte-identical copy)' },
    'runtime/hindsight/scripts/run-server.sh': { bytes: statSync(runServer).size, sha256: fileSha(runServer), source: 'product-owned launcher (new; packaged layout contract)' },
  },
}

version.runtimeVersions = {
  hindsightApi: '1.0.0',
  pg0: '0.15.2',
  postgresInstallation: '18.1.0',
  embeddingModel: 'Xenova/multilingual-e5-small (int8 ONNX, 384 dims)',
  onnxruntime: 'bundled inside the PyInstaller onedir',
  nodeSidecar: 'Node >= 20 ESM (Electron runs it with ELECTRON_RUN_AS_NODE=1)',
}
version.offlineRecipe = {
  env: {
    HF_HUB_OFFLINE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
    TRANSFORMERS_OFFLINE: '1',
    HINDSIGHT_API_EMBEDDINGS_PROVIDER: 'onnx',
    HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_PATH: '<Resources>/memory/models/Xenova/multilingual-e5-small/onnx/model_int8.onnx',
    HINDSIGHT_API_EMBEDDINGS_ONNX_TOKENIZER_NAME_OR_PATH: '<Resources>/memory/models/Xenova/multilingual-e5-small',
    HINDSIGHT_API_RERANKER_PROVIDER: 'rrf',
    HINDSIGHT_API_DATABASE_URL: 'pg0',
    HINDSIGHT_API_HOST: '127.0.0.1',
  },
  preseed: '<dataRoot>/home/.pg0/installation/18.1.0 copied from <Resources>/memory/pg0/installation on first start',
  isolation: 'HOME=<dataRoot>/home; user DSH home never passed to children; no network egress for embeddings/DB',
}
version.notes = [
  'PyInstaller onedir is adhoc-signed (arm64); A-stream must re-sign nested binaries with Developer ID + hardened runtime before notarization.',
  'pg0 downloads PostgreSQL on first start unless <HOME>/.pg0/installation/18.1.0 is pre-seeded; run-server.sh seeds it from the bundle.',
  'sidecar.mjs is a byte-identical copy of m4/memory/sidecar.mjs and imports ../../spike/m1-c-hindsight/src/index.mjs relative to its own path; packaged layout must place adapter at Contents/spike/m1-c-hindsight.',
]
writeFileSync(join(ROOT, 'VERSION.json'), JSON.stringify(version, null, 2) + '\n')
console.log('VERSION=' + join(ROOT, 'VERSION.json'))
