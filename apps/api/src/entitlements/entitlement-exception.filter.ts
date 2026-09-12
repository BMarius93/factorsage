import { EntitlementError } from "@intrinsic/contracts";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Inject,
} from "@nestjs/common";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../auth/authenticated-request";
import { ENTITLEMENTS_LOGGER } from "./entitlements.tokens";

/**
 * The one place an entitlement refusal becomes HTTP.
 *
 * Registered globally, so every controller, every route and every internal service that throws an
 * `EntitlementError` answers identically — and a new enforcement point cannot forget to map it.
 * The feature controllers' own `execute()` helpers rethrow what they do not recognize, which is
 * exactly what lets this filter be the single mapping.
 *
 * `403 Forbidden`, never `400`: the request is well-formed and the caller is authenticated: they
 * are simply not entitled. Telling them to fix their input would send them round a loop they
 * cannot exit. The exception is `ENTITLEMENT_AUTH_REQUIRED`, which answers `401` because the
 * remedy really is to sign in.
 *
 * The body carries the machine-readable `code` plus the numbers behind it, so a UI can say "your
 * plan allows 10, this list has 83" without parsing the message. Server logic never reads the
 * message.
 */
@Catch(EntitlementError)
export class EntitlementExceptionFilter implements ExceptionFilter {
  constructor(
    @Inject(ENTITLEMENTS_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  catch(error: EntitlementError, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();

    const status =
      error.detail.code === "ENTITLEMENT_AUTH_REQUIRED"
        ? HttpStatus.UNAUTHORIZED
        : HttpStatus.FORBIDDEN;

    this.logger.info({
      event: "entitlement.denied",
      actorUserId: request.authUser?.id ?? null,
      code: error.detail.code,
      tier: error.detail.tier,
      operation: `${request.method} ${request.route?.path ?? request.path}`,
      limit: error.detail.limit ?? null,
      current: error.detail.current ?? null,
      requested: error.detail.requested ?? null,
    });

    response.status(status).json({
      statusCode: status,
      message: error.message,
      ...error.detail,
    });
  }
}
