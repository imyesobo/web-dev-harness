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

`AZURE_DEVOPS_EXT_PAT` can replace `SYSTEM_ACCESSTOKEN` outside Azure Pipelines.
Secrets must be provided through secret variables; never place them in source.

```sh
npm run build
node dist/src/harness.js
```

Use `--skip-publish` for a local run that performs stages 1–4 without creating
Azure resources. A completed skipped publication is checkpointed, so use a
separate state file when later exercising the real publish stage.
