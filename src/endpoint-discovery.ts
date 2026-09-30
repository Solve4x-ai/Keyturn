import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

type OpenApiOperation = {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
};

type OpenApiDocument = {
  info?: {
    title?: string;
    version?: string;
  };
  paths?: Record<string, Record<string, OpenApiOperation>>;
};

export type EndpointSummary = {
  method: string;
  path: string;
  operationId: string | null;
  summary: string;
  tags: string[];
  readOnlyHttpMethod: boolean;
  executable: false;
};

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

function defaultSpecPath(): string {
  return fileURLToPath(new URL('../spec/NinjaRMM-API-v2.json', import.meta.url));
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function endpointKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export class EndpointCatalog {
  private readonly specPath: string;
  private readonly spec: OpenApiDocument;
  private readonly hash: string;
  private readonly endpoints: Array<EndpointSummary & { description: string; operation: OpenApiOperation }>;

  constructor(specPath = process.env.NINJA_API_SPEC_PATH || defaultSpecPath()) {
    this.specPath = specPath;
    const raw = readFileSync(specPath, 'utf8');
    this.hash = createHash('sha256').update(raw).digest('hex');
    this.spec = JSON.parse(raw) as OpenApiDocument;
    this.endpoints = [];

    for (const [path, pathItem] of Object.entries(this.spec.paths || {})) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method.toLowerCase()) || !operation || typeof operation !== 'object') {
          continue;
        }
        this.endpoints.push({
          method: method.toUpperCase(),
          path,
          operationId: operation.operationId || null,
          summary: normalizeText(operation.summary),
          description: normalizeText(operation.description),
          tags: Array.isArray(operation.tags) ? operation.tags : [],
          readOnlyHttpMethod: method.toLowerCase() === 'get',
          executable: false,
          operation,
        });
      }
    }
  }

  metadata() {
    return {
      title: this.spec.info?.title || 'NinjaOne API',
      version: this.spec.info?.version || 'unknown',
      sha256: this.hash,
      endpointCount: this.endpoints.length,
      specPath: this.specPath,
      mode: 'discovery-only',
      executionEnabled: false,
    };
  }

  find(query = '', category?: string, method?: string, limit = 20) {
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 20, 1), 50);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const categoryLower = category?.toLowerCase();
    const methodUpper = method?.toUpperCase();

    const results = this.endpoints
      .filter((endpoint) => !methodUpper || endpoint.method === methodUpper)
      .filter((endpoint) =>
        !categoryLower || endpoint.tags.some((tag) => tag.toLowerCase() === categoryLower),
      )
      .map((endpoint) => {
        const haystack = [
          endpoint.method,
          endpoint.path,
          endpoint.operationId || '',
          endpoint.summary,
          endpoint.description,
          ...endpoint.tags,
        ].join(' ').toLowerCase();
        const score = terms.length === 0
          ? 1
          : terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        return { endpoint, score };
      })
      .filter(({ score }) => terms.length === 0 || score > 0)
      .sort((a, b) =>
        b.score - a.score ||
        a.endpoint.path.localeCompare(b.endpoint.path) ||
        a.endpoint.method.localeCompare(b.endpoint.method),
      )
      .slice(0, safeLimit)
      .map(({ endpoint }) => ({
        method: endpoint.method,
        path: endpoint.path,
        operationId: endpoint.operationId,
        summary: endpoint.summary,
        tags: endpoint.tags,
        readOnlyHttpMethod: endpoint.readOnlyHttpMethod,
        executable: false as const,
      }));

    return {
      catalog: this.metadata(),
      query,
      category: category || null,
      method: methodUpper || null,
      count: results.length,
      results,
      note: 'Discovery does not execute API requests. New endpoints require explicit review and implementation.',
    };
  }

  describe(endpoint: string) {
    const normalized = endpoint.trim().replace(/\s+/, ' ');
    const match = this.endpoints.find(
      (candidate) => endpointKey(candidate.method, candidate.path).toLowerCase() === normalized.toLowerCase(),
    );
    if (!match) {
      return {
        found: false,
        endpoint: normalized,
        catalog: this.metadata(),
        note: 'Use find_endpoint to locate the exact METHOD /path value.',
      };
    }

    return {
      found: true,
      catalog: this.metadata(),
      endpoint: endpointKey(match.method, match.path),
      operationId: match.operationId,
      summary: match.summary,
      description: match.description,
      tags: match.tags,
      parameters: match.operation.parameters || [],
      requestBody: match.operation.requestBody || null,
      responses: match.operation.responses || {},
      readOnlyHttpMethod: match.readOnlyHttpMethod,
      executable: false,
      note: 'Description only. This tool cannot execute the endpoint.',
    };
  }
}

