# Progress integration: the harness as the canonical progress surface

The harness backend is the single source of truth for agent session progress.
Every runtime — the harness's own five-stage workflow, Claude Code, and
Copilot SDK/CLI style sessions — reports structured events into the same
event bus; surfaces that can draw rich UI (the web dashboard, the Claude Code
mod) mirror that state, and limited surfaces (plain VS Code Copilot chat) get
deep links plus a light companion.

## Session kinds: owner vs. observer

- **`harness-workflow`** sessions are owned and driven by the deterministic
  orchestrator (`runHarness`). Stages, verification attempts, and checkpoints
  have exact meaning and map onto progress steps.
- **`observed`** sessions belong to an external agent runtime (Claude Code,
  `harness-observe`) that merely reports progress. No stage semantics apply;
  the dashboard renders them in their own section.

External runtimes mint their own session IDs; the backend keys observed
sessions by `runtime + externalId` and maps them to an internal UUID, so a
resumed external session reconciles to the same record.

## Agent Session Progress schema (v1)

Defined in [src/progress/schema.ts](../src/progress/schema.ts). Versioned and
additive; every event carries `schemaVersion`. Each event has:

- `eventId` — globally unique; ingest deduplicates on it, making retried
  batches idempotent.
- `sequence` — monotonic per session; orders events and drops stale replays.
- `type` — `session.start|session.status|step.start|step.complete|tool.start|tool.end|message|error|session.end`.
- Optional `status`, `step` (`{id, name, attempt}`), `tool`
  (`{name, argsSummary}`), `message`, `metadata`.

Harness-owned sessions map `StageName` → `step.id`, verification retries →
`step.attempt`, and checkpoints → `step.complete`, so they need no parallel
representation.

## Backend endpoints

All endpoints bind to loopback only and enforce same-origin for browser
requests.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/sessions/:runtime/:externalId/events` | Batch ingest for external runtimes. Requires the per-run bearer token. Body: `{ title?, events: ProgressEvent[] }`. The `harness` runtime is reserved. |
| `GET /api/progress/sessions` | All progress sessions (both kinds). |
| `GET /api/events` | Server-Sent Events: an initial `snapshot`, then a `progress` event per published event. The dashboard uses this instead of polling (it falls back to a 2s poll if the stream fails). |
| `GET /api/sessions/:id/events` | SSE for a single session: replays in-memory history, then streams live. |
| `GET /sessions/:id` | Deep link; serves the dashboard shell. |

SSE was chosen over WebSocket deliberately: the flow is one-directional, it
works with the existing plain `node:http` server, and it keeps the attack
surface small.

## Auth and discovery

When the dashboard server starts it mints a fresh ingest token for that run
and writes a discovery file with `0600` permissions:

```
~/.web-dev-harness/harness.json        (override directory: HARNESS_DATA_DIR)
{ "url": "http://127.0.0.1:4173", "token": "…", "schemaVersion": 1, "pid": …, "startedAt": "…" }
```

Local adapters read it on demand — no long-lived secrets are stored in any
plugin. Ingested and internally published events are redacted before
persistence and broadcast (the ingest token and, for workflow sessions, the
Figma token are stripped), because external agents will leak secrets into
tool arguments.

## Persistence

Session records and events are appended under the data directory:

```
~/.web-dev-harness/sessions/<id>/record.json
~/.web-dev-harness/sessions/<id>/events.jsonl
```

Records survive server restarts; sessions left `running` by a dead process
are marked `failed` on restore.

## Runtime adapters

- **Harness itself** — `SessionManager` registers every workflow session on
  the bus and publishes stage, tool (from the instrumented `CopilotAgent`),
  and lifecycle events.
- **Claude Code** — [integrations/claude-code](../integrations/claude-code/):
  a thin plugin/mod that maps `session.start`, `tool.call` pre/post, and
  `session.end` into schema events, batches and retries with an offline
  buffer, shows a status line, and adds a `/harness` deep-link command.
- **Copilot SDK/CLI** — `harness-observe "<prompt>" [--workspace <dir>]
  [--model <model>]` runs a sandboxed Copilot session as an observed session.
  The shared transport lives in
  [src/progress/client.ts](../src/progress/client.ts) (`ProgressReporter`):
  sequence numbers, batching/debouncing, retry, and offline buffering in one
  place so adapters stay thin.
- **VS Code** — [integrations/vscode-companion](../integrations/vscode-companion/):
  status-bar item plus an open-dashboard command; it never touches the
  Copilot chat panel.

## Onboarding

1. `npm ci && npm run dashboard` — starts the backend, mints the token,
   writes the discovery file.
2. Claude Code: `claude --plugin-dir ./integrations/claude-code` (or publish
   to a plugin marketplace for one-command installs).
3. Copilot-style sessions: `npm run build`, then
   `node dist/src/cli/observe.js "<prompt>"` (or install the package and use
   the `harness-observe` bin).
4. Optional: run the VS Code companion from
   `integrations/vscode-companion/`.

## Versioning and future work

Every event carries `schemaVersion`; v1 backends reject other versions
explicitly rather than mis-parsing them. Planned next (in order): shared
visual language between the mod UI and the dashboard, bidirectional control
(pause/cancel/inject) for observed sessions over the existing SSE channel,
and exposing the deterministic verification gates and publishing pipeline as
a callable capability (skill/MCP tool) for external agents. A hosted
multi-user service is explicitly out of scope until the local-first loop is
proven.
