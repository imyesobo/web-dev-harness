import assert from 'node:assert/strict';
import test from 'node:test';
import { workspacePermissions } from '../src/copilot.js';
import type { PermissionRequest } from '@github/copilot-sdk';

test('Copilot permissions enforce workspace-only access and reject MCP', () => {
  const decide = workspacePermissions('/workspace');
  const read = decide({
    kind: 'read',
    path: '/workspace/src/component.ts',
    intention: 'inspect component',
  } as PermissionRequest, { sessionId: 'test' });
  const escape = decide({
    kind: 'write',
    fileName: '../secret',
    diff: '',
    intention: 'escape',
    canOfferSessionApproval: false,
  } as PermissionRequest, { sessionId: 'test' });
  const mcp = decide({ kind: 'mcp' } as PermissionRequest, { sessionId: 'test' });

  assert.deepEqual(read, { kind: 'approve-once' });
  assert.equal((escape as { kind: string }).kind, 'reject');
  assert.equal((mcp as { kind: string }).kind, 'reject');
});
