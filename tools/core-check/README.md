# core-check

Windows for the office core check (every window a believable whole computer; windows kept apart),
made by the launcher's own code and launched with its own `buildLaunchArgs` for the user's computer.

    npx vite-node tools/core-check/make-windows.ts core-windows.json

`vite-node` (as the unit tests) because ProfileStore imports Electron. The check itself
(`core-check.mjs`) runs on the Windows computer with the real prism kernel; it lives in the private
prism-kernel repo with the other kernel tests.
