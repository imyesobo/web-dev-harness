import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

export async function loadOpenApi(file: string): Promise<unknown> {
  const document = parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  if (
    !document
    || typeof document !== 'object'
    || typeof document.openapi !== 'string'
    || !document.openapi.startsWith('3.')
  ) {
    throw new Error(`${file} is not an OpenAPI 3 document`);
  }
  return {
    openapi: document.openapi,
    info: document.info,
    servers: document.servers,
    paths: document.paths,
    schemas: (document.components as Record<string, unknown> | undefined)?.schemas,
  };
}
