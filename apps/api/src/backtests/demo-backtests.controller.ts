import type { DemoBacktestListResponse } from "@intrinsic/contracts";
import { Controller, Get, Header, Inject } from "@nestjs/common";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import { BacktestSharingService } from "./backtest-sharing.service";

/**
 * The public shelf of demonstration backtests (`docs/decisions/entitlements-v2.md` §4).
 *
 * **No guard, on purpose**, exactly like the shared report it lists: a Guest reads precomputed
 * demonstrations instead of running anything, and no session, plan or Terms acceptance changes the
 * answer. Every entry is an operator-featured shared report, so this lists nothing a link does not
 * already publish, and reading it executes nothing.
 *
 * **`no-store`**, because revoking a featured run's link must take it off the shelf at once.
 */
@Controller("demo-backtests")
export class DemoBacktestsController {
  constructor(
    @Inject(BacktestSharingService)
    private readonly sharing: BacktestSharingService,
  ) {}

  @RateLimit("public-share-read")
  @Get()
  @Header("Cache-Control", "no-store")
  async list(): Promise<DemoBacktestListResponse> {
    return this.sharing.listDemos();
  }
}
