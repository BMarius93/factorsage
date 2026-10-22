import type {
  SharedBacktestPreviewResponse,
  SharedBacktestReportResponse,
} from "@intrinsic/contracts";
import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
} from "@nestjs/common";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import {
  BacktestSharingService,
  SharedBacktestNotFoundError,
} from "./backtest-sharing.service";

/**
 * The public, read-only half of backtest sharing (`docs/decisions/backtest-sharing-v1.md`).
 *
 * **No guard, on purpose.** The routes do not ask who the caller is, so no session, plan or Terms
 * acceptance can change the answer: a Guest, a Free user and a Pro user read the same report, and
 * a Starter user can read a Pro run far beyond their own limits. The token is the authorization —
 * 256 random bits, resolved on every request, so a revoked link stops answering at once.
 *
 * **`no-store`.** The report is cheap to read and revocation must be immediate, so no shared cache
 * may keep a copy past it. `X-Robots-Tag` keeps a link a person was sent out of search indexes:
 * sharing is a link, never a public directory.
 *
 * Every failure — a malformed, unknown or revoked token, a run without a result — is the same
 * `404` with the same message, so the routes reveal nothing about which tokens ever existed.
 */
@Controller("shared-backtests")
export class SharedBacktestsController {
  constructor(
    @Inject(BacktestSharingService)
    private readonly sharing: BacktestSharingService,
  ) {}

  @RateLimit("public-share-read")
  @Get(":token")
  @Header("Cache-Control", "no-store")
  @Header("X-Robots-Tag", "noindex, nofollow")
  async report(
    @Param("token") token: string,
  ): Promise<SharedBacktestReportResponse> {
    return this.found(() => this.sharing.readReport(token));
  }

  @RateLimit("public-share-read")
  @Get(":token/preview")
  @Header("Cache-Control", "no-store")
  @Header("X-Robots-Tag", "noindex, nofollow")
  async preview(
    @Param("token") token: string,
  ): Promise<SharedBacktestPreviewResponse> {
    return this.found(() => this.sharing.readPreview(token));
  }

  private async found<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SharedBacktestNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }
}
