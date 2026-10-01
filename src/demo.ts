import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HarnessServices } from './types.js';
import type { SessionConfigInput } from './dashboard/types.js';

const demoOpenApi = `openapi: 3.0.3
info:
  title: Customer Feedback API
  version: 1.0.0
servers:
  - url: https://api.demo.example.com
paths:
  /feedback:
    post:
      operationId: submitFeedback
      summary: Submit customer feedback
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/FeedbackRequest'
      responses:
        '201':
          description: Feedback stored
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/FeedbackResponse'
        '400':
          description: Validation error
components:
  schemas:
    FeedbackRequest:
      type: object
      required: [email, rating, message]
      properties:
        email:
          type: string
          format: email
        rating:
          type: integer
          minimum: 1
          maximum: 5
        message:
          type: string
          maxLength: 500
    FeedbackResponse:
      type: object
      required: [id, receivedAt]
      properties:
        id:
          type: string
          format: uuid
        receivedAt:
          type: string
          format: date-time
`;

const demoPackageJson = {
  name: 'demo-feedback-form',
  version: '0.1.0',
  private: true,
  type: 'module',
  description: 'Demo workspace for the web-dev-harness demo session',
  scripts: {
    'test:contract': 'echo "contract tests are mocked in demo mode"',
    lint: 'echo "lint is mocked in demo mode"',
  },
  dependencies: { lit: '^3.3.0', '@lion/ui': '^0.21.0' },
};

const demoWorkItem = {
  id: 1234,
  fields: {
    'System.Id': 1234,
    'System.WorkItemType': 'User Story',
    'System.Title': 'Customer feedback form component',
    'System.State': 'Active',
    'System.Description': [
      'Build a <feedback-form> web component with Lit and @lion/ui.',
      'It collects email, a 1-5 star rating, and a message (max 500 chars),',
      'validates input inline, and submits to POST /feedback of the Customer',
      'Feedback API. Show a confirmation state on success and an error state',
      'on failure. The component must be keyboard accessible.',
    ].join(' '),
    'System.Tags': 'demo; web-component; accessibility',
  },
};

const demoFigmaDesign = {
  name: 'Feedback Form',
  styles: {},
  components: {},
  document: {
    id: '1:1',
    name: 'feedback-form',
    type: 'FRAME',
    layoutMode: 'VERTICAL',
    itemSpacing: 16,
    paddingLeft: 24,
    paddingRight: 24,
    paddingTop: 24,
    paddingBottom: 24,
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
    cornerRadius: 12,
    children: [
      { id: '1:2', name: 'Title', type: 'TEXT', characters: 'Share your feedback', style: { fontSize: 24, fontWeight: 700 } },
      { id: '1:3', name: 'Email input', type: 'FRAME', children: [{ id: '1:4', name: 'Label', type: 'TEXT', characters: 'Email' }] },
      { id: '1:5', name: 'Rating', type: 'FRAME', layoutMode: 'HORIZONTAL', itemSpacing: 8, children: [{ id: '1:6', name: 'Star', type: 'VECTOR', fills: [{ type: 'SOLID', color: { r: 1, g: 0.8, b: 0 } }] }] },
      { id: '1:7', name: 'Message textarea', type: 'FRAME', children: [{ id: '1:8', name: 'Label', type: 'TEXT', characters: 'Message' }] },
      { id: '1:9', name: 'Submit button', type: 'FRAME', cornerRadius: 6, fills: [{ type: 'SOLID', color: { r: 0.04, g: 0.39, b: 0.81 } }], children: [{ id: '1:10', name: 'Label', type: 'TEXT', characters: 'Send feedback' }] },
    ],
  },
};

/** Creates a throwaway workspace seeded with the demo OpenAPI contract. */
export async function prepareDemoWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), 'web-dev-harness-demo-'));
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'openapi.yaml'), demoOpenApi);
  await writeFile(
    path.join(workspace, 'package.json'),
    `${JSON.stringify(demoPackageJson, null, 2)}\n`,
  );
  return workspace;
}

export function demoSessionInput(workspace: string): SessionConfigInput {
  return {
    workspace,
    workItemId: demoWorkItem.id,
    adoOrganization: 'https://dev.azure.com/demo-org',
    adoProject: 'Demo Project',
    adoRepository: 'demo-feedback-form',
    sourceBranch: 'feature/demo-feedback-form',
    targetBranch: 'main',
    pipelineId: 42,
    figmaFileKey: 'DEMO-FILE-KEY',
    figmaNodeIds: ['1:1'],
    figmaToken: 'demo-figma-token',
    openApiPath: 'openapi.yaml',
    resultFiles: [],
    skipPublish: false,
  };
}

/** Mocks for every external integration; Copilot itself stays real. */
export function createDemoServices(): HarnessServices {
  return {
    azure: {
      getWorkItem: async () => structuredClone(demoWorkItem),
      ensurePullRequest: async (repository, sourceBranch, targetBranch, workItemId) => ({
        pullRequestId: 99,
        status: 'active',
        title: `Implement work item ${workItemId}`,
        repository: { name: repository },
        sourceRefName: `refs/heads/${sourceBranch}`,
        targetRefName: `refs/heads/${targetBranch}`,
      }),
      runPipeline: async (pipelineId, branch) => ({
        id: 5001,
        definition: { id: pipelineId },
        sourceBranch: branch,
        status: 'inProgress',
      }),
      publishTestResults: async () => 4321,
    },
    figma: {
      getDesign: async () => structuredClone(demoFigmaDesign),
    },
    verificationRunner: async (executable, args) => ({
      command: [executable, ...args].join(' '),
      exitCode: 0,
      stdout: `[demo] ${[executable, ...args].join(' ')} passed (mocked)`,
      stderr: '',
    }),
  };
}
