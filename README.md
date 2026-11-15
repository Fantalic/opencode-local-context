# opencode-plugin

Standalone home of the `local-context` OpenCode plugin.

This repo is a local dev tooling project — it is **not** part of PolyStrata.

## What's here

- `local-context.ts` — the plugin source file.
- `apply-plugin.ps1` — one-command deploy script (PowerShell).
- `SESSION-HEADERS-HANDOFF.md` — implementation notes for the plugin.
- `WEB-UI-WIDGET-SPEC.md` — spec for the widget component.

## How to edit

1. Make changes to the `.ts` files in this repo.
2. Run `apply-plugin.ps1` to deploy.
3. Restart OpenCode manually to load the new plugin.

## Deploy with apply-plugin.ps1

From **any** directory, run:

```powershell
& 'E:\_tools\strata\opencode-plugin\apply-plugin.ps1'
```

What it does:

1. Checks that Node.js is available.
2. Syntax-checks `local-context.ts` with Node (no execution).
3. Copies `.ts` (and `.json`) files to `C:\Users\FakuPara\.config\opencode\plugins\`.
4. Prints a reminder to restart OpenCode manually.

**Nothing is restarted or killed.** The script's only writes are file copies.
It is idempotent — safe to run repeatedly.

## Manual restart

After applying, restart OpenCode yourself to pick up the new plugin.
