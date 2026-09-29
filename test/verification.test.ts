import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommandResult } from '../src/types.js';
import { verificationCommands, verify } from '../src/verification.js';

test('verification runs quality gates in strict order', async () => {
  const calls: string[] = [];
  const attempt = await verify({
    workspace: '/workspace',
    runner: async (command, args): Promise<CommandResult> => {
      calls.push([command, ...args].join(' '));
      return { command, exitCode: 0, stdout: '', stderr: '' };
    },
    onFailure: async () => undefined,
  });

  assert.equal(attempt, 1);
  assert.deepEqual(
    calls,
    verificationCommands.map(([command, args]) => [command, ...args].join(' ')),
  );
});

test('verification retries at most three times with exact failure output', async () => {
  const feedback: string[] = [];
  let calls = 0;
  await assert.rejects(
    verify({
      workspace: '/workspace',
      runner: async (): Promise<CommandResult> => {
        calls += 1;
        return {
          command: 'npm run test:contract',
          exitCode: 2,
          stdout: 'contract output',
          stderr: 'schema mismatch',
        };
      },
      onFailure: async context => {
        feedback.push(context);
      },
    }),
    /failed after 3 attempts/,
  );
  assert.equal(calls, 3);
  assert.equal(feedback.length, 2);
  assert.match(feedback[0] ?? '', /contract output[\s\S]*schema mismatch/);
});
