#!/usr/bin/env node
/**
 * harness-observe: run a GitHub Copilot SDK session as an *observed* session
 * reporting live progress to the local web-dev-harness dashboard.
 *
 * This is the Copilot-side counterpart of the Claude Code plugin: developers
 * who work in a Copilot CLI-style flow (outside the five-stage workflow) get
 * the same canonical progress surface. The session is sandboxed exactly like
 * harness-owned sessions: workspace-only file access, no MCP.
 *
 * Usage:
 *   harness-observe "<prompt>" [--workspace <dir>] [--model <model>]
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CopilotAgent } from '../copilot.js';
import { ProgressReporter } from '../progress/client.js';

export interface ObserveOptions {
  prompt: string;
  workspace: string;
  model: string;
  reporter?: ProgressReporter;
  agentFactory?: (
    workspace: string,
    model: string,
    onTranscript: ConstructorParameters<typeof CopilotAgent>[2],
    onActivity: ConstructorParameters<typeof CopilotAgent>[3],
  ) => Pick<CopilotAgent, 'start' | 'prompt' | 'stop'>;
}

export async function observe(options: ObserveOptions): Promise<string> {
  const externalId = randomUUID();
  const reporter = options.reporter ?? new ProgressReporter({
    runtime: 'copilot-sdk',
    externalId,
    title: options.prompt.length > 80 ? `${options.prompt.slice(0, 80)}…` : options.prompt,
  });
  const factory = options.agentFactory
    ?? ((workspace, model, onTranscript, onActivity) =>
      new CopilotAgent(workspace, model, onTranscript, onActivity));
  const agent = factory(
    options.workspace,
    options.model,
    (role, content) => {
      if (role === 'assistant') {
        reporter.report({ type: 'message', message: content.slice(0, 400) });
      }
    },
    activity => {
      if (activity.type === 'tool.start' && activity.tool) {
        reporter.report({ type: 'tool.start', tool: activity.tool });
      } else if (activity.type === 'tool.end' || activity.type === 'turn.end') {
        reporter.report({ type: 'tool.end' });
      }
    },
  );
  reporter.report({ type: 'session.start', status: 'running' });
  await reporter.flush();
  if (reporter.sessionUrl) console.log(`Live progress: ${reporter.sessionUrl}`);
  else console.log('Dashboard not reachable; progress will be delivered when it is (npm run dashboard).');
  try {
    await agent.start('You are assisting a developer in an observed web-dev-harness session.');
    const answer = await agent.prompt(options.prompt);
    reporter.report({ type: 'session.end', status: 'completed' });
    return answer;
  } catch (error) {
    reporter.report({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
    reporter.report({ type: 'session.end', status: 'failed' });
    throw error;
  } finally {
    await agent.stop().catch(() => undefined);
    await reporter.flush();
    if (reporter.sessionUrl) console.log(`Session recorded: ${reporter.sessionUrl}`);
  }
}

function parseArguments(argv: string[]): ObserveOptions {
  let prompt: string | undefined;
  let workspace = process.cwd();
  let model = process.env.COPILOT_MODEL ?? 'gpt-5';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--workspace') workspace = argv[++index] ?? workspace;
    else if (argument === '--model') model = argv[++index] ?? model;
    else if (!argument?.startsWith('--') && prompt === undefined) prompt = argument;
  }
  if (!prompt) {
    throw new Error('Usage: harness-observe "<prompt>" [--workspace <dir>] [--model <model>]');
  }
  return { prompt, workspace: path.resolve(workspace), model };
}

async function main(): Promise<void> {
  try {
    const answer = await observe(parseArguments(process.argv.slice(2)));
    console.log(answer);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
