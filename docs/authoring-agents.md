# Authoring agents and skills (.md)

The prompts that drive the agentic layer are not hard-coded: each workflow
stage that talks to Copilot is described by a Markdown **agent definition**,
optionally composed from reusable **skill** files. Improving the harness's
behavior is therefore mostly an editing exercise — change the `.md` files, run
the demo, compare results. No TypeScript changes are needed.

## Directory layout

```
agents/
  developer.agent.md      # session system prompt (implementation + verification fixes)
  specifier.agent.md      # specification-stage instruction
  skills/
    storybook.md          # reusable requirement blocks referenced by agents
    playwright.md
```

Resolution order for the agents directory:

1. explicit argument to `loadPromptSet(directory)` (used by tests),
2. the `HARNESS_AGENTS_DIR` environment variable,
3. the `agents/` directory shipped with the harness.

If an agent file is missing, the harness falls back to the equivalent built-in
prompt in [src/prompts/](../src/prompts/), so a partial directory is valid.

## File format

An agent definition is Markdown with optional YAML frontmatter:

```md
---
name: ingest
description: Retrieves work item and design context.
skills:
  - azure-work-items
  - figma-rest-api
---
You are the ingest agent. Gather the work item, design, and API contract
context needed by the specification stage. Report the result as compact JSON.
```

- `name` (optional) — defaults to the file name.
- `description` (optional) — for humans; not sent to the model.
- `skills` (optional) — list of skill names; each resolves to
  `skills/<name>.md` next to the agent file. A missing skill is a hard error,
  not a silent skip.

A skill file has the same shape; only its body is used:

```md
---
name: azure-work-items
description: How to retrieve work item data with the Azure CLI.
---
Retrieve work items with `az boards work-item show --id <id> --org <org>
--output json`. Read acceptance criteria from `fields."System.Description"`.
Never mutate work items; the harness owns all writes.
```

### Composition rule

The effective prompt is the agent body followed by each skill body, in the
order listed, separated by blank lines. `loadAgentDefinition` in
[src/agents.ts](../src/agents.ts) performs the composition;
`loadPromptSet` maps agents onto the stages that currently use them.

## How agents map to workflow stages

| File | Used as | Stage(s) |
| --- | --- | --- |
| `developer.agent.md` + skills | Copilot session **system prompt** | implementation, verification fix loop |
| `specifier.agent.md` + skills | First **user prompt** (with ingested context JSON appended) | specification |

Stages 1 (ingest) and 5 (publish) are currently programmatic — they call
Azure/Figma/OpenAPI clients directly through the `HarnessServices` seam. If you
convert a programmatic stage to an agentic one (for example an ingest agent
whose skills describe the `az` CLI and the Figma REST API), the loader already
supports it: name the file `ingest.agent.md`, load it with
`loadAgentDefinition(directory, 'ingest')`, and wire the returned prompt into
the stage in [src/harness.ts](../src/harness.ts). Keep the stage's checkpoint
and the workspace-only permission model unchanged.

## Guidelines for writing agent and skill files

- **State the stage contract first**: what the agent receives, what it must
  produce, and what it must never do (publish, advance the workflow, leave the
  workspace). The programmatic layer enforces these, but stating them reduces
  wasted turns.
- **One concern per skill.** "How to read Figma variables via REST" and "How
  to query work items via az CLI" are two skills; compose them in the agent's
  `skills` list.
- **Be deterministic.** Prefer exact commands, file globs, and acceptance
  criteria over adjectives. The verification gates — not the prose — are the
  final arbiter, so align skill text with what the gates actually check.
- **Don't grant capabilities in prose.** Tool access is enforced in
  [src/copilot.ts](../src/copilot.ts) (workspace-only file access, no MCP, no
  shell). A skill saying "run az pipelines run" cannot work from inside the
  session; CLI-facing skills belong to agents for stages the programmatic
  layer executes, or document context the agent should expect to receive.

## Testing your changes

1. `npm test` — [test/agents.test.ts](../test/agents.test.ts) validates
   loading, composition, missing-skill errors, and built-in parity.
2. `npm run dashboard`, then **Run demo (mocked integrations)** — a full
   five-stage run with mocked Azure/Figma/verification and the real Copilot
   session, so prompt changes are observable end to end without external
   accounts. Inspect the generated files in the temp workspace printed by the
   dashboard.
3. To experiment without touching the shipped defaults, copy `agents/` to a
   scratch directory and set `HARNESS_AGENTS_DIR=/path/to/scratch/agents`.
