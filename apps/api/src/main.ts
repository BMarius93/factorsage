import "reflect-metadata";
import { getApiConfig, loadRootEnv } from "@intrinsic/config";
import {
  createLogger,
  type StructuredLogger,
} from "@intrinsic/observability";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { installHttpObservability } from "./observability/http-observability";
import { NestStructuredLogger } from "./observability/nest-structured-logger";

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
  });
  installHttpObservability(app, logger.child({ component: "http" }));
  app.enableShutdownHooks();
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
  });

  await app.listen(config.port);
  logger.info({
    event: "api.started",
    port: config.port,
    environment: config.environment,
  });
}

void bootstrap().catch((err: unknown) => {
  logger.fatal({ event: "api.bootstrap.failed", err });
  process.exitCode = 1;
});
