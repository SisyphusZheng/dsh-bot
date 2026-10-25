# Main DSH pollution audit (read-only, 2026-10-24 17:13)

## Incident
A packaged Nisse test inherited `DSH_HOME=~/.dsh` and wrote into the main DSH home at 17:03. Build22 now forces packaged `DSH_HOME` to app userData (or `NISSE_DSH_HOME` in tests). Verified under an explicitly exported `DSH_HOME=~/.dsh`: main profile/package/workspace hashes unchanged; product used `/tmp/.../userdata/dsh-home`.

## Confirmed test-introduced changes (timestamps 17:03)
- `~/.dsh/whalegirl-g2/` (descriptor + empty workspace)
- `~/.dsh/profiles/desktop/whalegirl-g2/`
- `~/.dsh/profiles/desktop/node_modules/whalegirl-g2-bridge` → test `.desktop-build/.../Resources/whalegirl-g2-bridge`
- `~/.dsh/profiles/desktop/node_modules/nisse-host-integration` → test `.desktop-build/.../Resources/host-integration` (target changed)
- `~/.dsh/profiles/desktop/package.json`: bundles now include `whalegirl-g2-bridge`
- `~/.dsh/profiles/desktop/package.json`, `cordis.patch.yml`, `cordis.yml`, `cordis.patch.yml.commandcode-goat-d71dac091893c614.json` mtime 17:03 (managed block / plugin state rewrite)
- `~/.dsh/storages/workspace.json`: new workspace `d8014f9a-cb79-48b8-9f7f-7cbb69207f9d`, session `cc1f589e-e924-4ae7-bd3e-10d04475179d`
- `~/.dsh/storages/session_projcache/sessions/cc1f589e-...json`, `session-10a15c86-...json` (17:03)
- `~/.dsh/sessions/--private-tmp-dsh-installed-test-workspace--/cc1f.../` (test session and lock)
- `~/.dsh/sessions/--Users-user-Documents-projects-nisse--/session-10a15c86.../` (test session)

## Backup
`/tmp/nisse-maindsh-backup-1792832711` (profile, workspace.json, whalegirl-g2). This is **post-pollution**, so it cannot serve as a clean pre-test baseline.

## Proposed precise cleanup (not executed)
1. Remove `~/.dsh/whalegirl-g2` and `~/.dsh/profiles/desktop/whalegirl-g2`.
2. Remove `node_modules/whalegirl-g2-bridge` symlink; remove `whalegirl-g2-bridge` from profile package.json bundles.
3. Retarget or restore `node_modules/nisse-host-integration` to a stable source path (current target points into test `.desktop-build`).
4. Remove only test-created workspace/session IDs and cache files from workspace.json/sessions.
5. Do **not** wholesale restore `node_modules`, `package.json`, `cordis.patch.yml`, or `workspace.json` without a real pre-test baseline.
6. Restart main DSH afterwards and verify it boots.

## Risk
Main DSH is running; profile changes may apply on next restart. Current profile contains a symlink into a test build path, so this should be resolved before restarting main DSH.
