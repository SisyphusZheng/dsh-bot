# Desktop companion presentation

The pet and its bubble use separate Electron windows. The bubble has a fixed 380 × 420 transparent window; short notices keep their compact card size. Question text and choices scroll independently, leaving the answer controls visible. Double-clicking a speech bubble or the pet opens DSH.

Speech and pending-request details support CommonMark headings, emphasis, lists, quotations and code. Rendering creates DOM elements without HTML execution, external media loading or model-controlled navigation. Full response text remains available in the scrollable bubble and DSH; the presentation does not truncate model output.

The Host persona requests short ordinary replies and result-first reports, while allowing detailed answers when requested. This is a model instruction, not a guaranteed word limit. Approval, failure and required action details must remain explicit.

An admitted recording shows “取消录音” even before ASR returns text. It discards only that capture; stopping an Agent task remains a separate action. Pending approvals/questions take priority over transient recording notices.

Run `node product/tools/smoke-pet-ui.mjs` after building for renderer screenshots and layout/interaction assertions. `DSH_CHROMIUM_EXECUTABLE` selects an installed Chromium when Playwright's browser is unavailable. `product/tools/verify-local.sh` includes this check, the startup suites and the existing voice/Host checks. Physical macOS pointer behavior, microphone permissions and room acoustics require native acceptance.
