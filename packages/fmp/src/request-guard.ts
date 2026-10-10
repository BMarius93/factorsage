import { FmpProviderError } from "./client.js";

/**
 * The seam a deliberately restricted run places **below** every provider method.
 *
 * `FmpClient` reaches the provider through one private `request(path, query)`, so a guard asked
 * there sees every request the client can make — whichever public method, loader, helper or retry
 * caused it — and nothing above it can route around it. Production composition roots pass no guard
 * and the client behaves exactly as it did before this existed.
 *
 * It is not the request gate. `FmpRequestGate` decides **when** a request may start (concurrency,
 * the rate window, a shared cooldown) and deliberately does not know what the request is. A guard
 * decides **whether** it may be made at all, from the endpoint and its query, and how many may be
 * made in total. Both apply: a guarded request still waits in the one shared gate.
 */

/** One provider request, as the guard sees it. The API key is never part of it. */
export type FmpRequestDescriptor = {
  /** Endpoint path relative to the provider's base, e.g. `historical-price-eod/full`. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
};

export interface FmpRequestGuard {
  /**
   * Asked once per logical request, before the key is read, before the gate is entered and before
   * any attempt. A throw refuses the request: nothing is queued and nothing is sent. Retries of an
   * authorized request are not asked again, so authorization is a property of the request and
   * never something a retry can use up.
   */
  authorize(request: FmpRequestDescriptor): void;
  /**
   * Asked once per HTTP attempt, inside the gate's slot, immediately before the request is sent.
   * A throw means that attempt never reaches the network. This is where a total request budget is
   * spent: one unit per request actually sent, a retry included, and none for a request that was
   * still waiting in the gate's queue when the gate gave up.
   */
  admitAttempt(request: FmpRequestDescriptor): Promise<void>;
}

export const FMP_REQUEST_REFUSAL_REASONS = [
  /** The endpoint is not one this client is known to call. */
  "UNKNOWN_ENDPOINT",
  /** The endpoint answers for an exchange or a caller-supplied list, never for one security. */
  "NOT_A_SECURITY_ENDPOINT",
  /** A per-security endpoint asked without exactly one well-formed symbol. */
  "MALFORMED_REQUEST",
  /** The symbol is not one of the securities this run was approved for. */
  "SECURITY_NOT_APPROVED",
  /** The symbol is approved but has not been resolved to a catalog security yet. */
  "SECURITY_NOT_RESOLVED",
  /** The run's total request budget is spent. */
  "BUDGET_EXHAUSTED",
  /** An earlier refusal closed the guard; nothing more is asked of the provider in this run. */
  "GUARD_CLOSED",
] as const;

export type FmpRequestRefusalReason =
  (typeof FMP_REQUEST_REFUSAL_REASONS)[number];

/**
 * A request a guard refused before it reached the network.
 *
 * A provider error, so every loader that already handles "the provider did not answer" handles it,
 * and non-retryable, so the client's retry loop ends on it instead of asking again.
 */
export class FmpRequestRefusedError extends FmpProviderError {
  constructor(
    readonly reason: FmpRequestRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "FmpRequestRefusedError";
  }
}

export class FmpRequestBudgetExhaustedError extends FmpRequestRefusedError {
  constructor(readonly limit: number) {
    super(
      "BUDGET_EXHAUSTED",
      `The provider request budget of ${limit} is spent; no further request is sent`,
    );
    this.name = "FmpRequestBudgetExhaustedError";
  }
}

/**
 * A hard cap on the provider requests one run may send.
 *
 * `consume` is the whole contract: it either takes exactly one unit or throws
 * {@link FmpRequestBudgetExhaustedError} and takes nothing, atomically, so concurrent callers can
 * never take more than `limit` between them.
 */
export interface FmpRequestBudget {
  readonly limit: number;
  /** Takes one request from the budget and returns how many have now been taken. */
  consume(): Promise<number>;
  used(): Promise<number>;
}

/**
 * What one request of an endpoint is about.
 *
 * - `SECURITY` — exactly one symbol, named by the `symbol` parameter;
 * - `SYMBOL_LIST` — as many symbols as the caller puts in one parameter;
 * - `EXCHANGE` — a whole venue: its listings or its calendar.
 */
export type FmpEndpointSubject = "SECURITY" | "SYMBOL_LIST" | "EXCHANGE";

export type FmpEndpointClass = {
  readonly subject: FmpEndpointSubject;
  /** The dataset the endpoint feeds, in the product's own vocabulary. */
  readonly dataset: string;
};

/**
 * Every endpoint `FmpClient` asks, classified.
 *
 * A provider fact, so it lives beside the client: `request-guard.test.ts` reads `client.ts` and
 * fails when a request path appears there that is not classified here. An endpoint nobody
 * classified is refused by a scope anyway ({@link FmpSecurityScope} denies by default); the test
 * exists so that adding one is a decision rather than a silent refusal found during a run.
 */
export const FMP_ENDPOINT_CLASSES: ReadonlyMap<string, FmpEndpointClass> =
  new Map<string, FmpEndpointClass>([
    ["profile", { subject: "SECURITY", dataset: "SECURITY_PROFILE" }],
    [
      "historical-price-eod/full",
      { subject: "SECURITY", dataset: "DAILY_PRICE" },
    ],
    ["splits", { subject: "SECURITY", dataset: "STOCK_SPLIT" }],
    [
      "income-statement",
      { subject: "SECURITY", dataset: "FINANCIAL_STATEMENTS" },
    ],
    [
      "balance-sheet-statement",
      { subject: "SECURITY", dataset: "FINANCIAL_STATEMENTS" },
    ],
    [
      "cash-flow-statement",
      { subject: "SECURITY", dataset: "FINANCIAL_STATEMENTS" },
    ],
    [
      "insider-trading/search",
      { subject: "SECURITY", dataset: "INSIDER_TRANSACTIONS" },
    ],
    ["senate-trades", { subject: "SECURITY", dataset: "CONGRESS_TRADES" }],
    ["house-trades", { subject: "SECURITY", dataset: "CONGRESS_TRADES" }],
    ["company-screener", { subject: "EXCHANGE", dataset: "SECURITY_CATALOG" }],
    [
      "holidays-by-exchange",
      { subject: "EXCHANGE", dataset: "EXCHANGE_CALENDAR" },
    ],
    ["batch-quote", { subject: "SYMBOL_LIST", dataset: "CURRENT_QUOTE" }],
  ]);

/** The endpoint that resolves a symbol to an identity, and so the only one an unresolved symbol may ask. */
export const FMP_IDENTITY_ENDPOINT = "profile";

/**
 * Parameters that widen a request beyond one security. A per-security endpoint carrying one is
 * refused rather than trusted to ignore it.
 */
const WIDENING_PARAMETERS = ["symbols", "exchange"] as const;

/** The symbol shape the canonical loader accepts (`CanonicalStockDataService.getSecurity`). */
export const FMP_SYMBOL_PATTERN = /^[A-Z0-9.-]{1,20}$/;

/** A symbol in its one canonical spelling, or `null` when it is not a symbol at all. */
export function normalizeFmpSymbol(raw: string): string | null {
  const symbol = raw.trim().toUpperCase();
  return FMP_SYMBOL_PATTERN.test(symbol) ? symbol : null;
}

/** A catalog security, as far as a scope needs to know it. */
export type FmpScopedSecurity = {
  /** The canonical `Security.id`. */
  readonly securityId: string;
  /** The symbol the loader sends the provider for it. */
  readonly providerSymbol: string;
};

/**
 * The securities one run may ask the provider about, and nothing else.
 *
 * Built once from the approved symbols and never widened: there is no method that adds one. The
 * constructor counts them itself, so the limit holds for whoever constructs a scope — a command
 * line that already checked, or a helper that did not.
 *
 * **Identity, not spelling, is what is approved.** A symbol starts as a candidate. A candidate may
 * be asked for exactly one thing, its `profile`, which is how a symbol the catalog does not know
 * yet is resolved. Every other dataset is refused until the candidate has been bound to the
 * catalog `Security` it resolved to ({@link bind}), and a symbol can be bound to one security
 * only. So no dataset is ever fetched for a raw string, and two references to one security are one
 * entry here however many times they were named.
 *
 * `authorize` is a pure check: asking twice, or retrying, changes nothing and uses nothing up.
 */
export class FmpSecurityScope {
  readonly maxSecurities: number;
  private readonly bound = new Map<string, string | undefined>();

  constructor(symbols: readonly string[], options: { maxSecurities: number }) {
    if (!Number.isInteger(options.maxSecurities) || options.maxSecurities < 1) {
      throw new Error("maxSecurities must be a positive integer");
    }
    this.maxSecurities = options.maxSecurities;
    for (const raw of symbols) {
      const symbol = normalizeFmpSymbol(raw);
      if (symbol === null) {
        throw new FmpRequestRefusedError(
          "MALFORMED_REQUEST",
          "A provider scope can only be built from well-formed symbols",
        );
      }
      this.bound.set(symbol, undefined);
    }
    if (this.bound.size === 0) {
      throw new FmpRequestRefusedError(
        "SECURITY_NOT_APPROVED",
        "A provider scope needs at least one approved security",
      );
    }
    if (this.bound.size > this.maxSecurities) {
      throw new FmpRequestRefusedError(
        "SECURITY_NOT_APPROVED",
        `A provider scope holds at most ${this.maxSecurities} securities; ` +
          `${this.bound.size} distinct symbols were given`,
      );
    }
  }

  /** The approved symbols, in the order they were given. */
  get symbols(): readonly string[] {
    return [...this.bound.keys()];
  }

  /** The securities resolved so far, one entry per identity. */
  get securities(): readonly FmpScopedSecurity[] {
    const securities: FmpScopedSecurity[] = [];
    for (const [providerSymbol, securityId] of this.bound) {
      if (securityId !== undefined) {
        securities.push({ securityId, providerSymbol });
      }
    }
    return securities;
  }

  /**
   * Records the catalog security an approved symbol resolved to.
   *
   * It can only confirm an identity for a symbol that was approved at construction; it cannot
   * approve another. Binding the same security again is a no-op, and a symbol already bound to one
   * security is never re-pointed at a second.
   */
  bind(security: FmpScopedSecurity): void {
    const symbol = normalizeFmpSymbol(security.providerSymbol);
    if (symbol === null || !this.bound.has(symbol)) {
      throw new FmpRequestRefusedError(
        "SECURITY_NOT_APPROVED",
        "Only an approved symbol can be bound to a security",
      );
    }
    if (security.securityId.trim() === "") {
      throw new FmpRequestRefusedError(
        "SECURITY_NOT_RESOLVED",
        "A symbol can only be bound to a resolved security",
      );
    }
    const existing = this.bound.get(symbol);
    if (existing !== undefined && existing !== security.securityId) {
      throw new FmpRequestRefusedError(
        "SECURITY_NOT_APPROVED",
        `${symbol} is already bound to another security`,
      );
    }
    for (const [other, securityId] of this.bound) {
      if (other !== symbol && securityId === security.securityId) {
        throw new FmpRequestRefusedError(
          "SECURITY_NOT_APPROVED",
          `${symbol} and ${other} resolve to one security; it is approved once, as ${other}`,
        );
      }
    }
    this.bound.set(symbol, security.securityId);
  }

  /** Refuses any request that is not about one approved, resolved security. */
  authorize(request: FmpRequestDescriptor): void {
    const endpoint = FMP_ENDPOINT_CLASSES.get(request.path);
    if (endpoint === undefined) {
      throw new FmpRequestRefusedError(
        "UNKNOWN_ENDPOINT",
        `'${request.path}' is not an endpoint this scope knows; refused`,
      );
    }
    if (endpoint.subject !== "SECURITY") {
      throw new FmpRequestRefusedError(
        "NOT_A_SECURITY_ENDPOINT",
        `'${request.path}' answers for ${
          endpoint.subject === "EXCHANGE"
            ? "a whole exchange"
            : "a caller-supplied list of symbols"
        }, not for one approved security; refused`,
      );
    }
    for (const parameter of WIDENING_PARAMETERS) {
      if (Object.hasOwn(request.query, parameter)) {
        throw new FmpRequestRefusedError(
          "MALFORMED_REQUEST",
          `'${request.path}' was asked with '${parameter}', which names more than one security; refused`,
        );
      }
    }
    const raw = Object.hasOwn(request.query, "symbol")
      ? request.query.symbol
      : undefined;
    const symbol = raw === undefined ? null : normalizeFmpSymbol(raw);
    if (symbol === null) {
      throw new FmpRequestRefusedError(
        "MALFORMED_REQUEST",
        `'${request.path}' was asked without exactly one well-formed symbol; refused`,
      );
    }
    if (!this.bound.has(symbol)) {
      throw new FmpRequestRefusedError(
        "SECURITY_NOT_APPROVED",
        `${symbol} is not one of the ${this.bound.size} approved securities; refused`,
      );
    }
    if (
      this.bound.get(symbol) === undefined &&
      request.path !== FMP_IDENTITY_ENDPOINT
    ) {
      throw new FmpRequestRefusedError(
        "SECURITY_NOT_RESOLVED",
        `${symbol} has not been resolved to a catalog security; only its ` +
          `${FMP_IDENTITY_ENDPOINT} may be asked before that`,
      );
    }
  }
}
