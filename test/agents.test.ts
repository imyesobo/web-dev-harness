import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaultAgentsDirectory, loadAgentDefinition, loadPromptSet } from '../src/agents.js';

async function agentsFixture(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-agents-'));
  await mkdir(path.join(directory, 'skills'), { recursive: true });
  await writeFile(path.join(directory, 'ingest.agent.md'), [
    '---',
    'name: ingest',
    'description: Retrieves work item and design context.',
    'skills:',
    '  - azure-work-items',
    '---',
    'You are the ingest agent.',
  ].join('\n'));
  await writeFile(path.join(directory, 'skills', 'azure-work-items.md'), [
    '---',
    'name: azure-work-items',
    '---',
    'Use `az boards work-item show --id <id> --output json`.',
  ].join('\n'));
  return directory;
}

test('loads an agent definition composed with its skills', async () => {
  const directory = await agentsFixture();
  const agent = await loadAgentDefinition(directory, 'ingest');
  assert.equal(agent.name, 'ingest');
  assert.deepEqual(agent.skills, ['azure-work-items']);
  assert.match(agent.prompt, /^You are the ingest agent\./);
  assert.match(agent.prompt, /az boards work-item show/);
});

test('rejects an agent referencing a missing skill', async () => {
  const directory = await agentsFixture();
  await writeFile(path.join(directory, 'broken.agent.md'), [
    '---',
    'skills: [does-not-exist]',
    '---',
    'Body.',
  ].join('\n'));
  await assert.rejects(
    loadAgentDefinition(directory, 'broken'),
    /missing skill/,
  );
});

test('prompt set falls back to built-in prompts when files are absent', async () => {
  const empty = await mkdtemp(path.join(os.tmpdir(), 'harness-agents-empty-'));
  const prompts = await loadPromptSet(empty);
  assert.match(prompts.system, /implementation stage of a deterministic/);
  assert.match(prompts.system, /stories\.ts/);
  assert.match(prompts.system, /Playwright/);
  assert.match(prompts.specifier, /specification stage of a deterministic/);
});

test('default agents directory mirrors the built-in prompts', async () => {
  const fromFiles = await loadPromptSet(defaultAgentsDirectory);
  const builtin = await loadPromptSet(await mkdtemp(path.join(os.tmpdir(), 'harness-agents-x-')));
  assert.equal(fromFiles.system, builtin.system);
  assert.equal(fromFiles.specifier, builtin.specifier);
});
