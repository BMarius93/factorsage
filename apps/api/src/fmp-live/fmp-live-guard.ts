import {
  FMP_ENDPOINT_CLASSES,
  FmpRequestRefusedError,
  normalizeFmpSymbol,
  type FmpRequestBudget,
  type FmpRequestDescriptor,
  type FmpRequestGuard,
  type FmpRequestRefusalReason,
  type FmpSecurityScope,
} from "@intrinsic/fmp";

/**
 * The guard a live run's one `FmpClient` is built with: the security scope, the request budget and
 * the ledger the end-of-run report is written from.
 *
 * It sits at the client's single request chokepoint, so it does not matter which loader, helper or
 * retry asked: a request about anything but an approved, resolved security is refused before the
 * key is read, and a request beyond the budget is refused inside the gate's slot before it is
 * sent.
 *
 * **It fails closed, and stays closed.** The first refusal of any kind closes the guard: every
 * later request is refused without consulting the scope or the budget. A refusal means either the
 * budget is spent or some path asked for something outside the run — after either, nothing the
 * run goes on to store could be called complete, so nothing more is asked of the provider.
 *
 * The ledger holds endpoint names, symbols and counts. It never holds a response, and the
 * descriptor it is given never held the key.
 */

export type LiveFmpRefusal = {
  readonly reason: FmpRequestRefusalReason;
  readonly endpoint: string;
  /** The symbol the request named, when it named exactly one well-formed symbol. */
  readonly symbol: string | null;
  /** Requests refused for this reason, endpoint and symbol, the first included. */
  readonly count: number;
};

export type LiveFmpRequestCount = {
  readonly symbol: string;
  readonly dataset: string;
  readonly endpoint: string;
  readonly requests: number;
};

export type LiveFmpLedger = {
  /** Requests that reached the network, retries included. Equal to the budget spent. */
  readonly sent: number;
  /** Distinct requests the loaders made; `sent - authorized` is what retries cost. */
  readonly authorized: number;
  readonly budget: number;
  readonly byRequest: readonly LiveFmpRequestCount[];
  readonly refusals: readonly LiveFmpRefusal[];
  readonly budgetExhausted: boolean;
};

function symbolOf(request: FmpRequestDescriptor): string | null {
  const raw = Object.hasOwn(request.query, "symbol")
    ? request.query.symbol
    : undefined;
  return raw === undefined ? null : normalizeFmpSymbol(raw);
}

export class LiveFmpRunGuard implements FmpRequestGuard {
  private authorized = 0;
  private sent = 0;
  private closedBy: FmpRequestRefusalReason | null = null;
  private budgetExhausted = false;
  private readonly counts = new Map<string, LiveFmpRequestCount>();
  private readonly refusals = new Map<string, LiveFmpRefusal>();

  constructor(
    private readonly scope: FmpSecurityScope,
    private readonly budget: FmpRequestBudget,
  ) {}

  authorize(request: FmpRequestDescriptor): void {
    this.assertOpen(request);
    try {
      this.scope.authorize(request);
    } catch (error) {
      throw this.refuse(request, error);
    }
    this.authorized += 1;
  }

  async admitAttempt(request: FmpRequestDescriptor): Promise<void> {
    // A request authorized before the guard closed may still be waiting in the gate's queue.
    this.assertOpen(request);
    try {
      await this.budget.consume();
    } catch (error) {
      if (error instanceof FmpRequestRefusedError) {
        throw this.refuse(request, error);
      }
      // Redis could not say whether a unit is left. Nothing is sent on a guess.
      throw error;
    }
    this.sent += 1;
    const symbol = symbolOf(request) ?? "";
    const key = `${symbol} ${request.path}`;
    const existing = this.counts.get(key);
    this.counts.set(key, {
      symbol,
      dataset: FMP_ENDPOINT_CLASSES.get(request.path)?.dataset ?? request.path,
      endpoint: request.path,
      requests: (existing?.requests ?? 0) + 1,
    });
  }

  /** Whether any request was refused. A run with a refusal is never a success. */
  get refused(): boolean {
    return this.refusals.size > 0;
  }

  get exhausted(): boolean {
    return this.budgetExhausted;
  }

  ledger(): LiveFmpLedger {
    return {
      sent: this.sent,
      authorized: this.authorized,
      budget: this.budget.limit,
      byRequest: [...this.counts.values()].sort(
        (left, right) =>
          left.symbol.localeCompare(right.symbol) ||
          left.dataset.localeCompare(right.dataset) ||
          left.endpoint.localeCompare(right.endpoint),
      ),
      refusals: [...this.refusals.values()],
      budgetExhausted: this.budgetExhausted,
    };
  }

  private assertOpen(request: FmpRequestDescriptor): void {
    if (this.closedBy !== null) {
      throw this.record(
        request,
        new FmpRequestRefusedError(
          "GUARD_CLOSED",
          `The live run's provider guard closed after an earlier refusal (${this.closedBy}); ` +
            "nothing further is sent",
        ),
      );
    }
  }

  /** Records a refusal, closes the guard and returns the error to throw. */
  private refuse(request: FmpRequestDescriptor, error: unknown): unknown {
    if (!(error instanceof FmpRequestRefusedError)) {
      return error;
    }
    this.closedBy ??= error.reason;
    if (error.reason === "BUDGET_EXHAUSTED") {
      this.budgetExhausted = true;
    }
    return this.record(request, error);
  }

  private record(
    request: FmpRequestDescriptor,
    error: FmpRequestRefusedError,
  ): FmpRequestRefusedError {
    const symbol = symbolOf(request);
    const key = `${error.reason} ${request.path} ${symbol ?? ""}`;
    const existing = this.refusals.get(key);
    this.refusals.set(key, {
      reason: error.reason,
      endpoint: request.path,
      symbol,
      count: (existing?.count ?? 0) + 1,
    });
    return error;
  }
}
