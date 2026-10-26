# Current resource contract

`Resources/memory/runtime/{hindsight,models,pg0}` contains pinned native payloads.
`Resources/memory/{scripts,adapter,sidecar.mjs,VERSION.json}` comes from this source tree.
The adapter imports its vendored client as `runtime.mjs`; no ignored dist output is required.
Hindsight and the adapter run in owned process groups and bind only loopback.
The foreground wrapper seeds only PostgreSQL installation binaries into the private HOME.
Never replace or delete the instances/data directory. Readiness requires bank bootstrap and authenticated adapter health.
Run `product/tools/accept-macos.sh` for actual semantic retrieval and restart acceptance.
Build fresh with `product/tools/build-memory.sh`: hash-locked macOS wheels, a current Hindsight freeze, the fixed ONNX model, and pg0 installation binaries. No old DMG is an input.
