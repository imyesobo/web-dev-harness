import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommandResult, TestResult } from '../types.js';
import { runCommand } from '../process.js';

type Runner = typeof runCommand;

export interface AzureOptions {
  organization: string;
  project: string;
  workspace: string;
  accessToken?: string | undefined;
  fetchImpl?: typeof fetch;
  runner?: Runner;
}

export class AzureClient {
  readonly #organization: string;
  readonly #project: string;
  readonly #workspace: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #run: Runner;

  constructor(options: AzureOptions) {
    this.#organization = options.organization;
    this.#project = options.project;
    this.#workspace = options.workspace;
    this.#token = options.accessToken;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#run = options.runner ?? runCommand;
  }

  async getWorkItem(id: number): Promise<unknown> {
    return this.#azJson([
      'boards', 'work-item', 'show',
      '--id', String(id),
      '--org', this.#organization,
      '--output', 'json',
    ]);
  }

  async ensurePullRequest(
    repository: string,
    sourceBranch: string,
    targetBranch: string,
    workItemId: number,
  ): Promise<unknown> {
    const existing = await this.#azJson([
      'repos', 'pr', 'list',
      '--organization', this.#organization,
      '--project', this.#project,
      '--repository', repository,
      '--source-branch', sourceBranch,
      '--target-branch', targetBranch,
      '--status', 'active',
      '--output', 'json',
    ]);
    if (Array.isArray(existing) && existing.length) return existing[0];
    return this.#azJson([
      'repos', 'pr', 'create',
      '--organization', this.#organization,
      '--project', this.#project,
      '--repository', repository,
      '--source-branch', sourceBranch,
      '--target-branch', targetBranch,
      '--title', `Implement work item ${workItemId}`,
      '--work-items', String(workItemId),
      '--output', 'json',
    ]);
  }

  async runPipeline(pipelineId: number, branch: string): Promise<unknown> {
    return this.#azJson([
      'pipelines', 'run',
      '--organization', this.#organization,
      '--project', this.#project,
      '--id', String(pipelineId),
      '--branch', branch,
      '--output', 'json',
    ]);
  }

  async publishTestResults(
    workItemId: number,
    resultFiles: readonly string[],
  ): Promise<number | undefined> {
    if (resultFiles.length === 0) return undefined;
    const results = (await Promise.all(resultFiles.map(parseTestResults))).flat();
    const run = await this.#request<{ id: number }>('test/runs', {
      name: `Web component harness - work item ${workItemId}`,
      automated: true,
      state: 'InProgress',
      comment: `Automated run linked to work item ${workItemId}`,
    });
    if (results.length) {
      await this.#request(`test/runs/${run.id}/results`, results.map(result => ({
        testCaseTitle: result.name,
        automatedTestName: result.name,
        outcome: result.outcome,
        durationInMs: result.durationMs,
        errorMessage: result.errorMessage,
        state: 'Completed',
        associatedWorkItems: [{ id: workItemId }],
      })));
    }
    await this.#request(`test/runs/${run.id}`, { state: 'Completed' }, 'PATCH');
    return run.id;
  }

  async #azJson(args: string[]): Promise<unknown> {
    const result: CommandResult = await this.#run('az', args, this.#workspace);
    if (result.exitCode !== 0) {
      throw new Error(`${result.command} failed (${result.exitCode}): ${result.stderr}`);
    }
    return JSON.parse(result.stdout) as unknown;
  }

  async #request<T = unknown>(
    resource: string,
    body: unknown,
    method = 'POST',
  ): Promise<T> {
    if (!this.#token) {
      throw new Error('SYSTEM_ACCESSTOKEN or AZURE_DEVOPS_EXT_PAT is required to publish test results');
    }
    const base = this.#organization.startsWith('http')
      ? this.#organization.replace(/\/$/, '')
      : `https://dev.azure.com/${encodeURIComponent(this.#organization)}`;
    const response = await this.#fetch(
      `${base}/${encodeURIComponent(this.#project)}/_apis/${resource}?api-version=7.1`,
      {
        method,
        headers: {
          Authorization: ['Bearer', this.#token].join(' '),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      throw new Error(`Azure DevOps API failed (${response.status}): ${await response.text()}`);
    }
    return response.json() as Promise<T>;
  }
}

export async function parseTestResults(file: string): Promise<TestResult[]> {
  const content = await readFile(file, 'utf8');
  if (path.extname(file).toLowerCase() === '.json') {
    const parsed = JSON.parse(content) as unknown;
    return parseJsonResults(parsed, file);
  }

  function parseJsonResults(value: unknown, file: string): TestResult[] {
    if (Array.isArray(value)) return value.map((entry, index) => normalizeJsonResult(entry, index));
    if (!value || typeof value !== 'object') throw new Error(`${file} has unsupported JSON results`);
    const report = value as Record<string, unknown>;
    const results: TestResult[] = [];
    for (const suite of Array.isArray(report.suites) ? report.suites : []) {
      results.push(...parsePlaywrightSuite(suite));
    }
    if (!results.length) throw new Error(`${file} has no supported JSON test results`);
    return results;
  }

  function parsePlaywrightSuite(value: unknown, prefix = ''): TestResult[] {
    const suite = value as Record<string, unknown>;
    const title = [prefix, suite.title].filter(Boolean).join(' › ');
    const results: TestResult[] = [];
    for (const specValue of Array.isArray(suite.specs) ? suite.specs : []) {
      const spec = specValue as Record<string, unknown>;
      for (const testValue of Array.isArray(spec.tests) ? spec.tests : []) {
        const test = testValue as Record<string, unknown>;
        const runs = Array.isArray(test.results) ? test.results as Array<Record<string, unknown>> : [];
        const run = runs.at(-1) ?? {};
        const errors = Array.isArray(run.errors) ? run.errors as Array<Record<string, unknown>> : [];
        results.push(normalizeJsonResult({
          name: [title, spec.title].filter(Boolean).join(' › '),
          status: run.status ?? test.status,
          durationMs: run.duration,
          errorMessage: errors.map(error => error.message).filter(Boolean).join('\n'),
        }, results.length));
      }
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) {
      results.push(...parsePlaywrightSuite(child, title));
    }
    return results;
  }
  return parseXmlResults(content);
}

function normalizeJsonResult(value: unknown, index: number): TestResult {
  const entry = value as Record<string, unknown>;
  const status = String(entry.outcome ?? entry.status ?? '').toLowerCase();
  return {
    name: String(entry.name ?? entry.title ?? `Test ${index + 1}`),
    outcome: ['passed', 'pass', 'success'].includes(status)
      ? 'Passed'
      : ['skipped', 'pending', 'notexecuted'].includes(status) ? 'NotExecuted' : 'Failed',
    ...(typeof entry.durationMs === 'number' ? { durationMs: entry.durationMs } : {}),
    ...(entry.errorMessage ? { errorMessage: String(entry.errorMessage) } : {}),
  };
}

function parseXmlResults(xml: string): TestResult[] {
  const results: TestResult[] = [];
  const cases = xml.matchAll(
    /<(testcase|UnitTestResult)\b([^>]*?)\s*(?:\/>|>([\s\S]*?)<\/\1>)/gi,
  );
  for (const match of cases) {
    const attributes = Object.fromEntries(
      [...(match[2] ?? '').matchAll(/([\w-]+)="([^"]*)"/g)].map(item => [item[1], item[2]]),
    );
    const body = match[3] ?? '';
    const rawOutcome = (attributes.outcome ?? '').toLowerCase();
    const failed = /<(?:failure|error)\b/i.test(body) || rawOutcome === 'failed';
    const skipped = /<skipped\b/i.test(body) || ['notexecuted', 'pending'].includes(rawOutcome);
    const durationMs = parseDuration(attributes.time ?? attributes.duration);
    results.push({
      name: decodeXml(attributes.name ?? attributes.testName ?? 'Unnamed test'),
      outcome: failed ? 'Failed' : skipped ? 'NotExecuted' : 'Passed',
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(failed ? { errorMessage: decodeXml(body.replace(/<[^>]+>/g, ' ').trim()) } : {}),
    });
  }

  function parseDuration(value: string | undefined): number | undefined {
    if (!value) return undefined;
    if (!value.includes(':')) {
      const seconds = Number(value);
      return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
    }
    const parts = value.split(':').map(Number);
    if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) return undefined;
    return Math.round(((parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0)) * 1000);
  }
  return results;
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
