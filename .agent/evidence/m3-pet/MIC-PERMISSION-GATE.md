# Mic Permission Gate — implementation + simulated denied state

## Implemented
- Product mode checks macOS mic permission before Pipecat auto-connect.
- Denied/unknown: client is still injected with `autoConnect=false`; UI bubble explains how to grant; no false `transport=ready`.
- Whether permission is granted: auto-connect proceeds as before.
- Pipecat-aware voice controls: mic enable/disable calls `window.__wgVoice.connect()/disconnect()` instead of clicking the legacy renderer mic button.
- Test-only override `NISSE_TEST_MIC_STATUS=denied` for automated gates; production uses `systemPreferences.getMediaAccessStatus`.

## Simulated denied test
Evidence: `m3/pet/evidence/MIC-PERMISSION-GATE.json`
- denied override -> `autoConnect=false`;
- manual `__wgVoice.connect()` after permission actually granted -> `transport=ready`, `connected=true`;
- app exit 0.

## Still UNVERIFIED
Real macOS TCC denial + System Settings regrant requires the user to interact with the OS permission dialog/System Settings. The simulated override must not be reported as real TCC acceptance.
