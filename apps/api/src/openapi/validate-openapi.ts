/**
 * `pnpm openapi:validate` — validates `docs/openapi.yaml` against the official OpenAPI 3.1 schema.
 *
 * Deliberately separate from the contract suite. This answers "is the document a valid OpenAPI 3.1
 * document at all" — well-formed YAML, every `$ref` resolvable, no invalid keyword — while
 * `openapi.contract.test.ts` answers "does it describe *this* API". A malformed document would make
 * the second question unanswerable, so it is worth being able to ask the first on its own, from a
 * shell, without a test runner or a database.
 */
import { Validator } from "@seriousme/openapi-schema-validator";
import { openApiDocumentPath, readOpenApiSource } from "./openapi-document";

async function main(): Promise<void> {
  const path = openApiDocumentPath();
  const validator = new Validator();
  const result = await validator.validate(readOpenApiSource());

  if (!result.valid) {
    process.stderr.write(`OpenAPI document is invalid: ${path}\n`);
    process.stderr.write(`${JSON.stringify(result.errors, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  // An unresolvable `$ref` is not a schema violation, so it passes validation and then breaks every
  // consumer — a generator, a mock server, Swagger UI. Resolving the whole document is what catches
  // a component that was referenced but never written.
  await validator.resolveRefs();

  const specification = validator.specification as { paths?: object } | undefined;
  const operationCount = Object.keys(specification?.paths ?? {}).length;
  process.stdout.write(
    `OpenAPI ${validator.version} document is valid: ${path} (${operationCount} paths)\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `OpenAPI validation failed: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
