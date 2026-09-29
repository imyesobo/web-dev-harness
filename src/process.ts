import { spawn } from 'node:child_process';
import type { CommandResult } from './types.js';

export async function runCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.once('error', reject);
    child.once('close', code => {
      resolve({
        command: [executable, ...args].join(' '),
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}
