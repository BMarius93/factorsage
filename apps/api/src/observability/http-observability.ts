import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import {
  runWithLogContext,
  type StructuredLogger,
} from "@intrinsic/observability";
import type { NextFunction, Request, Response } from "express";

const MAX_CORRELATION_ID_LENGTH = 128;

export function installHttpObservability(
  app: INestApplication,
  logger: StructuredLogger,
): void {
  app.use((request: Request, response: Response, next: NextFunction) => {
    const requestId = randomUUID();
    const correlationId =
      safeCorrelationId(request.headers["x-correlation-id"]) ?? requestId;
    const startedAt = Date.now();

    runWithLogContext({ requestId, correlationId }, () => {
      response.setHeader("x-request-id", requestId);
      response.setHeader("x-correlation-id", correlationId);

      const baseFields = {
        method: request.method,
        path: request.path,
      };
      logger.debug({ event: "http.request.started", ...baseFields });

      let settled = false;
      response.once("finish", () => {
        if (settled) {
          return;
        }
        settled = true;
        const fields = {
          event: "http.request.completed",
          ...baseFields,
          statusCode: response.statusCode,
          durationMs: Date.now() - startedAt,
        };
        if (response.statusCode >= 500) {
          logger.error(fields);
        } else if (response.statusCode >= 400) {
          logger.warn(fields);
        } else {
          logger.info(fields);
        }
      });

      response.once("close", () => {
        if (settled) {
          return;
        }
        settled = true;
        logger.warn({
          event: "http.request.aborted",
          ...baseFields,
          durationMs: Date.now() - startedAt,
        });
      });

      next();
    });
  });
}

function safeCorrelationId(value: string | string[] | undefined): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  const normalized = candidate?.trim();
  if (!normalized || normalized.length > MAX_CORRELATION_ID_LENGTH) {
    return undefined;
  }
  return /^[A-Za-z0-9._:-]+$/.test(normalized) ? normalized : undefined;
}
