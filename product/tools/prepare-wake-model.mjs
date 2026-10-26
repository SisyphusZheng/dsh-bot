/** Stage the official SHA-256 pinned KWS model for offline installed operation. */
import { ensureWakeWordModel, WAKE_WORD_MODEL_SHA256, WAKE_WORD_MODEL_FILES, WAKE_WORD_MODEL_NAME, WAKE_WORD_MODEL_URL } from '../pet/src/wake-word/model-manager.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../apps/desktop/resources/pet/wake-model'), model = await ensureWakeWordModel(root)
const files = Object.fromEntries(Object.values(WAKE_WORD_MODEL_FILES).filter(name => name !== 'keywords.txt').map(name => [name, createHash('sha256').update(readFileSync(resolve(model, name))).digest('hex')]))
writeFileSync(resolve(root, 'MODEL.json'), JSON.stringify({ name: WAKE_WORD_MODEL_NAME, url: WAKE_WORD_MODEL_URL, archiveSha256: WAKE_WORD_MODEL_SHA256, files }, null, 2) + '\n')
console.log(`PASS pinned wake model prepared: ${root}`)
