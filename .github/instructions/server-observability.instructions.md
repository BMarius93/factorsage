---
applyTo: "apps/api/**/*.ts,apps/worker/**/*.ts,packages/stock-data/**/*.ts,packages/fmp/**/*.ts,packages/database/**/*.ts,packages/observability/**/*.ts"
---

For server-side changes, follow `ai/architecture/observability.md`.

- Use `@intrinsic/observability`; do not add ad-hoc `console.log`, `console.warn`, or `console.error` calls.
- Keep stable structured event names and include operational identifiers such as `symbol`, `runId`, or `jobId` when they materially identify the failing operation.
- Request-scoped `requestId`, `correlationId`, and authenticated `actorUserId` should come from the existing logging context rather than being threaded through business APIs only for logging.
- When an exception is caught and translated/wrapped into a generic API or domain error, log the original error object as `err` before losing it. This preserves `name`, `message`, and `stack`.
- Do not change business error semantics solely for logging and do not catch-and-ignore failures.
- Never log credentials, API keys, authorization headers, cookies, tokens, or complete sensitive request/response payloads.
- Use `info` for meaningful lifecycle outcomes, `debug` for operational detail, and `trace` only for intentionally high-volume diagnostics. Respect `LOG_LEVEL`.
