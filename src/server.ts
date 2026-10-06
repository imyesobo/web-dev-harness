#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SessionManager } from './dashboard/sessions.js';
import type { SessionConfigInput } from './dashboard/types.js';
import { createDemoServices, demoSessionInput, prepareDemoWorkspace } from './demo.js';
import { authorized, defaultDataDirectory, mintIngestToken, writeDiscoveryFile } from './progress/auth.js';
import { ProgressBus } from './progress/bus.js';
import {
  PROGRESS_SCHEMA_VERSION,
  validateEventInput,
  type AgentRuntime,
  type ProgressEventInput,
} from './progress/schema.js';

const staticRoot = fileURLToPath(new URL('../ui/', import.meta.url));

const runtimes = new Set<AgentRuntime>(['harness', 'claude-code', 'copilot-cli', 'copilot-sdk', 'custom']);

export interface DashboardServerOptions {
  host?: string;
  port?: number;
  manager?: SessionManager;
  staticDirectory?: string;
  /** Directory for persisted progress data and the discovery file; false disables both. */
  dataDirectory?: string | false;
  bus?: ProgressBus;
}

export function createDashboardServer(options: DashboardServerOptions = {}) {
  const dataDirectory = options.dataDirectory === false
    ? undefined
    : options.dataDirectory ?? defaultDataDirectory();
  let token = mintIngestToken();
  const bus = options.bus ?? new ProgressBus({
    ...(dataDirectory ? { dataDirectory } : {}),
    redact: text => token ? text.replaceAll(token, '[REDACTED]') : text,
  });
  const manager = options.manager ?? new SessionManager(undefined, bus);
  const root = options.staticDirectory ?? staticRoot;
  const sseClients = new Set<ServerResponse>();
  bus.subscribe((session, event) => {
    const payload = `event: progress\ndata: ${JSON.stringify({ session, event })}\n\n`;
    for (const client of sseClients) client.write(payload);
  });
  const context: ServerContext = { manager, bus, root, token, sseClients };
  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response, context);
    } catch (error) {
      sendJson(response, error instanceof SyntaxError ? 400 : 500, {
        error: error instanceof Error ? error.message : 'Unexpected server error',
      });
    }
  });
  const heartbeat = setInterval(() => {
    for (const client of sseClients) client.write(': keep-alive\n\n');
  }, 15_000);
  heartbeat.unref();
  server.on('close', () => {
    clearInterval(heartbeat);
    for (const client of sseClients) client.end();
    sseClients.clear();
  });
  return {
    manager,
    bus,
    server,
    get token() {
      return token;
    },
    close: () => new Promise<void>((resolve, reject) => {
      for (const client of sseClients) client.destroy();
      sseClients.clear();
      server.close(error => (error ? reject(error) : resolve()));
    }),
    listen: () => new Promise<{ host: string; port: number }>((resolve, reject) => {
      const host = options.host ?? '127.0.0.1';
      const port = options.port ?? 4173;
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        const address = server.address();
        const boundPort = typeof address === 'object' && address ? address.port : port;
        bus.baseUrl = `http://${host}:${boundPort}`;
        void (async () => {
          await bus.restore();
          if (dataDirectory) {
            try {
              await writeDiscoveryFile(dataDirectory, {
                url: `http://${host}:${boundPort}`,
                token,
                schemaVersion: PROGRESS_SCHEMA_VERSION,
                pid: process.pid,
                startedAt: new Date().toISOString(),
              });
            } catch {
              // Discovery is best-effort; ingest still works with explicit URL + token.
            }
          }
        })();
        resolve({ host, port: boundPort });
      });
    }),
  };
}

interface ServerContext {
  manager: SessionManager;
  bus: ProgressBus;
  root: string;
  token: string;
  sseClients: Set<ServerResponse>;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: ServerContext,
): Promise<void> {
  const { manager, bus, root } = context;
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    enforceSameOrigin(request);
    if (method === 'GET' && url.pathname === '/api/sessions') {
      sendJson(response, 200, manager.list());
      return;
    }
    if (method === 'GET' && url.pathname === '/api/progress/sessions') {
      sendJson(response, 200, bus.list());
      return;
    }
    if (method === 'GET' && url.pathname === '/api/events') {
      openEventStream(response, context);
      return;
    }
    const ingestMatch = /^\/api\/sessions\/([a-z-]+)\/([^/]+)\/events$/.exec(url.pathname);
    if (ingestMatch && method === 'POST') {
      handleIngest(request, response, context, ingestMatch[1] ?? '', ingestMatch[2] ?? '')
        .catch(() => sendJson(response, 400, { error: 'Invalid ingest request' }));
      return;
    }
    const streamMatch = /^\/api\/sessions\/([0-9a-f-]+)\/events$/.exec(url.pathname);
    if (streamMatch && method === 'GET') {
      const id = streamMatch[1] ?? '';
      if (!bus.get(id)) {
        sendJson(response, 404, { error: 'Session not found' });
        return;
      }
      openEventStream(response, context, id);
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
      sendJson(response, 202, manager.start(demoSessionInput(workspace), createDemoServices()));
      return;
    }
    const match = /^\/api\/sessions\/([0-9a-f-]+)(?:\/(cancel))?$/.exec(url.pathname);
    if (match) {
      const id = match[1] ?? '';
      const record = match[2] === 'cancel' && method === 'POST'
        ? manager.cancel(id)
        : method === 'GET' && !match[2] ? manager.get(id) ?? bus.get(id) : undefined;
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
  // Deep links (http://127.0.0.1:<port>/sessions/<id>) load the dashboard.
  const asset = url.pathname === '/' || /^\/sessions\/[0-9a-f-]+$/.test(url.pathname)
    ? 'index.html'
    : url.pathname.replace(/^\/+/, '');
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

async function handleIngest(
  request: IncomingMessage,
  response: ServerResponse,
  context: ServerContext,
  runtime: string,
  externalId: string,
): Promise<void> {
  if (!authorized(request.headers.authorization, context.token)) {
    sendJson(response, 401, { error: 'Missing or invalid ingest token' });
    return;
  }
  if (!runtimes.has(runtime as AgentRuntime) || runtime === 'harness') {
    sendJson(response, 400, { error: `Unknown agent runtime: ${runtime}` });
    return;
  }
  const body = await readJson(request) as { title?: string; events?: unknown };
  const events = Array.isArray(body.events) ? body.events : [body.events ?? body];
  for (const event of events) {
    const problem = validateEventInput(event);
    if (problem) {
      sendJson(response, 422, { error: problem });
      return;
    }
  }
  const { session, accepted } = context.bus.ingest(
    runtime as AgentRuntime,
    externalId,
    events as ProgressEventInput[],
    typeof body.title === 'string' ? body.title : undefined,
  );
  sendJson(response, 202, { session, accepted });
}

function openEventStream(response: ServerResponse, context: ServerContext, sessionId?: string): void {
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });
  if (sessionId) {
    // Replay persisted-in-memory history for a single session, then stream live.
    for (const event of context.bus.events(sessionId)) {
      response.write(`event: progress\ndata: ${JSON.stringify({ session: context.bus.get(sessionId), event })}\n\n`);
    }
    const unsubscribe = context.bus.subscribe((session, event) => {
      if (session.id === sessionId) {
        response.write(`event: progress\ndata: ${JSON.stringify({ session, event })}\n\n`);
      }
    });
    response.on('close', unsubscribe);
    return;
  }
  response.write(`event: snapshot\ndata: ${JSON.stringify({ sessions: context.bus.list() })}\n\n`);
  context.sseClients.add(response);
  response.on('close', () => context.sseClients.delete(response));
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
