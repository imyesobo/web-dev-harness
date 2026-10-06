import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Per-run ingest credential. A fresh token is minted every time the dashboard
 * server starts and written, together with the server URL, to a well-known
 * local discovery file so local agent adapters (Claude Code mod, Copilot
 * wrapper, VS Code companion) can authenticate without long-lived secrets.
 */

export interface DiscoveryDocument {
  url: string;
  token: string;
  schemaVersion: number;
  pid: number;
  startedAt: string;
}

export function defaultDataDirectory(): string {
  return process.env.HARNESS_DATA_DIR ?? path.join(os.homedir(), '.web-dev-harness');
}

export function discoveryFile(dataDirectory: string): string {
  return path.join(dataDirectory, 'harness.json');
}

export function mintIngestToken(): string {
  return randomBytes(32).toString('hex');
}

export async function writeDiscoveryFile(
  dataDirectory: string,
  document: DiscoveryDocument,
): Promise<string> {
  await mkdir(dataDirectory, { recursive: true });
  const file = discoveryFile(dataDirectory);
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** Constant-time bearer token check against an Authorization header value. */
export function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
