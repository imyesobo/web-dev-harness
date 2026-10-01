import { runCommand } from './process.js';
import type { CommandResult } from './types.js';

export const verificationCommands: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['npm', ['run', 'test:contract']],
  ['npx', ['test-storybook', '--ci']],
  ['npx', ['playwright', 'test']],
  ['npm', ['run', 'lint']],
];

export interface VerificationOptions {
  workspace: string;
  maxAttempts?: number;
  runner?: typeof runCommand;
  onFailure: (errorContext: string, attempt: number) => Promise<void>;
  onAttempt?: (attempt: number) => Promise<void>;
  signal?: AbortSignal;
}

export async function verify(options: VerificationOptions): Promise<number> {
  const maxAttempts = options.maxAttempts ?? 3;
  const runner = options.runner ?? runCommand;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.signal?.throwIfAborted();
    await options.onAttempt?.(attempt);
    let failure: CommandResult | undefined;
    for (const [executable, args] of verificationCommands) {
      options.signal?.throwIfAborted();
      const result = await runner(
        executable,
        args,
        options.workspace,
        process.env,
        options.signal,
      );
      options.signal?.throwIfAborted();
      if (result.exitCode !== 0) {
        failure = result;
        break;
      }
    }
    if (!failure) return attempt;
    if (attempt === maxAttempts) {
      throw new Error(
        `Verification failed after ${maxAttempts} attempts:\n${formatFailure(failure, attempt)}`,
      );
    }
    await options.onFailure(formatFailure(failure, attempt), attempt);
  }
  throw new Error('Unreachable verification state');
}

function formatFailure(result: CommandResult, attempt: number): string {
  return [
    `Verification command failed on attempt ${attempt}: ${result.command}`,
    `Exit code: ${result.exitCode}`,
    'stdout:',
    result.stdout,
    'stderr:',
    result.stderr,
  ].join('\n');
}
