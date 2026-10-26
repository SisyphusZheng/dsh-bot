# Work-local repair checks

- `pnpm install --frozen-lockfile`: initial candidate recovery install, lock unchanged.
- Official `scripts/build.ts` buildGates + runGates: 5 typecheck and 9 complete-build gates, serial; exact results in final-build-results.json. A Work-only Node copy with official 24.22.1 headers and tsx loader launcher avoids forbidden Unix IPC; no source launcher was weakened.
- `node --test product/pet/tests/*.test.mjs nisse/packages/host-integration/tests/*.test.mjs product/tools/tests/*.test.mjs`: 19.
- Vitest 12 focused desktop/credentials/LLM/redaction files: 144. See verify-local.sh for file list.
- `python -m unittest discover -s product/voice-worker-src -p test_*.py`: 6.
- `node product/tools/smoke-host.mjs` and `--default-provider`: real compiled profile, local provider fixtures.
- `node product/tools/smoke-voice.mjs <python>`; fresh PyInstaller VoiceWorker.spec; `smoke-voice.mjs --binary <VoiceWorker>`.
- `DSH_CHROMIUM_EXECUTABLE=<headless-shell> node product/tools/smoke-pet-ui.mjs`: actual pages + explicit IPC fixture. Chrome for Testing 149.0.7827.55 from Google; the headless shell with single-process mode runs without Unix socket listeners.
- `node product/tools/verify-upstream.mjs`, deliberate one-file mutation rejected, original restored.
- `node product/tools/check-built-resources.mjs`; shell syntax; staged lint/whitespace/vendor hook.
- Extra old main-startup suite remains FAIL; baseline worktree at 99062c8 reproduces missing app.setName in the mock. Not suppressed or counted as passing.

No macOS build, actual microphone/provider conversation, or new Hindsight database acceptance was performed. No Actions used.
