# Voice Worker Supervisor — foundation evidence

Date: 2026-10-24
Scope: shell-owned Pipecat Worker lifecycle (no UI/provider/audio changes).

Implementation: `m3/pet/desktop/src/voice-worker-supervisor.mjs`
Tests: `m3/pet/desktop/test/voice-worker-supervisor.test.mjs`

Command:
```bash
cd m3/pet/desktop && node --test test/voice-worker-supervisor.test.mjs
```

Result: 3/3 PASS
- starts, becomes healthy, stops
- restarts after unexpected crash (bounded restart)
- stop is idempotent and does not restart

Not yet wired into `main.mjs`; legacy Qwen gateway remains the product default.
Next increment: start/stop this supervisor from the shell lifecycle behind a feature flag, then attach the Pipecat client/proxy.

## Electron lifecycle integration (main.mjs)

Feature flag: `NISSE_PIPECAT_WORKER=1` (or `WG_VOICE_RUNTIME=pipecat`). Default off; legacy Qwen gateway remains the default and no worker is spawned.

Integrated in `main.mjs`:
- start after app ready;
- stop awaited in `before-quit` graceful cleanup;
- worker health and DSH bridge health reported separately;
- startup/config failure is explicit (`state=failed`, `lastError`), no silent fallback;
- no restart during shutdown (supervisor `_stopping` + runtime stopRequested).

### Real Electron smoke
Command: `python3 /tmp/electron-worker-smoke2.py` (fake worker + fake bridge descriptor; isolated userData)
Evidence: `m3/pet/evidence/VOICE-WORKER-ELECTRON-SMOKE.json`

| case | result |
|---|---|
| enabled | worker `running`, bridge `ok`, worker PID gone after app exit |
| disabled | worker `disabled`, no PID, bridge check independent |
| crash | fake worker exit 7 -> bounded restart, `restarts=1`, state `running`, PID gone after exit |
| invalid config | `state=failed`, explicit missing descriptor error, no child |

4/4 PASS.
