import path from 'node:path';
import {
  CopilotClient,
  ToolSet,
  type CopilotSession,
  type PermissionHandler,
} from '@github/copilot-sdk';

export class CopilotAgent {
  readonly #client: CopilotClient;
  #session: CopilotSession | undefined;

  constructor(
    readonly workspace: string,
    readonly model: string,
  ) {
    this.#client = new CopilotClient({ mode: 'empty', workingDirectory: workspace });
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
  }

  async prompt(prompt: string): Promise<string> {
    if (!this.#session) throw new Error('Copilot session has not been started');
    const event = await this.#session.sendAndWait({ prompt });
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
