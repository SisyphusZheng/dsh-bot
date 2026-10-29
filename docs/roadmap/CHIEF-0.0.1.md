# Chief companion: 0.0.1 interaction and delivery contract

English | [中文](CHIEF-0.0.1.zh.md)

This brief defines the current closure and later integration boundaries. The product remains 0.0.1-beta; passing cloud checks does not establish Mac, real microphone or real model acceptance. See the [current checkpoint](../../review/0.0.1-candidate-2026-10-29/CHECKPOINT.json) for recorded results.

## Product identity

Nisse, represented by the companion, is the future DS-Bot Chief/Main Bot. It understands goals, calls other Bots, coordinates approvals and reports results. Busy, waiting for the user and idle are legitimate states; there is no additional main assistant above the Chief.

DSH supplies the sole Agent Runtime, Pipecat adapts media, ASR/TTS and voice events, and Hindsight stores personal long-term memory. This version does not deliver DS-Bot team scheduling or cloud execution and does not switch Agent Runtime.

## 0.0.1 interaction contract

- Preserve the greeting, microphone feedback, hold/toggle/always modes, global Option, offline wake, persona and skins, together with dragging, double-click navigation, questions and memory.
- Manage playback, capture and task execution separately. “停止/别说了/取消” stop playback; “停止任务/取消任务” send an identity-scoped cancellation to DSH. Retain legacy commands without submitting stop instructions as new work.
- While the Chief is busy, ordinary work enters the current voice Worker's in-memory queue with an acknowledgement; explicit approval answers and status controls bypass that queue. This is not a durable cross-process task queue; a Worker restart does not promise recovery of unsubmitted work.
- Voice approval answers apply only to one unique, pending request. Ambiguous, duplicate, stale or multiple requests cannot grant permission. Persistent grants require two clicks after actual parameters are available.
- Persistent grants match the same tool, working directory and exactly identical arguments, and can be revoked from the context menu. Corrupt stores are disabled and preserved; reason text, path substrings or tool names alone cannot grant broad permission.
- Recording cancellation discards capture only. Media disconnect detaches that connection while admitted Agent work continues. Quitting the App still uses existing Host/Memory cleanup and does not promise continued local execution after exit.
- Unknown execution status blocks automatic progression. Recovery reads official Session history, offers checked continuation or original-instruction resubmission, then requires a separate side-effect confirmation. Both become new user instructions to DSH; tools are never automatically replayed.

## Current issue mapping

PASS below covers only recorded cloud code and fixture checks. Acoustics, physical interaction and native macOS behavior require separate acceptance.

| Issue | Before → current behavior | Current result |
|---|---|---|
| 01 Oversized approval card | Repeated long paths in body → short summary, expandable target and actual arguments, smaller buttons | PASS |
| 02 No persistent allow | One-time allow/reject → exact grants, second confirmation, persistence and revocation | PASS |
| 03 Voice approvals queued | Allow treated as new work → control channel answers official approvals directly | PASS |
| 04 Stop starts new work | ASR sentence submitted after playback stops → consume stop commands and separate playback/task cancellation | PASS |
| 05 Rigid busy interaction | No feedback for new work → queue acknowledgement; approval/status/stop controls bypass work | PASS |
| 06 No quit entry | No context-menu exit → shared Electron quit flow from the context menu | PASS |
| 07 Normal double-click launch fails | Direct binary survival counted as success → inner signature verification and normal-launch acceptance | BLOCKED-ENVIRONMENT |
| 08 Resize only shrinks | Retain existing scrollHeight fix and execute shipped-page layout checks | PASS |
| 09 LaunchServices not tested | Direct binary execution only → require open for first launch and restart | BLOCKED-ENVIRONMENT |
| 10 Interrupted command still executes | Stop sentence enters work queue → consume separately; stale identities cannot control successor work | PASS |
| 11 Limited duck attempts | Two attempts per turn → remove hard cap, retain debounce and echo-candidate restoration | PASS |
| 12 No actual approval arguments | Tool name/reason only → capture actual arguments from the official pre-execute event | PASS |
| 13 Incomplete interruption recovery | Error/open-window only → official history preview, checked continuation/resubmission, second confirmation and expiry guards | PASS |
| 14 Technical main-window error | Main window and companion use concise interruption copy while retaining uncertainty and side-effect warnings | PASS |
| 15 Running from temporary directories | Add stable installation and previous-App backup; actual installation awaits Mac verification | BLOCKED-ENVIRONMENT |

Recovery for issue 13 does not promise tool rollback or idempotence: a new turn starts only after explicit user confirmation. Busy work, changed history, expiry and duplicate clicks reject submission. Issue 14 changes product copy only, preserving DSH failure reasons and durable events.

## Local Mac execution

From a committed, clean work branch, run the existing [build script](../../product/tools/build-macos.sh), then [native acceptance](../../product/tools/accept-macos.sh) on that same DMG. Direct binary execution cannot substitute for signature checks and LaunchServices first start/restart. Record notarization separately from signature validity.

```bash
bash product/tools/build-macos.sh
bash product/tools/accept-macos.sh /absolute/path/to/candidate.dmg
bash product/tools/install-macos.sh /absolute/path/to/dsh-bot.app
```

Installation defaults to ~/Applications/dsh-bot.app; an existing App is preserved unless --replace explicitly requests backup and replacement. Preserve user data, Gatekeeper and quarantine. Real users must accept TCC, speaker greeting echo, ten conversational turns, repeated interruptions, Bluetooth headphones and pointer pass-through.

## Later versions

| Version | Delivery boundary | Change from the current product |
|---|---|---|
| 0.0.1 | Stabilize existing local features | Remove beta only after remaining native acceptance and registered gaps close |
| 0.0.2 | Selective DS-Bot integration and CUA | Nisse becomes Chief, calls other Bots and unifies identity, approval and Hindsight adaptation |
| 0.0.3 | Companion experience and local TTS | Coordinate motion, touch and bubbles; add offline speech without removing cloud voice |
| 0.0.4 | App and plugin delivery | Share capability implementations; plugin installation still needs a native companion process |
| 1.0 | Headphones, Pad and persistent cloud tasks | Cross-device identity, controlled memory, durable work and result briefings; not currently delivered |

The 1.0 vision remains in its owning roadmap. This iteration commits and pushes stages only to the work branch; do not merge main, publish or use Actions. Check each stage before publishing and verify its remote SHA. After source freeze, evidence-only commits record actual checks of that source rather than reusing historical counts.
