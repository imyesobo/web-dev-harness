#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SessionManager, StepConflictError } from './dashboard/sessions.js';
import type { SessionConfigInput } from './dashboard/types.js';
import { createDemoServices, demoSessionInput, prepareDemoWorkspace } from './demo.js';

const staticRoot = fileURLToPath(new URL('../ui/', import.meta.url));

export interface DashboardServerOptions {
  host?: string;
  port?: number;
  manager?: SessionManager;
  staticDirectory?: string;
}

export function createDashboardServer(options: DashboardServerOptions = {}) {
  const manager = options.manager ?? new SessionManager();
  const root = options.staticDirectory ?? staticRoot;
  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response, manager, root);
    } catch (error) {
      sendJson(response, error instanceof SyntaxError ? 400 : 500, {
        error: error instanceof Error ? error.message : 'Unexpected server error',
      });
    }
  });
  return {
    manager,
    server,
    listen: () => new Promise<{ host: string; port: number }>((resolve, reject) => {
      const host = options.host ?? '127.0.0.1';
      const port = options.port ?? 4173;
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        const address = server.address();
        resolve({
          host,
          port: typeof address === 'object' && address ? address.port : port,
        });
      });
    }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  manager: SessionManager,
  root: string,
): Promise<void> {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    enforceSameOrigin(request);
    if (method === 'GET' && url.pathname === '/api/sessions') {
      sendJson(response, 200, manager.list());
      return;
    }
    if (method === 'POST' && url.pathname === '/api/sessions') {
      const input = await readJson(request) as SessionConfigInput;
      try {
        sendJson(response, 202, manager.start(input));
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : 'Invalid configuration',
        });
      }
      return;
    }
    if (method === 'POST' && url.pathname === '/api/demo') {
      const workspace = await prepareDemoWorkspace();
      const hybrid = url.searchParams.get('mode') === 'hybrid';
      sendJson(response, 202, manager.start(demoSessionInput(workspace, hybrid), createDemoServices()));
      return;
    }
    const step = /^\/api\/sessions\/([0-9a-f-]+)\/steps\/([a-z-]+)$/.exec(url.pathname);
    if (step && method === 'POST') {
      const body = await readJson(request) as { outputs?: unknown } | null;
      try {
        const record = manager.submit(step[1] ?? '', step[2] ?? '', body?.outputs);
        if (record) sendJson(response, 200, record);
        else sendJson(response, 404, { error: 'Session not found' });
      } catch (error) {
        sendJson(response, error instanceof StepConflictError ? 409 : 400, {
          error: error instanceof Error ? error.message : 'Invalid outputs',
        });
      }
      return;
    }
    const match = /^\/api\/sessions\/([0-9a-f-]+)(?:\/(cancel))?$/.exec(url.pathname);
    if (match) {
      const id = match[1] ?? '';
      const record = match[2] === 'cancel' && method === 'POST'
        ? manager.cancel(id)
        : method === 'GET' && !match[2] ? manager.get(id) : undefined;
      if (record) sendJson(response, 200, record);
      else sendJson(response, 404, { error: 'Session not found' });
      return;
    }
    sendJson(response, 404, { error: 'API route not found' });
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }
  const asset = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  if (!['index.html', 'app.js', 'app.js.map'].includes(asset)) {
    sendJson(response, 404, { error: 'Asset not found' });
    return;
  }
  const body = await readFile(path.join(root, asset));
  response.writeHead(200, {
    // no-cache: local dev server; a stale bundle hid UI changes behind max-age.
    'Cache-Control': 'no-cache',
    'Content-Type': contentType(asset),
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(method === 'HEAD' ? undefined : body);
}

function enforceSameOrigin(request: IncomingMessage): void {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin && host && new URL(origin).host !== host) {
    throw new Error('Cross-origin API requests are forbidden');
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new SyntaxError('Content-Type must be application/json');
  }
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 64 * 1024) throw new SyntaxError('Request body exceeds 64 KiB');
  }
  return JSON.parse(body) as unknown;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function contentType(file: string): string {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.map')) return 'application/json; charset=utf-8';
  return 'text/javascript; charset=utf-8';
}

async function main(): Promise<void> {
  const port = Number(process.env.HARNESS_UI_PORT ?? 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('HARNESS_UI_PORT must be an integer from 0 to 65535');
  }
  const dashboard = createDashboardServer({ port });
  const address = await dashboard.listen();
  console.log(`Harness dashboard: http://${address.host}:${address.port}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
