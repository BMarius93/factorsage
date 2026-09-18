import "reflect-metadata";
import { RATE_LIMIT_HEADER_NAMES } from "@intrinsic/contracts";
import { getApiConfig, loadRootEnv } from "@intrinsic/config";
import {
  createLogger,
  type StructuredLogger,
} from "@intrinsic/observability";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { installHttpObservability } from "./observability/http-observability";
import { NestStructuredLogger } from "./observability/nest-structured-logger";
import { installSecurityHeaders } from "./security-headers";

let logger: StructuredLogger = createLogger({
  service: "api",
  level: "info",
  environment: process.env.NODE_ENV ?? "development",
});

async function bootstrap() {
  loadRootEnv();
  const config = getApiConfig();
  logger = createLogger({
    service: "api",
    level: config.logLevel,
    environment: config.environment,
  });
  logger.info({ event: "api.bootstrap.started", port: config.port });

  const app = await NestFactory.create(AppModule, {
    logger: new NestStructuredLogger(logger.child({ component: "nestjs" })),
    // Keeps the untouched request bytes on `request.rawBody` alongside the parsed body.
    //
    // Required by exactly one route: `POST /webhooks/stripe`. A Stripe signature covers the precise
    // payload Stripe sent, so verifying against a body that has been parsed and re-serialized —
    // different key order, different number formatting — always fails. Every other route reads the
    // parsed body as before.
    rawBody: true,
  });
  installHttpObservability(app, logger.child({ component: "http" }));
  installSecurityHeaders(app, config.environment);
  app.enableShutdownHooks();
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    // The web app is a different origin, so a browser can read only the headers listed here. The
    // rate-limit family has to be on it or `Retry-After` is invisible to the client that needs it
    // most — the one being throttled. The list comes from the contract, so adding a header there
    // exposes it here without a second edit.
    exposedHeaders: [...RATE_LIMIT_HEADER_NAMES, "x-request-id"],
  });

  await app.listen(config.port);
  logger.info({
    event: "api.started",
    port: config.port,
    environment: config.environment,
  });
}

/**
 * A rejection or exception nothing caught is fatal — Node already exits on it — but without these
 * handlers the only record is an unstructured stack trace on stderr, invisible to a log query. The
 * failure is logged through the same structured logger as everything else, and the process still
 * exits so an orchestrator restarts it rather than serving from an unknown state.
 */
process.on("unhandledRejection", (reason: unknown) => {
  logger.fatal({ event: "api.unhandled-rejection", err: reason });
  process.exit(1);
});
process.on("uncaughtException", (err: unknown) => {
  logger.fatal({ event: "api.uncaught-exception", err });
  process.exit(1);
});

void bootstrap().catch((err: unknown) => {
  logger.fatal({ event: "api.bootstrap.failed", err });
  process.exitCode = 1;
});
