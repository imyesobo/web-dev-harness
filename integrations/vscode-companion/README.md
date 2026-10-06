# VS Code companion: Web Dev Harness

A deliberately light companion for developers living in VS Code with the
official GitHub Copilot extension. The Copilot chat panel is a closed surface,
so this extension never tries to inject into it — it provides a status-bar
item and deep links into the web dashboard instead.

What it does:

- Shows the most recent active harness/agent session in the status bar
  (status + current step), polling the local backend's
  `GET /api/progress/sessions` (read-only, no token required on loopback).
- `Web Dev Harness: Open dashboard` command (and status-bar click) opens the
  web UI, discovered from `~/.web-dev-harness/harness.json`.

## Run from source

1. Open this folder in VS Code.
2. Press `F5` (Run Extension), or package it with `npx @vscode/vsce package`
   and install the generated `.vsix`.

The extension has no dependencies and activates after startup; it hides its
status-bar item whenever the dashboard is not running.
