# dsh-bot

Private source snapshot of **dsh-bot** (formerly WhaleGirlBot / 鲸鱼娘 Bot):
a macOS-first desktop AI companion built on a pinned DSH runtime.

## Layout

| Path | Contents |
|---|---|
| `apps/`, `packages/`, `scripts/` | DSH desktop shell fork and runtime packages (upstream + product commits) |
| `product/` | Product-owned sources: pet client, Pipecat voice worker, memory adapter, build helpers |
| `.agent/` | Project-owned documentation, decisions, acceptance evidence, version manifest, incident notes |

## Notes

- The bundled Hindsight payload (PyInstaller runtime, int8 model, pg0, adapter node_modules) is **not** in this repository due to size; see `.agent/` for the packaging contract and hashes.
- Build artifacts (DMG, .app, packaging evidence) are local-only and ignored.
- Personal machine paths in this snapshot were rewritten to `$HOME`.

## Architecture (current state, documented honestly)

- DSH is the only agent authority.
- Pipecat is the voice engine.
- Hindsight is long-term memory.
- The desktop pet still reuses the legacy NissePet Electron client; plan is to fold it into the main shell (see `.agent/docs/`).
