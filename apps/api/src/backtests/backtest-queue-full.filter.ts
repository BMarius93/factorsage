import { BACKTEST_QUEUE_FULL_CODE, RATE_LIMIT_HEADERS } from "@intrinsic/contracts";
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from "@nestjs/common";
import type { Response } from "express";
import { BacktestQueueFullError } from "./backtests.service";

/**
 * A full deployment-wide backtest queue, as HTTP: `503` with a `Retry-After` and a stable code.
 *
 * `503` rather than `429`: the caller exceeded nothing of their own — their plan allows the run and
 * they are under every rate limit — the deployment simply has more waiting work than it accepts.
 * `Retry-After` is already exposed to the browser for the rate-limit family, so the web app can
 * say when to try again. Nothing was created, so a retry is always safe.
 */
@Catch(BacktestQueueFullError)
export class BacktestQueueFullFilter implements ExceptionFilter {
  catch(error: BacktestQueueFullError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader(RATE_LIMIT_HEADERS.retryAfter, String(error.retryAfterSeconds));
    response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      message: error.message,
      code: BACKTEST_QUEUE_FULL_CODE,
      retryAfterSeconds: error.retryAfterSeconds,
    });
  }
}
