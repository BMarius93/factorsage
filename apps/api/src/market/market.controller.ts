import type { MarketOverviewResponse } from "@intrinsic/contracts";
import { Controller, Get, Inject } from "@nestjs/common";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import { MarketService } from "./market.service";

/**
 * The market references the Dashboard reports above its signals.
 *
 * Deliberately **not** under `/dashboard`: nothing here depends on who is asking, and a second
 * surface that wants the same three numbers should read this rather than a viewer-scoped read model
 * that happens to carry them. It carries no session at all — no guard, no cookie, nothing stored —
 * so a Guest and a signed-in customer are served the identical bytes.
 *
 * `stock-read`, because a cold read may hydrate from the market-data provider; that is the policy
 * table's own rule for this kind of endpoint.
 */
@Controller("market-overview")
export class MarketController {
  constructor(@Inject(MarketService) private readonly market: MarketService) {}

  @RateLimit("stock-read")
  @Get()
  async overview(): Promise<MarketOverviewResponse> {
    return this.market.getMarketOverview();
  }
}
