import {
  FMP_ENDPOINT_CLASSES,
  FmpRequestRefusedError,
  normalizeFmpSymbol,
  type FmpRequestBudget,
  type FmpRequestDescriptor,
  type FmpRequestGuard,
} from "@intrinsic/fmp";

/**
 * What an index-universe run may ask the provider (`docs/decisions/sp500-historical-pit-v1.md` §6).
 *
 * The run is owner-authorized and large — about a thousand securities' full histories — so its
 * limits are a scope and a budget rather than a security count:
 *
 * - **Directories:** the index's own membership endpoints, the rename history and the delisted
 *   directory, and the exchange calendar the loaders' finality reads. Never the exchange-wide
 *   screener, never the Congress member directory.
 * - **Securities:** only symbols the canonical membership names — the resolution's candidate tickers
 *   while resolving, the resolved securities' provider symbols while ingesting. The set is fixed when
 *   the guard is built, from PostgreSQL, and nothing can add to it.
 * - **Budget:** every attempt that reaches the network spends one unit, retries included; when it is
 *   spent the guard closes and the run stops, leaving what it stored resumable.
 *
 * It keeps counts per endpoint and never a response or the key.
 */

const DIRECTORY_ENDPOINTS = new Set([
  "sp500-constituent",
  "historical-sp500-constituent",
  "symbol-change",
  "delisted-companies",
]);

const EXCHANGE_ENDPOINTS = new Set(["holidays-by-exchange"]);

export type IndexUniverseGuardLedger = {
  readonly sent: number;
  readonly authorized: number;
  readonly budget: number;
  readonly byEndpoint: Readonly<Record<string, number>>;
  readonly refusals: readonly { reason: string; endpoint: string; symbol: string | null }[];
  readonly closed: boolean;
};

export class IndexUniverseRequestGuard implements FmpRequestGuard {
  private readonly symbols: ReadonlySet<string>;
  private authorizedCount = 0;
  private sentCount = 0;
  private readonly endpointCounts = new Map<string, number>();
  private readonly refused: { reason: string; endpoint: string; symbol: string | null }[] =
    [];
  private closedBy: string | null = null;

  constructor(
    symbols: Iterable<string>,
    private readonly budget: FmpRequestBudget,
  ) {
    const normalized = new Set<string>();
    for (const raw of symbols) {
      const symbol = normalizeFmpSymbol(raw);
      if (symbol) {
        normalized.add(symbol);
      }
    }
    this.symbols = normalized;
  }

  get scopeSize(): number {
    return this.symbols.size;
  }

  authorize(request: FmpRequestDescriptor): void {
    if (this.closedBy !== null) {
      this.refuse("GUARD_CLOSED", request);
    }
    const endpoint = FMP_ENDPOINT_CLASSES.get(request.path);
    if (!endpoint) {
      this.refuse("UNKNOWN_ENDPOINT", request);
    }
    if (endpoint?.subject === "DIRECTORY") {
      if (!DIRECTORY_ENDPOINTS.has(request.path)) {
        this.refuse("NOT_A_SECURITY_ENDPOINT", request);
      }
    } else if (endpoint?.subject === "EXCHANGE") {
      if (!EXCHANGE_ENDPOINTS.has(request.path)) {
        this.refuse("NOT_A_SECURITY_ENDPOINT", request);
      }
    } else {
      const raw = request.query.symbol;
      const symbol = typeof raw === "string" ? normalizeFmpSymbol(raw) : null;
      if (!symbol || "symbols" in request.query || "exchange" in request.query) {
        this.refuse("MALFORMED_REQUEST", request);
      }
      if (!this.symbols.has(symbol as string)) {
        this.refuse("SECURITY_NOT_APPROVED", request);
      }
    }
    this.authorizedCount += 1;
  }

  async admitAttempt(request: FmpRequestDescriptor): Promise<void> {
    if (this.closedBy !== null) {
      this.refuse("GUARD_CLOSED", request);
    }
    try {
      await this.budget.consume();
    } catch (error) {
      this.closedBy = "BUDGET_EXHAUSTED";
      this.refused.push({
        reason: "BUDGET_EXHAUSTED",
        endpoint: request.path,
        symbol: request.query.symbol ?? null,
      });
      throw error;
    }
    this.sentCount += 1;
    this.endpointCounts.set(
      request.path,
      (this.endpointCounts.get(request.path) ?? 0) + 1,
    );
  }

  /** Whether a refusal closed the guard: nothing more will be asked in this run. */
  get closed(): boolean {
    return this.closedBy !== null;
  }

  ledger(): IndexUniverseGuardLedger {
    return {
      sent: this.sentCount,
      authorized: this.authorizedCount,
      budget: this.budget.limit,
      byEndpoint: Object.fromEntries([...this.endpointCounts.entries()].sort()),
      refusals: [...this.refused],
      closed: this.closed,
    };
  }

  private refuse(
    reason:
      | "GUARD_CLOSED"
      | "UNKNOWN_ENDPOINT"
      | "NOT_A_SECURITY_ENDPOINT"
      | "MALFORMED_REQUEST"
      | "SECURITY_NOT_APPROVED",
    request: FmpRequestDescriptor,
  ): never {
    this.refused.push({
      reason,
      endpoint: request.path,
      symbol: request.query.symbol ?? null,
    });
    // An out-of-scope request is a defect in whatever asked for it: stop rather than carry on.
    this.closedBy ??= reason;
    throw new FmpRequestRefusedError(
      reason,
      `The index-universe run refused ${request.path}${request.query.symbol ? ` for ${request.query.symbol}` : ""} (${reason})`,
    );
  }
}
