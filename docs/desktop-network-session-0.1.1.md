# Desktop changes in 0.1.1

Based on `refactor-core` at `28bcbdd`. No Chromium source changes or kernel compilation.

## Network acceleration

- Edit the saved source from the source tag or a node's Edit action. The dialog loads the saved name, source type and links/subscription URL. A subscription's nodes remain managed by that subscription.
- Keep the source ID and encrypt edited content through the existing secret codec. Status events never include source content.
- Reconnect after saving; if the enabled core rejects the edit, restore the previous settings and restart them.
- Add a mihomo `url-test` group behind the existing selector: health checks every 300 seconds, tolerance 50 ms. Only the automatic group follows test results; choosing a row pins the outer selector.
- Persist manual selection across restarts. An explicit automatic action clears it. A missing pinned node reports an error rather than silently choosing another.
- Previously saved selections remain pinned for compatibility; click the automatic selection action to release them.
- Read provider metadata for node ownership, protocol type and current delay; poll the visible settings page every 10 seconds to reflect core-side automatic selection.

## Startup pages

- Add per-profile `startupMode`: `urls` (default for old profiles) or `restore`.
- Restore mode uses Chromium's native session files and `--restore-last-session`; it does not also pass configured startup URLs.
- Set `session.restore_on_startup` before launch and reset it when switching back to URL mode.
- Retain configured URLs while the URL field is disabled in restore mode.
- Preserve the mode across reload, duplicate, export and migration through the shared portable draft.
- Request graceful shutdown in restore mode so session files can flush. Existing timeout handling still stops an unresponsive process.
- Fingerprint diagnostics explicitly use URL mode and never restore the user's browsing session.

## Validation

- TypeScript check and production build.
- Full test suite: 275 passed, 2 skipped; kernel lock verification passed (tracked patch blobs must retain LF bytes on Windows).
- Real mihomo with controlled local healthy/slow/dead nodes: automatic fastest-node selection, manual pin across restart and retest, editing, invalid-edit rollback and return to automatic mode.
- Actual 155 and 156 binaries with isolated temporary profiles: first-use new tab, multiple tabs restored after application close/reopen, then URL mode opens only the configured page.
- Electron UI smoke: source editor prefill and save, row pin, restore radio selection, disabled URL field, saved mode reopening and return to URL mode without losing configured URLs.

Cookies, profile data, proxies and existing kernels are not migrated by this release. Keep using the application's existing data location.
