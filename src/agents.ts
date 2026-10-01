import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  developerPrompt,
  playwrightPrompt,
  specifierPrompt,
  storybookPrompt,
} from './prompts/index.js';

/** Default agent definitions shipped with the harness. */
export const defaultAgentsDirectory = fileURLToPath(new URL('../../agents/', import.meta.url));

export interface AgentDefinition {
  name: string;
  description?: string;
  skills: string[];
  /** Agent body followed by the body of each referenced skill. */
  prompt: string;
}

/** Prompts consumed by runHarness, resolved from .md files with code fallbacks. */
export interface PromptSet {
  /** System prompt for the Copilot session (developer agent + its skills). */
  system: string;
  /** Specification-stage instruction (specifier agent + its skills). */
  specifier: string;
}

interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

export async function loadAgentDefinition(
  directory: string,
  agentName: string,
): Promise<AgentDefinition> {
  const file = path.join(directory, `${agentName}.agent.md`);
  const { frontmatter, body } = parseMarkdown(await readFile(file, 'utf8'), file);
  const skills = readSkillList(frontmatter, file);
  const sections = [body.trim()];
  for (const skill of skills) {
    const skillFile = path.join(directory, 'skills', `${skill}.md`);
    let content: string;
    try {
      content = await readFile(skillFile, 'utf8');
    } catch {
      throw new Error(`Agent ${agentName} references missing skill: ${skillFile}`);
    }
    sections.push(parseMarkdown(content, skillFile).body.trim());
  }
  return {
    name: typeof frontmatter.name === 'string' ? frontmatter.name : agentName,
    ...(typeof frontmatter.description === 'string'
      ? { description: frontmatter.description }
      : {}),
    skills,
    prompt: sections.filter(Boolean).join('\n\n'),
  };
}

/**
 * Loads the stage prompts from agent .md files. Missing files fall back to the
 * built-in prompts in src/prompts so a partial agents directory stays valid.
 */
export async function loadPromptSet(directory?: string): Promise<PromptSet> {
  const root = directory
    ?? process.env.HARNESS_AGENTS_DIR
    ?? defaultAgentsDirectory;
  return {
    system: await agentPrompt(root, 'developer', builtinDeveloperPrompt()),
    specifier: await agentPrompt(root, 'specifier', specifierPrompt.trim()),
  };
}

async function agentPrompt(
  directory: string,
  agentName: string,
  fallback: string,
): Promise<string> {
  try {
    return (await loadAgentDefinition(directory, agentName)).prompt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

function builtinDeveloperPrompt(): string {
  return [developerPrompt, storybookPrompt, playwrightPrompt]
    .map(prompt => prompt.trim())
    .join('\n\n');
}

function parseMarkdown(content: string, file: string): ParsedMarkdown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  const frontmatter = parse(match[1] ?? '') as unknown;
  if (frontmatter !== null && (typeof frontmatter !== 'object' || Array.isArray(frontmatter))) {
    throw new Error(`${file} frontmatter must be a YAML mapping`);
  }
  return {
    frontmatter: (frontmatter ?? {}) as Record<string, unknown>,
    body: content.slice(match[0].length),
  };
}

function readSkillList(frontmatter: Record<string, unknown>, file: string): string[] {
  if (frontmatter.skills === undefined) return [];
  if (!Array.isArray(frontmatter.skills)
    || frontmatter.skills.some(skill => typeof skill !== 'string' || !skill.trim())) {
    throw new Error(`${file} frontmatter "skills" must be a list of skill names`);
  }
  return (frontmatter.skills as string[]).map(skill => skill.trim());
}
