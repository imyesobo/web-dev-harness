import path from 'node:path';
import {
  CopilotClient,
  ToolSet,
  type CopilotSession,
  type PermissionHandler,
} from '@github/copilot-sdk';

import type { AgentActivity } from './types.js';

/** Conversation listener; role/content mirror a chat timeline. */
export type TranscriptListener = (
  role: 'user' | 'assistant' | 'reasoning' | 'tool',
  content: string,
) => void;

/** Structured activity listener feeding the progress event bus. */
export type ActivityListener = (activity: AgentActivity) => void;

export class CopilotAgent {
  readonly #client: CopilotClient;
  readonly #onTranscript: TranscriptListener | undefined;
  readonly #onActivity: ActivityListener | undefined;
  #session: CopilotSession | undefined;

  constructor(
    readonly workspace: string,
    readonly model: string,
    onTranscript?: TranscriptListener,
    onActivity?: ActivityListener,
  ) {
    this.#onTranscript = onTranscript;
    this.#onActivity = onActivity;
    // 'empty' mode disables keychain access and cannot reuse the Copilot CLI
    // login; 'copilot-cli' shares the local CLI credentials. Session safety is
    // enforced per-session below (workspace-only permissions, no MCP).
    this.#client = new CopilotClient({
      mode: 'copilot-cli',
      workingDirectory: workspace,
    });
  }

  async start(systemPrompt: string): Promise<void> {
    await this.#client.start();
    this.#session = await this.#client.createSession({
      model: this.model,
      workingDirectory: this.workspace,
      mcpServers: {},
      availableTools: new ToolSet().addBuiltIn('*'),
      enableSessionStore: false,
      onPermissionRequest: workspacePermissions(this.workspace),
      systemMessage: { mode: 'append', content: systemPrompt },
    });
    if (this.#onTranscript || this.#onActivity) {
      const emit = this.#onTranscript;
      const activity = this.#onActivity;
      this.#session.on(event => {
        if (event.type === 'assistant.message' && event.data.content.trim()) {
          emit?.('assistant', event.data.content);
        } else if (event.type === 'assistant.reasoning' && event.data.content?.trim()) {
          emit?.('reasoning', event.data.content);
        } else if (event.type === 'tool.execution_start') {
          emit?.('tool', describeToolCall(event.data.toolName, event.data.arguments));
          const argsSummary = summarizeArgs(event.data.arguments);
          activity?.({
            type: 'tool.start',
            tool: { name: event.data.toolName, ...(argsSummary !== undefined ? { argsSummary } : {}) },
          });
        } else if (event.type === 'tool.execution_complete') {
          activity?.({ type: 'tool.end' });
        }
      });
    }
  }

  async prompt(prompt: string): Promise<string> {
    if (!this.#session) throw new Error('Copilot session has not been started');
    this.#onTranscript?.('user', prompt);
    this.#onActivity?.({ type: 'prompt' });
    // Implementation turns write many files; the 60s default is far too short.
    const event = await this.#session.sendAndWait({ prompt }, 30 * 60 * 1000);
    this.#onActivity?.({ type: 'turn.end' });
    if (!event) throw new Error('Copilot returned no response');
    return event.data.content;
  }

  async stop(): Promise<void> {
    await this.#session?.disconnect();
    await this.#client.stop();
    this.#session = undefined;
  }
}

export function workspacePermissions(workspace: string): PermissionHandler {
  const root = path.resolve(workspace);
  return request => {
    if (request.kind !== 'read' && request.kind !== 'write') {
      return { kind: 'reject', feedback: 'The deterministic harness permits only workspace file access' };
    }
    const requested = request.kind === 'read'
      ? (request.resolvedPath ?? request.path)
      : (request.resolvedPath ?? request.fileName);
    const resolved = path.resolve(root, requested);
    if (request.requestSandboxBypass || (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))) {
      return { kind: 'reject', feedback: 'File access outside the workspace is forbidden' };
    }
    return { kind: 'approve-once' };
  };
}

function describeToolCall(toolName: string, args: unknown): string {
  if (args === undefined) return toolName;
  const serialized = summarizeArgs(args);
  return serialized === undefined ? toolName : `${toolName} ${serialized}`;
}

function summarizeArgs(args: unknown): string | undefined {
  if (args === undefined) return undefined;
  let serialized = JSON.stringify(args);
  if (serialized.length > 400) serialized = `${serialized.slice(0, 400)}…`;
  return serialized;
}
