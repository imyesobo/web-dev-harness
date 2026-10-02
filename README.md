# Web Development Harness

A deterministic, headless TypeScript harness for developing Lit/Open-WC
components with GitHub Copilot, Lion, Figma, and Azure DevOps.

The TypeScript process—not the model—owns all five stages:

1. Fetch the Azure Boards work item, compact Figma design data, and OpenAPI 3 contract.
2. Ask Copilot for a Lion/Open-WC TDD specification.
3. Ask Copilot to implement the approved specification in the target workspace.
4. Run contract, Storybook, Playwright, and lint/accessibility gates in that order.
   A failed command is returned verbatim to Copilot and the complete gate sequence
   is retried, with a hard maximum of three attempts.
5. Publish JUnit/TRX/Playwright JSON results to Azure Test Plans, create an Azure
   Repos pull request linked to the work item, and trigger the deployment pipeline.

State is atomically checkpointed in `.harness/state.json`, making interrupted
runs resumable. The Copilot session exposes only built-in workspace file tools;
MCP, shell, URL, custom, and out-of-workspace access are denied in code.

See [docs/architecture.md](docs/architecture.md) for the architecture, the
programmatic/agentic layer boundary, and workflow diagrams. Stage prompts are
authored as Markdown agent and skill files in [agents/](agents/) — see
[docs/authoring-agents.md](docs/authoring-agents.md) to customize them.

## Prerequisites

- Node.js `^20.19.0` or `>=22.12.0`
- An authenticated GitHub Copilot CLI/SDK environment
- Azure CLI with the `azure-devops` extension, authenticated for the target project
- A target component workspace whose `package.json` supplies:
  - `test:contract`
  - `lint` (including Open-WC accessibility checks)
  - `test-storybook` and `playwright` executables available to `npx`

The issue refers to `@github/copilot-extension-sdk`; that unpublished package
name has been replaced by the official, production package
`@github/copilot-sdk`, which this project uses directly.

## Install and validate

```sh
npm ci
npm test
```

## Open-WC dashboard

The harness includes a responsive Lit web component interface built from Lion
primitives. It controls multiple concurrent workflow sessions while the
deterministic Node.js orchestrator retains ownership of stage progression.

```sh
npm run dashboard
```

Open `http://127.0.0.1:4173`. Set `HARNESS_UI_PORT` to select another local
port. The dashboard lets you:

- configure every work-item, Azure DevOps, Figma, OpenAPI, model, result, branch,
  pipeline, and publish option;
- start isolated sessions with state under
  `<workspace>/.harness/sessions/<session-id>/state.json`;
- monitor all sessions started by the running dashboard, their current stage,
  completed checkpoints, and verification attempt;
- cancel active work. Cancellation terminates active verification child
  processes and otherwise takes effect at the next deterministic stage boundary.

The server binds only to loopback, applies a restrictive Content Security Policy,
limits API request bodies, and rejects cross-origin API requests. Figma tokens
are retained only in server memory for the session and are never returned by the
API. Azure credentials still come from `SYSTEM_ACCESSTOKEN` or
`AZURE_DEVOPS_EXT_PAT` in the server environment.

### Demo mode

Click **Run demo (mocked integrations)** in the dashboard (or `POST /api/demo`)
to run the complete five-stage workflow without any external accounts. The demo:

- creates a throwaway workspace under the system temp directory, seeded with a
  demo `openapi.yaml` (Customer Feedback API) and `package.json`;
- mocks Azure DevOps (work item, pull request, pipeline, test publishing),
  Figma (a compact feedback-form design), and the verification commands;
- runs the specification and implementation stages against the **real** Copilot
  connection, using the same credentials as your local Copilot CLI.

The session appears in the dashboard like any other; the temporary workspace
path is shown when the demo starts so you can inspect the files Copilot writes.

## Hybrid attended execution

Every workflow step has an executor: `human`, `human-m365` (Human + Microsoft
365 Copilot), `github-agent`, or `tool`. The harness owns state, progress,
validation and repair; executors are interchangeable resources.

| Step | Default | Assignable to |
| --- | --- | --- |
| Ingest Sources, Validation, Publish | tool | tool only |
| Requirements Analysis, Impact Analysis, Implementation Plan, Code Generation | github-agent | human, human-m365, github-agent |

When the workflow reaches a human step the session status becomes
`waiting_for_human`. The dashboard shows a briefing to paste into M365 Copilot
and a structured form; submitting it (`POST /api/sessions/<id>/steps/<stepId>`
with `{ "outputs": { ... } }`) persists the outputs into `state.json` and
resumes the workflow. Downstream agent steps read those outputs exactly as
they read agent outputs. Each session shows its executor per step, execution
history, and a cost summary (human/agent/tool steps, Copilot calls, agent
calls avoided). **Run hybrid demo** assigns both analysis steps to
Human + M365 Copilot.

On the CLI, set `HARNESS_STEP_EXECUTORS`, e.g.
`requirements-analysis=human-m365,impact-analysis=human-m365`. The run pauses
and exits, printing the briefing; resume with
`node dist/src/harness.js --submit outputs.json`, where the file contains
`{ "stepId": "requirements-analysis", "outputs": { ... } }`.

## Configuration

| Variable | Purpose |
| --- | --- |
| `HARNESS_WORKSPACE` | Target repository; defaults to the current directory |
| `HARNESS_STATE_FILE` | State path relative to the workspace |
| `ADO_ORGANIZATION` | Azure DevOps organization name or collection URL |
| `ADO_PROJECT` | Azure DevOps project |
| `ADO_WORK_ITEM_ID` | Positive work item ID |
| `ADO_REPOSITORY` | Azure Repos repository name or ID |
| `ADO_SOURCE_BRANCH` | Existing pushed feature branch |
| `ADO_TARGET_BRANCH` | PR target; defaults to `main` |
| `ADO_PIPELINE_ID` | Pipeline triggered after publication |
| `SYSTEM_ACCESSTOKEN` | ****** for Azure Test Plans REST calls |
| `FIGMA_TOKEN` | Figma personal access token |
| `FIGMA_FILE_KEY` | Figma file key |
| `FIGMA_NODE_IDS` | Optional comma-separated node IDs |
| `OPENAPI_PATH` | JSON or YAML OpenAPI 3 document in the workspace |
| `COPILOT_MODEL` | Copilot model; defaults to `gpt-5` |
| `TEST_RESULT_FILES` | Comma-separated JUnit, TRX, or Playwright JSON files |
| `HARNESS_STEP_EXECUTORS` | Optional `step=executor` pairs, comma-separated |

`AZURE_DEVOPS_EXT_PAT` can replace `SYSTEM_ACCESSTOKEN` outside Azure Pipelines.
Secrets must be provided through secret variables; never place them in source.

```sh
npm run build
node dist/src/harness.js
```

Use `--skip-publish` for a local run that performs stages 1–4 without creating
Azure resources. A completed skipped publication is checkpointed, so use a
separate state file when later exercising the real publish stage.
