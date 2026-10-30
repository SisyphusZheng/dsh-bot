// Dev Memory payload resolution contract (plan v2.1 §9.2).
//
// The unpackaged desktop dev entry must find the staged Hindsight payload with
// an explicit, explainable rule instead of an implicit developer-machine path:
//
//   1. the current workspace `.mvv-build/memory` (produced by
//      `bash product/tools/build-memory.sh`) is the normal source;
//   2. `NISSE_MEMORY_DIR` is kept only as a diagnostic compatibility override:
//      it is validated and its source is always reported, and a normal startup
//      never depends on it;
//   3. when neither is a valid payload the resolver returns a preflight message
//      naming `bash product/tools/build-memory.sh`; callers must fail explicitly
//      instead of pretending Memory is ready or starting an expensive build.
//
// The module is plain Node ESM with no Electron import, so it can be unit
// tested and also used by `product/tools/dev-doctor.mjs`. The packaged app keeps
// its own `<resources>/memory` contract and must not call this resolver.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Workspace-relative directory produced by product/tools/build-memory.sh. */
export const DEV_MEMORY_RELATIVE_PATH = '.mvv-build/memory'

/** Exact command that prepares the dev Memory payload. */
export const MEMORY_BUILD_COMMAND = 'bash product/tools/build-memory.sh'

/** Diagnostic-compatibility environment variable; never the normal source. */
export const DEV_MEMORY_ENV = 'NISSE_MEMORY_DIR'

/** Staged payload schemas produced by product/memory/scripts/gen-version.mjs. */
export const MEMORY_PAYLOAD_SCHEMA_PREFIX = 'dsh-bot.memory/'

/** Files a runnable dev Memory payload must contain. */
export const DEV_MEMORY_REQUIRED_FILES = Object.freeze([
  'VERSION.json',
  'sidecar.mjs',
  'scripts/run-server.sh',
  'adapter/m1-c-hindsight',
  'runtime/hindsight/HindsightAPI',
])

/** Marker that identifies the dsh-bot workspace root (not an arbitrary parent). */
const WORKSPACE_MARKER = join('product', 'versions.json')

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function defaultFileSystem() {
  return {
    existsSync,
    readFileSync,
    statSync,
    isFile: path => {
      try { return statSync(path).isFile() } catch { return false }
    },
    isDirectory: path => {
      try { return statSync(path).isDirectory() } catch { return false }
    },
  }
}

/**
 * Walk up from a directory until the dsh-bot workspace root is found.
 * @param {string} [startDirectory]
 * @returns {string|null}
 */
export function findWorkspaceRoot(startDirectory = process.cwd()) {
  let current = resolve(startDirectory)
  for (;;) {
    if (existsSync(join(current, WORKSPACE_MARKER))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function readJson(fileSystem, path) {
  try {
    return JSON.parse(fileSystem.readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Validate one staged Memory payload directory without mutating it.
 * @param {string} payloadPath
 * @param {object} [options]
 * @param {object} [options.fs] Injected filesystem for tests.
 * @param {boolean} [options.verifySidecar] Verify VERSION.json sidecarSha256 (default true).
 * @returns {object}
 */
export function validateMemoryPayload(payloadPath, { fs = defaultFileSystem(), verifySidecar = true } = {}) {
  const path = resolve(String(payloadPath))
  const problems = []
  const missingFiles = []
  if (!fs.existsSync(path)) {
    return {
      path,
      valid: false,
      missing: true,
      missingFiles,
      version: null,
      problems: [{ code: 'memory-payload-missing', message: `Memory payload directory does not exist: ${path}` }],
    }
  }
  if (!fs.isDirectory(path)) {
    return {
      path,
      valid: false,
      missing: false,
      missingFiles,
      version: null,
      problems: [{ code: 'memory-payload-not-directory', message: `Memory payload is not a directory: ${path}` }],
    }
  }
  for (const relative of DEV_MEMORY_REQUIRED_FILES) {
    if (!fs.existsSync(join(path, relative))) {
      missingFiles.push(relative)
      problems.push({ code: 'memory-file-missing', message: `Missing payload file: ${relative}` })
    }
  }
  const version = readJson(fs, join(path, 'VERSION.json'))
  let dependencies = null
  if (version === null) {
    problems.push({ code: 'memory-version-unreadable', message: 'VERSION.json is missing or not valid JSON' })
  } else {
    const schema = typeof version.schema === 'string' ? version.schema : ''
    if (!schema.startsWith(MEMORY_PAYLOAD_SCHEMA_PREFIX)) {
      problems.push({ code: 'memory-version-schema-mismatch', message: `Unexpected VERSION.json schema: ${schema || '<missing>'}` })
    }
    const components = Array.isArray(version.components) ? version.components : []
    if (components.length === 0 || components.some(component => !component || typeof component.path !== 'string' || typeof component.sha256 !== 'string')) {
      problems.push({ code: 'memory-components-invalid', message: 'VERSION.json components do not describe actual staged bytes' })
    }
    dependencies = version.dependencies && typeof version.dependencies === 'object' ? version.dependencies : null
  }
  // The PostgreSQL binary lives under the dependency version recorded in
  // VERSION.json; fall back to the product baseline when it is unreadable.
  const postgres = dependencies?.postgres && /^\d+\.\d+\.\d+$/u.test(String(dependencies.postgres))
    ? String(dependencies.postgres)
    : '18.1.0'
  const postgresBinary = join(path, 'runtime', 'pg0', 'installation', postgres, 'bin', 'postgres')
  if (!fs.existsSync(postgresBinary)) {
    const relative = join('runtime', 'pg0', 'installation', postgres, 'bin', 'postgres')
    missingFiles.push(relative)
    problems.push({ code: 'memory-file-missing', message: `Missing payload file: ${relative}` })
  }
  const modelFile = join(path, 'runtime', 'models', 'Xenova', 'multilingual-e5-small', 'onnx', 'model_int8.onnx')
  if (!fs.existsSync(modelFile)) {
    const relative = join('runtime', 'models', 'Xenova', 'multilingual-e5-small', 'onnx', 'model_int8.onnx')
    missingFiles.push(relative)
    problems.push({ code: 'memory-file-missing', message: `Missing payload file: ${relative}` })
  }
  let sidecarSha256Match = null
  if (verifySidecar && version && typeof version.sidecarSha256 === 'string') {
    try {
      const actual = sha256(fs.readFileSync(join(path, 'sidecar.mjs')))
      sidecarSha256Match = actual === version.sidecarSha256
      if (!sidecarSha256Match) {
        problems.push({ code: 'memory-sidecar-hash-mismatch', message: 'sidecar.mjs bytes do not match VERSION.json sidecarSha256' })
      }
    } catch (error) {
      problems.push({ code: 'memory-sidecar-unreadable', message: `Unable to hash sidecar.mjs: ${String(error?.message || error)}` })
    }
  }
  return {
    path,
    valid: problems.length === 0,
    missing: false,
    missingFiles,
    version: version && typeof version === 'object'
      ? {
        schema: version.schema ?? null,
        generatedAt: version.generatedAt ?? null,
        product: version.product ?? null,
        runtime: version.runtime ?? null,
        dependencies,
        components: Array.isArray(version.components) ? version.components.length : 0,
        sidecarSha256: typeof version.sidecarSha256 === 'string' ? version.sidecarSha256 : null,
      }
      : null,
    sidecarSha256Match,
    problems,
  }
}

function envOverride(env, fs) {
  const raw = env && typeof env[DEV_MEMORY_ENV] === 'string' ? env[DEV_MEMORY_ENV].trim() : ''
  if (!raw) {
    return { name: DEV_MEMORY_ENV, present: false, path: null, validation: null, ignored: false }
  }
  return {
    name: DEV_MEMORY_ENV,
    present: true,
    path: resolve(raw),
    validation: validateMemoryPayload(raw, { fs }),
    // The override is diagnostic compatibility only: whenever the workspace
    // payload is valid this variable is reported but never used.
    ignored: false,
  }
}

/**
 * Resolve the dev Memory payload and produce the exact preflight message.
 *
 * @param {object} options
 * @param {string} [options.repositoryRoot] Workspace root; discovered from `startDirectory`/cwd otherwise.
 * @param {string} [options.startDirectory] Where to start workspace discovery.
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {object} [options.fs] Injected filesystem for tests.
 * @returns {object}
 */
export function resolveDevMemoryPayload({ repositoryRoot = null, startDirectory = process.cwd(), env = process.env, fs = defaultFileSystem() } = {}) {
  const root = repositoryRoot ? resolve(repositoryRoot) : findWorkspaceRoot(startDirectory)
  const workspacePath = root ? join(root, DEV_MEMORY_RELATIVE_PATH) : null
  const workspaceValidation = workspacePath ? validateMemoryPayload(workspacePath, { fs }) : null
  const override = envOverride(env, fs)
  const diagnostics = []
  if (!root) {
    diagnostics.push({ kind: 'dev-memory.workspace-root-missing', detail: `No ${WORKSPACE_MARKER} found above ${resolve(startDirectory)}` })
  }
  if (workspaceValidation) {
    diagnostics.push({
      kind: 'dev-memory.workspace',
      valid: workspaceValidation.valid,
      path: workspaceValidation.path,
      problems: workspaceValidation.problems,
    })
  }
  if (override.present) {
    diagnostics.push({
      kind: 'dev-memory.env-override',
      valid: override.validation.valid,
      path: override.path,
      ignored: false,
      problems: override.validation.problems,
    })
  }

  const base = {
    repositoryRoot: root,
    workspacePath,
    workspace: workspaceValidation,
    envOverride: override,
    command: MEMORY_BUILD_COMMAND,
    diagnostics,
  }
  if (workspaceValidation?.valid) {
    return {
      ...base,
      source: 'workspace',
      path: workspaceValidation.path,
      valid: true,
      validation: workspaceValidation,
      message: `Memory dev payload ready: ${workspaceValidation.path}`,
      warnings: override.present
        ? [
          `${DEV_MEMORY_ENV}=${override.path} is set but ignored: the normal dev startup uses the workspace ${DEV_MEMORY_RELATIVE_PATH} payload (diagnostic compatibility only).`,
        ]
        : [],
    }
  }
  if (override.present) {
    // An explicitly set override is honored (legacy dev setups / controlled
    // tests) but its source and validation are always surfaced. Normal startup
    // never depends on it: without the variable we fail with the preflight
    // message instead of guessing a machine path.
    override.ignored = false
    const overrideValid = override.validation.valid
    return {
      ...base,
      source: 'env-override',
      path: override.path,
      valid: overrideValid,
      validation: override.validation,
      message: overrideValid
        ? `Memory dev payload comes from ${DEV_MEMORY_ENV}=${override.path} (diagnostic compatibility override; validated schema ${override.validation.version?.schema ?? 'unknown'}). The workspace ${DEV_MEMORY_RELATIVE_PATH} payload is missing/invalid; normal startup must not depend on this override. Prepare the workspace payload with: ${MEMORY_BUILD_COMMAND}`
        : `Memory dev payload comes from ${DEV_MEMORY_ENV}=${override.path} but validation failed (${override.validation.problems.map(problem => problem.code).join(', ') || 'unknown problem'}). The workspace ${DEV_MEMORY_RELATIVE_PATH} payload is missing/invalid. Prepare the workspace payload with: ${MEMORY_BUILD_COMMAND}`,
      warnings: [
        `Workspace Memory payload is not ready: ${workspaceValidation?.path ?? '<workspace root not found>'}`,
        `${DEV_MEMORY_ENV} is diagnostic compatibility only; normal startup must not depend on it.`,
        ...(overrideValid ? [] : [`${DEV_MEMORY_ENV} payload validation failed: ${override.validation.problems.map(problem => problem.code).join(', ')}`]),
      ],
    }
  }
  const missingWorkspace = !workspaceValidation?.valid
  return {
    ...base,
    source: 'missing',
    path: null,
    valid: false,
    validation: workspaceValidation,
    message: root
      ? `Memory dev payload missing or invalid: ${workspacePath}. Run: ${MEMORY_BUILD_COMMAND} (then restart dev:desktop).`
      : `dsh-bot workspace root not found from ${resolve(startDirectory)}; run this inside the dsh-bot repository.`,
    warnings: [
      ...(override.present
        ? [`${DEV_MEMORY_ENV}=${override.path} is also invalid: ${override.validation.problems.map(problem => problem.code).join(', ')}`]
        : []),
      ...(missingWorkspace ? ['Memory is NOT ready; the dev entry must fail explicitly instead of pretending ready.'] : []),
    ],
  }
}
