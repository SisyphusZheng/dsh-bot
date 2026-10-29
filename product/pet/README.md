# Desktop companion presentation

English | [中文](README.zh.md)

The pet and its bubble use separate Electron windows. The transparent bubble window follows the rendered card height up to its configured maximum; short notices keep their compact size. Question text and complete option descriptions share a keyboard-scrollable content area with a visible scrollbar and overflow hint; answer controls stay in a separate fixed footer. Double-clicking a speech bubble or the pet opens DSH.

Speech and pending-request details support CommonMark headings, emphasis, lists, quotations and code. Rendering creates DOM elements without HTML execution, external media loading or model-controlled navigation. Full response text remains available in the scrollable bubble and DSH; the presentation does not truncate model output.

The Host persona requests short ordinary replies and result-first reports, while allowing detailed answers when requested. This is a model instruction, not a guaranteed word limit. Approval, failure and required action details must remain explicit.

An admitted recording shows “取消录音” even before ASR returns text. It discards only that capture; stopping an Agent task remains a separate action. Pending approvals/questions take priority over transient recording notices.

Run `node product/tools/smoke-pet-ui.mjs` after building for renderer screenshots and layout/interaction assertions. `DSH_CHROMIUM_EXECUTABLE` selects an installed Chromium when Playwright's browser is unavailable. `product/tools/verify-local.sh` includes this check, the startup suites and the existing voice/Host checks. Physical macOS pointer behavior, microphone permissions and room acoustics require native acceptance.

Recovery appears in the context menu and failed-task bubble. Choosing a mode does not execute work: the next card shows the original instruction and side-effect warning before a separate confirmation. New work or pending approvals invalidate an older draft. Any notice with visible action buttons accepts pointer interaction.
