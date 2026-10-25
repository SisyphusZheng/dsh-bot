# Packaging probe — interim Nisse.app from current pet source (2026-10-24)

## Result
- Built `/tmp/nisse-pet-package/dist/mac-arm64/Nisse.app` with electron-builder 26.16.0, `appId=ai.nisse.app`, unsigned dir target.
- Fixed a real packaging bug: the default project root resolved to `Contents/` for asar builds; now packaged builds use `app.getAppPath()` so the bundled `m5/voice-spike/client/inject-bundle.js` is found.
- Packaged app starts with `NISSE_PIPECAT_WORKER=1`, external real Pipecat worker (env-provided command/cwd for this probe), fake health-only bridge descriptor:
  - Worker `running`;
  - client injected; `transport=ready`, `connected=true`;
  - worker PID gone after app exit.
- Client errors observed were expected: fake bridge returns 501 for a DSH turn (health-only server), so status degrades; no false READY from bridge.

## NOT Gate 2 pass
- Worker/Python runtime is **external** in this probe; not self-contained.
- This is pet app only, not the full dsh-bot/DSH shell.
- Still required: bundle Python runtime + worker + dependencies into Resources; wire full shell; update hardcoded pet paths; signature/notarization decision.

## TCC implications
The built bundle has `CFBundleIdentifier=ai.nisse.app` (same identity as installed Nisse), so macOS TCC can be exercised against it. Real denial/regrant still requires the user to toggle the Nisse microphone permission and interact with the packaged app.
