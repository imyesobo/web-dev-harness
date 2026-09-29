export interface FigmaClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
}

export class FigmaClient {
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor({ token, fetchImpl = fetch }: FigmaClientOptions) {
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  async getDesign(fileKey: string, nodeIds?: readonly string[]): Promise<unknown> {
    const suffix = nodeIds?.length
      ? `/nodes?ids=${encodeURIComponent(nodeIds.join(','))}`
      : '';
    const response = await this.#fetch(
      `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}${suffix}`,
      { headers: { 'X-Figma-Token': this.#token } },
    );
    if (!response.ok) {
      throw new Error(`Figma API failed (${response.status}): ${await response.text()}`);
    }
    return extractDesign(await response.json());
  }
}

function extractDesign(value: unknown): unknown {
  const root = value as Record<string, unknown>;
  const nodes = root.nodes && typeof root.nodes === 'object'
    ? Object.fromEntries(
      Object.entries(root.nodes as Record<string, unknown>).map(([id, node]) => {
        const details = node as Record<string, unknown>;
        return [id, compactNode(details.document ?? details)];
      }),
    )
    : undefined;
  return {
    name: root.name,
    styles: root.styles,
    components: root.components,
    document: root.document ? compactNode(root.document) : nodes,
  };
}

function compactNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactNode);
  if (!value || typeof value !== 'object') return value;
  const node = value as Record<string, unknown>;
  const retained = [
    'id', 'name', 'type', 'visible', 'layoutMode', 'primaryAxisSizingMode',
    'counterAxisSizingMode', 'itemSpacing', 'paddingLeft', 'paddingRight',
    'paddingTop', 'paddingBottom', 'absoluteBoundingBox', 'fills', 'strokes',
    'effects', 'cornerRadius', 'style', 'characters', 'componentId',
  ];
  return Object.fromEntries(
    retained
      .filter(key => node[key] !== undefined)
      .map(key => [key, compactNode(node[key])])
      .concat(node.children ? [['children', compactNode(node.children)]] : []),
  );
}
