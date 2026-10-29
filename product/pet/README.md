# Desktop companion presentation

English | [中文](README.zh.md)

The pet and its bubble use separate Electron windows. The transparent bubble window follows the rendered card height up to its configured maximum; short notices keep their compact size. Question text and complete option descriptions share a keyboard-scrollable content area with a visible scrollbar and overflow hint; answer controls stay in a separate fixed footer. Double-clicking a speech bubble or the pet opens DSH.

Speech and pending-request details support CommonMark headings, emphasis, lists, quotations and code. Rendering creates DOM elements without HTML execution, external media loading or model-controlled navigation. Full response text remains available in the scrollable bubble and DSH; the presentation does not truncate model output.

The Host persona requests short ordinary replies and result-first reports, while allowing detailed answers when requested. This is a model instruction, not a guaranteed word limit. Approval, failure and required action details must remain explicit.

An admitted recording shows “取消录音” even before ASR returns text. It discards only that capture; stopping an Agent task remains a separate action. Pending approvals/questions take priority over transient recording notices. Transcript bubbles explicitly label what was heard.

Always-listening input requires confirmation before ordinary work reaches DSH. Its expiring, single-use preview supports send, correction and discard; “确认发送” and “取消输入” control that preview. Passive VAD cannot duck or interrupt speech. “别说了” stops playback immediately; task cancellation and approval require “确认停止任务” and “确认允许一次”. Hold/toggle keep deliberate capture and direct submission. Changing modes closes the previous capture without reloading the pet or disconnecting media. These rules establish intent, not ASR confidence or speaker verification; deliberate-mode recognition errors remain possible.

With voice connected, the worker polls authenticated pending interactions and speaks each first approval or question once, including work begun in Desktop. Approval prompts do not read private commands or paths; question prompts read a bounded question and option labels, directing answers to the bubble. Prompts stop with the voice connection; voice-off system notifications are not implemented. Pipecat's Markdown filter removes formatting on the TTS path without changing Session or visual text.

ASR finals are assembled before ordinary work is admitted. A physical hold capture waits for release; clicking the mic or using a start/stop shortcut is a toggle capture. Other captures use a quiet window (`DSH_INPUT_SETTLE_MS`, default 650, range 200–1500). Incomplete short inputs require confirmation rather than deletion. Separate captures and independent requests never merge by guessed intent. Only exact controls interrupt on partial text; a complete admitted new utterance may stop playback while the existing Agent task continues.

The pet's waiting-input button opens the unsubmitted queue, with position, elapsed wait, correction, deletion and explicit reconfirmation. Defaults are five items and 60 seconds (`DSH_PENDING_INPUT_LIMIT`, range 1–20; `DSH_PENDING_INPUT_TTL`, range 10–600). Expiry, an aborted task or an uncertain outcome requires reconfirmation; no unsubmitted text is silently replayed. A busy Host keeps items waiting, and a definite pre-admission busy response preserves the original item. This is an in-memory input buffer, not a persistent Agent scheduler; media disconnect removes its unsubmitted items.

Run `node product/tools/smoke-pet-ui.mjs` after building for renderer screenshots and layout/interaction assertions. `DSH_CHROMIUM_EXECUTABLE` selects an installed Chromium when Playwright's browser is unavailable. `product/tools/verify-local.sh` includes this check, the startup suites and the existing voice/Host checks. Physical macOS pointer behavior, microphone permissions and room acoustics require native acceptance.

Recovery appears in the context menu and failed-task bubble. Choosing a mode does not execute work: the next card shows the original instruction and side-effect warning before a separate confirmation. New work or pending approvals invalidate an older draft. Any notice with visible action buttons accepts pointer interaction.
