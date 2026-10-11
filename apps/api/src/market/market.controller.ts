import type { MarketOverviewResponse } from "@intrinsic/contracts";
import { Controller, Get, Header, Inject } from "@nestjs/common";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import { MarketService } from "./market.service";

/**
 * The ETF market overview the Dashboard reports above its signals.
 *
 * Deliberately **not** under `/dashboard`: nothing here depends on who is asking, and a second
 * surface that wants the same numbers should read this rather than a viewer-scoped read model that
 * happens to carry them. It carries no session at all — no guard, no cookie, nothing stored — so a
 * Guest and a signed-in customer are served the identical body.
 *
 * `standard-read`: the summary is computed at most once a minute from stored data and never asks the
 * market-data provider, so it is a system read rather than a hydrating stock read.
 *
 * `private`: the body is the same for everybody, but the response also carries the caller's own
 * rate-limit headers, which a shared cache must never hand to someone else. The browser may reuse it
 * for as long as the server reuses its summary.
 */
@Controller("market-overview")
export class MarketController {
  constructor(@Inject(MarketService) private readonly market: MarketService) {}

  @RateLimit("standard-read")
  @Header("Cache-Control", "private, max-age=60")
  @Get()
  async overview(): Promise<MarketOverviewResponse> {
    return this.market.getMarketOverview();
  }
}
