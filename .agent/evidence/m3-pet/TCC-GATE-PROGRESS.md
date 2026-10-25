# TCC Gate Progress (macOS microphone)

## Implemented
- Product mode checks microphone permission before Pipecat auto-connect.
- Denied/unknown: client injected with `autoConnect=false`; UI bubble tells the user how to grant; no false `transport=ready`.
- Granted: auto-connect proceeds.
- Pipecat-aware mic controls: enable/disable calls `__wgVoice.connect()/disconnect()`, so after regrant the user can retry without restarting.
- Test-only override `NISSE_TEST_MIC_STATUS=denied`; production uses `systemPreferences.getMediaAccessStatus`.

## Automated evidence
- Simulated denied launch: `autoConnect=false`, no fake ready.
- Manual connect after actual permission was granted: `transport=ready`, `connected=true`.
- App exit code 0; no orphan worker.
- File: `m3/pet/evidence/MIC-PERMISSION-GATE.json`.

## Still required: real TCC interaction
Real OS permission denial/regrant cannot be automated by the agent. Required user steps:
1. Quit Nisse/pet.
2. Remove the dev Electron app from System Settings → Privacy & Security → Microphone (or reset its TCC record).
3. Launch product-mode test harness; when macOS asks for microphone, choose **Don't Allow**.
4. Verify: explicit permission error bubble; client must not show `transport=ready` before permission.
5. Allow the app in System Settings, click the pet mic button; verify transport becomes ready and real audio input works.
6. Quit; verify worker/renderer cleanup.

Status: **UNVERIFIED — waiting for user TCC interaction.**

## Finding 2026-10-24 12:56 — why System Settings has no "开发 Electron"

The macOS Microphone list shows **Nisse** (bundle `ai.nisse.app`, `/Applications/Nisse.app`, version 2.3.1), not "开发 Electron".

Facts:
- Dev Electron binary: bundle id `com.github.Electron`, name `Electron`.
- Installed product: bundle id `ai.nisse.app`, name `Nisse`; it is an **old 2.3.1 build and contains no Pipecat worker** (`find` found no worker/inject-bundle).
- Dev pet runs as a child of the DSH/agent terminal; macOS may attribute microphone responsibility to the parent app (DeepSeek Harness is granted in the same list), so a separate "Electron" row may not appear.
- Toggling **Nisse** exercises the old packaged app, not the current integrated source.

Conclusion: **real TCC denial/regrant must be tested on a newly packaged Nisse build that contains the current Pipecat worker integration.** Testing dev Electron under DSH is not equivalent to product TCC. Gate 2 (packaging) must precede Gate 1's real TCC check; the simulated denied-state test remains valid as code-path evidence only.

## 2026-10-24 13:10 — real denial attempt failed to exercise the right identity
- User turned **Nisse** microphone off in System Settings.
- The agent-launched app still observed microphone access because a child process launched from the DSH/terminal inherits the parent's TCC responsibility (DeepSeek Harness remains granted). **This was NOT a valid TCC denial test.**
- The interim packaged app launched via Finder/`open` exits at launch: AMFI reports invalid nested Electron frameworks after ad-hoc signing (`Mantle`, `Electron Framework`, `libffmpeg.dylib` not valid). This is a **packaging/signing failure**, not a permission result.
- Direct execution of the packaged binary works but again inherits parent TCC, so it cannot prove denial/regrant.

### Conclusion
Real TCC remains **UNVERIFIED**. A valid test requires:
1. a properly signed/launchable app bundle (correct nested-framework signing, or Developer ID);
2. launching it via Finder/LaunchServices so it owns TCC responsibility;
3. user toggling that app's permission and observing deny/regrant.

The interim app is not yet suitable for Gate 1 TCC. User can re-enable Nisse; toggling it did not affect the agent-launched test path.

## 2026-10-24 13:20 — why agent-launched apps cannot test TCC
`tccd` log shows the agent-launched app's TCC request is attributed to the parent:
`identifier=com.deepseek.dsh` (DeepSeek Harness), not `ai.nisse.*`.
Turning off Nisse therefore does not affect apps launched via the agent/`open` from this shell.

To obtain a real TCC result, the app must be launched by **Finder/LaunchServices by the user**, so it owns TCC responsibility.

### Isolated TCC probe
Built `/tmp/tcc-probe/dist/mac-arm64/NisseTCCProbe.app` (bundle `ai.nisse.tccprobe`, ad-hoc signed, no dev paths). It only exercises:
- `getMediaAccessStatus('microphone')`
- `askForMediaAccess('microphone')`
- refresh after System Settings change
and writes `/tmp/nisse-tcc-probe.log`.

This is a diagnostic app, not the product build. Product TCC still needs the signed/packaged Nisse.

## 2026-10-24 13:30 — real TCC lifecycle PASS on isolated probe
- Manual Finder double-click of `NisseTCCProbe.app` (bundle `ai.nisse.tccprobe`) gave the app its own TCC responsibility.
- Reset with `tccutil reset Microphone ai.nisse.tccprobe` after `lsregister -f`; first launch showed `not-determined`.
- User clicked **Don't Allow**: log recorded `before=not-determined, result=false, after=denied`.
- User enabled NisseTCCProbe in System Settings; refresh recorded `granted`.
- Evidence: `m3/pet/evidence/TCC-PROBE-RESULT.json`.

**Scope:** real macOS TCC lifecycle PASS for the probe identity. Product Nisse packaging/signing and its TCC are still pending; do not mark the product's TCC as PASS yet.
