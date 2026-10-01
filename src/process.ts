import { spawn } from 'node:child_process';
import type { CommandResult } from './types.js';

export async function runCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<CommandResult> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const useProcessGroup = process.platform !== 'win32';
    const child = spawn(executable, args, {
      cwd,
      env,
      detached: useProcessGroup,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let forceKillTimer: NodeJS.Timeout | undefined;
    const kill = (signalName: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (useProcessGroup) process.kill(-child.pid, signalName);
        else child.kill(signalName);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    const abort = () => {
      kill('SIGTERM');
      forceKillTimer = setTimeout(() => kill('SIGKILL'), 2_000);
      forceKillTimer.unref();
    };
    signal?.addEventListener('abort', abort, { once: true });
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
      signal?.removeEventListener('abort', abort);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        command: [executable, ...args].join(' '),
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}
