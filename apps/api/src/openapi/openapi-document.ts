import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { parse } from "yaml";

/** Repository root — the directory holding `pnpm-workspace.yaml`. */
function workspaceRoot(startDirectory = process.cwd()): string {
  let current = resolve(startDirectory);
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Could not locate the workspace root");
    }
    current = parent;
  }
}

/** The one checked-in OpenAPI document, relative to the repository root. */
export const OPENAPI_DOCUMENT_PATH = "docs/openapi.yaml";

export function openApiDocumentPath(startDirectory = process.cwd()): string {
  return join(workspaceRoot(startDirectory), OPENAPI_DOCUMENT_PATH);
}

export function readOpenApiSource(startDirectory = process.cwd()): string {
  return readFileSync(openApiDocumentPath(startDirectory), "utf8");
}

export type OpenApiOperation = {
  readonly operationId?: string;
  readonly summary?: string;
  readonly security?: Array<Record<string, unknown>>;
  readonly responses?: Record<string, unknown>;
  readonly "x-rate-limit"?: {
    readonly policy?: string;
    readonly exempt?: boolean;
    readonly reason?: string;
  };
  readonly [key: string]: unknown;
};

export type OpenApiDocument = {
  readonly openapi: string;
  readonly info: Record<string, unknown> & {
    readonly "x-rate-limit-policies"?: Record<
      string,
      {
        actor: string;
        points: number;
        durationSeconds: number;
        onRedisFailure: string;
        description: string;
        secondary?: { actor: string; points: number; durationSeconds: number };
      }
    >;
  };
  readonly paths: Record<string, Record<string, OpenApiOperation>>;
  readonly components?: Record<string, unknown>;
};

export function loadOpenApiDocument(
  startDirectory = process.cwd(),
): OpenApiDocument {
  return parse(readOpenApiSource(startDirectory)) as OpenApiDocument;
}

const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

/**
 * Every documented operation as `METHOD /path`, with Nest's `:param` spelling rather than
 * OpenAPI's `{param}` so it can be compared directly with the mounted route table.
 */
export function documentedOperations(
  document: OpenApiDocument,
): Map<string, OpenApiOperation> {
  const operations = new Map<string, OpenApiOperation>();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation) {
        operations.set(`${method.toUpperCase()} ${toNestPath(path)}`, operation);
      }
    }
  }
  return operations;
}

/** `/lists/{listId}` -> `/lists/:listId`. */
export function toNestPath(openApiPath: string): string {
  return openApiPath.replace(/\{([^}]+)\}/g, ":$1");
}

/** `/lists/:listId` -> `/lists/{listId}`. */
export function toOpenApiPath(nestPath: string): string {
  return nestPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}
