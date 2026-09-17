import {
  SYSTEM_CONTENT_PROTECTED_CODE,
  SYSTEM_CONTENT_READ_ONLY_CODE,
} from "@intrinsic/contracts";
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from "@nestjs/common";
import type { Response } from "express";
import {
  SystemContentProtectedError,
  SystemContentReadOnlyError,
} from "./content-access";

/**
 * The one place a refusal to change built-in content becomes HTTP, for every feature controller.
 *
 * - A non-administrator changing a built-in: `403` with `SYSTEM_CONTENT_READ_ONLY`. The object is
 *   readable by everyone, so answering "not found" would be untrue.
 * - Deleting a built-in: `409` with `SYSTEM_CONTENT_PROTECTED`. Built-ins are never deleted —
 *   bootstrap would only recreate them — and an administrator unpublishes or pauses one instead.
 */
@Catch(SystemContentReadOnlyError, SystemContentProtectedError)
export class SystemContentExceptionFilter implements ExceptionFilter {
  catch(
    error: SystemContentReadOnlyError | SystemContentProtectedError,
    host: ArgumentsHost,
  ): void {
    const response = host.switchToHttp().getResponse<Response>();
    const readOnly = error instanceof SystemContentReadOnlyError;
    const status = readOnly ? HttpStatus.FORBIDDEN : HttpStatus.CONFLICT;
    response.status(status).json({
      statusCode: status,
      message: error.message,
      code: readOnly
        ? SYSTEM_CONTENT_READ_ONLY_CODE
        : SYSTEM_CONTENT_PROTECTED_CODE,
    });
  }
}
