# Host Integration

DSH owns the Agent, Sessions, tools, approvals and structured questions. This product adapter exposes authenticated local operations and mirrors official interactions for the desktop pet.

The Node entry is `lib/index.js`. The browser source is `src/client/index.js`; Desktop's bundle step builds `lib/client.js` with the official `packages/client/tsdown.client.ts` preset. The browser export is a classic script registering a closure factory with `window.__ModuleLoader__`; it must never contain bare ESM exports. The existing Host Loader row and `dsh.client` manifest metadata discover it automatically. There is no plugin named `dsh.client`.

Navigation subscribes to the official Session list and opens the latest pet-requested Session only after that list contains it. Cached preload requests can arrive before the initial snapshot; they must not fail plugin activation. Both subscriptions belong to one effect and are removed on disposal.

Build: `node apps/desktop/scripts/build-pet-client.mjs`. Source tests: `node --test nisse/packages/host-integration/tests/*.test.mjs`. Artifact activation: `pnpm exec vitest run apps/desktop/tests/host-client-bundle.spec.ts`. Full production UI and previous-format negative control: `node product/tools/smoke-host.mjs --web` after a production build, with Playwright Chromium installed or `DSH_CHROMIUM_EXECUTABLE` set. Only Electron's preload callback is a fixture in that browser smoke; the Host, module loader, UI and Session selection are real.

Native packaged startup and shutdown remain owned by `bash product/tools/accept-macos.sh <new.dmg>`. Provider credentials, actual audio and the real Hindsight database require their corresponding runtime acceptance; mock-provider or HTTP-fixture results do not qualify them.
