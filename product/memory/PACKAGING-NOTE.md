# Memory adapter packaging note (A-stream integration)

The B-stream payload ships the Hindsight adapter byte-identical to
`nisse/m4/memory/sidecar.mjs` + `spike/m1-c-hindsight/src`, except for one
packaging adaptation:

- electron-builder does not copy a nested `node_modules` directory inside
  `extraFiles` payloads, so `@vectorize-io/hindsight-client` was moved from
  `adapter/m1-c-hindsight/node_modules/@vectorize-io/hindsight-client` to
  `adapter/m1-c-hindsight/vendor/hindsight-client`.
- The two imports of the bare package in `src/errors.mjs` and
  `src/memory-adapter.mjs` were rewritten to the relative path
  `../vendor/hindsight-client/dist/index.mjs`.

The client file content is unchanged. Re-verify with
`node --input-type=module -e "import('./adapter/m1-c-hindsight/src/index.mjs')"`
after rebuilding the payload.
