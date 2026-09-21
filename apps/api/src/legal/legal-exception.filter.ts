import { LegalError } from "@intrinsic/contracts";
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
import { LEGAL_LOGGER } from "./legal.tokens";

/**
 * The one place a legal-gate refusal becomes HTTP.
 *
 * Registered globally, exactly like `EntitlementExceptionFilter` and `BillingExceptionFilter`, so
 * every refusal answers identically in the machine-readable shape the rest of the API uses:
 * `statusCode`, a human `message` and a stable `code` a client branches on.
 *
 * `403` for a missing acceptance, never `401`: the caller is authenticated and their session is
 * perfectly valid. Answering `401` would make every client sign them out, which is precisely the
 * loop a compliance gate must not create — the remedy is to accept, not to sign in again.
 *
 * `400` for a version mismatch: the request is the thing that is wrong, and it is fixable by
 * resubmitting with the version the response names.
 */
@Catch(LegalError)
export class LegalExceptionFilter implements ExceptionFilter {
  constructor(
    @Inject(LEGAL_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  catch(error: LegalError, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();

    const status =
      error.detail.code === "LEGAL_ACCEPTANCE_REQUIRED"
        ? HttpStatus.FORBIDDEN
        : HttpStatus.BAD_REQUEST;

    this.logger.info({
      event: "legal.request.refused",
      actorUserId: request.authUser?.id ?? null,
      code: error.detail.code,
      operation: `${request.method} ${request.route?.path ?? request.path}`,
      requiredTermsVersion: error.detail.requiredTermsVersion ?? null,
    });

    response.status(status).json({
      statusCode: status,
      message: error.message,
      code: error.detail.code,
      ...(error.detail.requiredTermsVersion
        ? { requiredTermsVersion: error.detail.requiredTermsVersion }
        : {}),
    });
  }
}
