# Agent Notes

## Required Check Before Every Commit Or Push

Run the two-tab live collaboration regression test before every commit or push.

The change is not ready to publish unless this test passes.

## Required Test

Command:

```powershell
$env:NODE_PATH='C:\Users\rubie\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
& 'C:\Users\rubie\Documents\Codex\2026-04-22-i-would-like-you-to-create\runtime\node\node.exe' scripts/test-two-tab-sync.mjs
```

What it checks:

- starts the local server
- opens the same puzzle in two separate browser contexts
- dismisses the start dialog
- verifies real UI sync for digit, undo, corner marks, centre marks, and color
- verifies polling-only fallback still syncs when the live stream endpoint is unavailable
- fails if the sync takes longer than 2 seconds

If this test fails, do not commit or push without explicitly telling the user.

## Extra Check For Camera/Audio Changes

If you edit the live camera/audio feature, also run this AV smoke test before commit or push:

```powershell
$env:NODE_PATH='C:\Users\rubie\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
& 'C:\Users\rubie\Documents\Codex\2026-04-22-i-would-like-you-to-create\runtime\node\node.exe' scripts/test-av-call.mjs
```

What it checks:

- starts the local server with a local public origin
- opens the same room in two separate browser contexts
- joins camera/audio in both tabs with fake media devices
- verifies each tab receives at least one remote media tile

## Optional Public Smoke Test

If the user reports that the deployed site is broken, also run the same test against the live site:

```powershell
$env:NODE_PATH='C:\Users\rubie\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
$env:TEST_BASE_URL='https://sudokupad-party.onrender.com'
& 'C:\Users\rubie\Documents\Codex\2026-04-22-i-would-like-you-to-create\runtime\node\node.exe' scripts/test-two-tab-sync.mjs
Remove-Item Env:TEST_BASE_URL
```
