# Claude Code plugin: Web Dev Harness Progress

A thin Claude Code mod that mirrors your Claude Code session into the local
[web-dev-harness](../../README.md) dashboard, making the harness the canonical
progress surface while you keep working where you already live.

What it does:

- Maps Claude Code lifecycle events (`session.start`, `tool.call` pre/post,
  `session.end`) onto the versioned Agent Session Progress schema and POSTs
  them in batches to the local dashboard, with retry and an in-memory offline
  buffer. Replayed batches are idempotent (unique event IDs + sequence numbers).
- Shows a status line with the current tool and the session deep link.
- Adds a `/harness` slash command that prints the deep link
  (`http://127.0.0.1:4173/sessions/<id>`).

## Install

```sh
claude --plugin-dir /path/to/web-dev-harness/integrations/claude-code
```

or add the directory through the `/plugin` command. Publish to a plugin
marketplace for one-command installs across a team.

## How it authenticates

When the dashboard starts (`npm run dashboard`) it mints a fresh ingest token
for that run and writes `~/.web-dev-harness/harness.json` (override the
directory with `HARNESS_DATA_DIR`):

```json
{ "url": "http://127.0.0.1:4173", "token": "…", "schemaVersion": 1 }
```

The mod reads that file on demand. No long-lived secrets are stored in the
plugin, and the dashboard only listens on loopback. Sessions reported while
the dashboard is down are buffered and delivered once it is reachable again.

## Versioning

The mod is pinned to mods API v1 and progress schema v1. It is deliberately
thin — schema mapping and transport only — so churn in the evolving mods API
stays cheap to absorb. Every event carries `schemaVersion` so the backend can
degrade gracefully across version skew.
