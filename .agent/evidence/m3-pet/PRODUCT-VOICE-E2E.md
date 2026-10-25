# Product Voice E2E — first real chain (2026-10-24)

Feature flag: `NISSE_PIPECAT_WORKER=1`  
Environment: dev DSH (isolated `/tmp/wg-dev`), pet-managed Pipecat Worker, real DSH bridge descriptor, real microphone (no fake media), system volume 55.

## Evidence
`m3/pet/evidence/PRODUCT-VOICE-E2E.json`

## Chain observed
1. pet starts; shell-managed Worker reaches `running` (real Python Pipecat + DashScope adapters).
2. DSH bridge health verified separately from Worker `/health`.
3. Pipecat client injected into the real pet renderer; `transport=ready`, `connected=true`, mic settings present.
4. DSH playback: `playback-identity` request `078b809d-...`, turn 1, `audioGeneration=1`; `<audio>` `paused=false`, `currentTime=16.502`.
5. Real-mic command (`请先停一下` via speaker) → barge confirmed:
   - latency from command playback start to confirm: **~2145.5 ms**
   - client cleanup: `barge-in-confirmed`, generation 1, `hadElement=true`, `pausedBefore=false`, result `cleared`.
6. Pet exited with code 0; no orphan Worker PIDs.

## Scope
- Proves the product-side chain (pet renderer + offer proxy + worker + DSH bridge descriptor + playback + command stop + cleanup + exit cleanup).
- Does not prove installation/TCC behavior or full free-form barge-in; G3 P1 remains command-gated.
- Dev DSH isolation only; main DSH untouched.
