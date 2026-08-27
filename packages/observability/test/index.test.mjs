import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  createLogger,
  runWithLogContext,
  setLogContext,
} = require("../dist/index.js");

function capture() {
  const chunks = [];
  return {
    sink: {
      write(chunk) {
        chunks.push(String(chunk));
      },
    },
    records() {
      return chunks.map((chunk) => JSON.parse(chunk));
    },
  };
}

test("filters by configured log level", () => {
  const stdout = capture();
  const stderr = capture();
  const logger = createLogger({
    service: "test",
    level: "info",
    stdout: stdout.sink,
    stderr: stderr.sink,
    now: () => new Date("2026-08-27T12:00:00.000Z"),
  });

  logger.debug({ event: "hidden" });
  logger.info({ event: "visible" });

  assert.equal(stdout.records().length, 1);
  assert.equal(stdout.records()[0].event, "visible");
  assert.equal(stderr.records().length, 0);
});

test("propagates correlation context and can attach the authenticated actor", async () => {
  const stdout = capture();
  const logger = createLogger({ service: "api", level: "debug", stdout: stdout.sink });

  await runWithLogContext(
    { requestId: "req-1", correlationId: "corr-1" },
    async () => {
      await Promise.resolve();
      assert.equal(setLogContext({ actorUserId: "user-1" }), true);
      logger.info({ event: "request.completed" });
    },
  );

  const [record] = stdout.records();
  assert.equal(record.requestId, "req-1");
  assert.equal(record.correlationId, "corr-1");
  assert.equal(record.actorUserId, "user-1");
});

test("redacts sensitive fields and serializes errors", () => {
  const stderr = capture();
  const logger = createLogger({ service: "api", level: "trace", stderr: stderr.sink });

  logger.error({
    event: "request.failed",
    authorization: "Bearer secret",
    nested: { apiKey: "secret-key", safe: "ok" },
    err: new Error("boom"),
  });

  const [record] = stderr.records();
  assert.equal(record.authorization, "[REDACTED]");
  assert.equal(record.nested.apiKey, "[REDACTED]");
  assert.equal(record.nested.safe, "ok");
  assert.equal(record.err.name, "Error");
  assert.equal(record.err.message, "boom");
});
