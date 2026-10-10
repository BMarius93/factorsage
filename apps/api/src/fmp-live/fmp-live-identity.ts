import {
  classifySecurityListing,
  SUPPORTED_EXCHANGE_CODES,
  type Security,
  type SecurityListingCandidate,
  type SecurityListingRejection,
} from "@intrinsic/domain";
import type {
  FmpSecurityCatalogPort,
  FmpSecurityScope,
  MappedFmpProfile,
  MappedFmpSecurityListing,
} from "@intrinsic/fmp";
import {
  CanonicalSecurityCatalogService,
  StockDataNotFoundError,
  type StockDataCache,
  type StockDataStore,
} from "@intrinsic/stock-data";

/**
 * From approved symbols to catalog securities.
 *
 * A symbol is not an identity. The loaders hydrate a `Security` — a catalog row with an id — and
 * `CanonicalStockDataService.getSecurity` is a catalog lookup that deliberately discovers nothing.
 * So a live run resolves every approved symbol through that lookup first, and binds the scope to
 * the securities it found: from then on the provider is asked about those identities and no
 * others.
 *
 * ## The one thing this mode does that production does not
 *
 * In production a `Security` comes into existence only through the catalog synchronization, which
 * asks the provider for every listing on every supported exchange. A live run may not do that —
 * it is exactly the universe-wide request this mode exists to forbid — and a fresh development
 * database (every Claude cloud session starts with one) has an empty catalog.
 *
 * {@link ApprovedSecurityListings} closes that gap without a second way of writing a security. It
 * is the catalog synchronization's own provider port, answered from the approved symbols'
 * profiles instead of from the exchange-wide screener: at most one `profile` request per symbol
 * the catalog does not hold, each inside the scope and the budget. The unchanged
 * `CanonicalSecurityCatalogService` then classifies and persists what it is given — the same
 * stock-only, supported-exchange rule and the same writer as the admin sync, so a later real sync
 * finds rows it recognises. Symbols the catalog already holds cost nothing and are never
 * re-admitted.
 */

export type LiveFmpAdmissionOutcome =
  | { readonly symbol: string; readonly outcome: "LISTED" }
  /** The provider has no profile under this symbol. */
  | { readonly symbol: string; readonly outcome: "UNKNOWN_TO_PROVIDER" }
  /** The provider answered for another symbol; that security was not approved. */
  | {
      readonly symbol: string;
      readonly outcome: "ANSWERED_AS_ANOTHER_SYMBOL";
      readonly answered: string;
    }
  /** A real instrument this product does not support: a fund, or an unsupported exchange. */
  | {
      readonly symbol: string;
      readonly outcome: "UNSUPPORTED";
      readonly reason: SecurityListingRejection;
    };

type ProfileProvider = {
  getProfile(symbol: string): Promise<MappedFmpProfile | null>;
};

function listingOf(mapped: MappedFmpProfile): SecurityListingCandidate {
  const { security } = mapped;
  return {
    symbol: security.symbol,
    name: security.name,
    exchangeCode: security.exchangeCode,
    ...(security.exchangeName ? { exchangeName: security.exchangeName } : {}),
    ...(security.country ? { country: security.country } : {}),
    ...(security.sector ? { sector: security.sector } : {}),
    ...(security.industry ? { industry: security.industry } : {}),
    isEtf: security.type === "ETF",
    isFund: security.type === "FUND",
    isActivelyTrading: security.isActivelyTrading,
  };
}

/**
 * The catalog port, for the approved symbols only.
 *
 * `getStockUniverse(exchange)` returns the approved symbols listed on that exchange and nothing
 * else. Their profiles are read once, on the first call, however many exchanges are asked about.
 *
 * A profile that answers under a different symbol than the one asked is not listed. The provider
 * may well be right that the two are one company, but the security it names was not approved, and
 * a run asks about nothing its operator did not name.
 */
export class ApprovedSecurityListings implements FmpSecurityCatalogPort {
  private loaded:
    | Promise<{
        listings: MappedFmpSecurityListing[];
        outcomes: LiveFmpAdmissionOutcome[];
      }>
    | undefined;

  constructor(
    private readonly provider: ProfileProvider,
    private readonly symbols: readonly string[],
  ) {}

  async getStockUniverse(
    exchangeCode: string,
  ): Promise<MappedFmpSecurityListing[]> {
    const exchange = exchangeCode.trim().toUpperCase();
    const { listings } = await this.load();
    return listings.filter(
      ({ listing }) => listing.exchangeCode.trim().toUpperCase() === exchange,
    );
  }

  /** What became of each symbol. Meaningful once a universe has been asked for. */
  async outcomes(): Promise<readonly LiveFmpAdmissionOutcome[]> {
    return (await this.load()).outcomes;
  }

  private load() {
    this.loaded ??= this.read();
    return this.loaded;
  }

  private async read() {
    const listings: MappedFmpSecurityListing[] = [];
    const outcomes: LiveFmpAdmissionOutcome[] = [];
    for (const symbol of this.symbols) {
      const mapped = await this.provider.getProfile(symbol);
      if (mapped === null) {
        outcomes.push({ symbol, outcome: "UNKNOWN_TO_PROVIDER" });
        continue;
      }
      if (mapped.providerSymbol !== symbol) {
        outcomes.push({
          symbol,
          outcome: "ANSWERED_AS_ANOTHER_SYMBOL",
          answered: mapped.providerSymbol,
        });
        continue;
      }
      const listing = listingOf(mapped);
      // Reported here, decided by the catalog service: this only explains its decision.
      const decision = classifySecurityListing(listing);
      outcomes.push(
        decision.supported
          ? { symbol, outcome: "LISTED" }
          : { symbol, outcome: "UNSUPPORTED", reason: decision.reason },
      );
      listings.push({ providerSymbol: symbol, listing });
    }
    return { listings, outcomes };
  }
}

/** Admits approved symbols the catalog does not hold, through the catalog synchronization itself. */
export async function admitApprovedSecurities(input: {
  readonly store: StockDataStore;
  readonly cache: Pick<StockDataCache, "setSecurity">;
  readonly provider: ProfileProvider;
  readonly symbols: readonly string[];
}): Promise<readonly LiveFmpAdmissionOutcome[]> {
  const listings = new ApprovedSecurityListings(input.provider, input.symbols);
  const { failures } = await new CanonicalSecurityCatalogService(
    input.store,
    listings,
    SUPPORTED_EXCHANGE_CODES,
    input.cache,
  ).sync();
  const [failure] = failures;
  if (failure) {
    throw new Error(
      `The security catalog could not persist ${failure.providerSymbol}`,
      { cause: failure.error },
    );
  }
  return listings.outcomes();
}

export type LiveFmpResolvedSecurity = {
  readonly symbol: string;
  readonly security: Security;
  /** Whether the catalog already held it, or this run admitted it. */
  readonly origin: "CATALOG" | "ADMITTED";
};

export type LiveFmpUnresolvedSymbol = {
  readonly symbol: string;
  readonly reason: string;
};

export type LiveFmpResolution = {
  readonly resolved: readonly LiveFmpResolvedSecurity[];
  readonly unresolved: readonly LiveFmpUnresolvedSymbol[];
};

function unresolvedReason(
  outcome: LiveFmpAdmissionOutcome | undefined,
): string {
  switch (outcome?.outcome) {
    case "UNKNOWN_TO_PROVIDER":
      return "the provider has no security under this symbol";
    case "ANSWERED_AS_ANOTHER_SYMBOL":
      return `the provider answers for ${outcome.answered}, which was not approved; name that symbol instead`;
    case "UNSUPPORTED":
      return outcome.reason === "NON_EQUITY"
        ? "it is a fund or ETF; only common stocks are supported"
        : outcome.reason === "UNSUPPORTED_EXCHANGE"
          ? `it is not listed on a supported exchange (${SUPPORTED_EXCHANGE_CODES.join(", ")})`
          : "the provider's listing for it is incomplete";
    case "LISTED":
      return "it was listed but the catalog does not hold it";
    case undefined:
      return "it is not in the security catalog";
  }
}

/**
 * Resolves every approved symbol to its catalog security and binds the scope to it.
 *
 * `admit` is how a symbol the catalog does not hold is admitted; a plan passes none, and reports
 * such a symbol as unresolved without asking anybody. A security is bound only when the symbol the
 * loader will send for it is the approved one, so what the scope authorizes and what the loader
 * asks for cannot drift apart.
 */
export async function resolveLiveFmpSecurities(input: {
  readonly symbols: readonly string[];
  readonly scope: Pick<FmpSecurityScope, "bind">;
  readonly getSecurity: (symbol: string) => Promise<Security>;
  readonly admit?: (
    symbols: readonly string[],
  ) => Promise<readonly LiveFmpAdmissionOutcome[]>;
}): Promise<LiveFmpResolution> {
  const lookup = async (symbol: string): Promise<Security | null> => {
    try {
      return await input.getSecurity(symbol);
    } catch (error) {
      if (error instanceof StockDataNotFoundError) {
        return null;
      }
      throw error;
    }
  };

  const found = new Map<string, LiveFmpResolvedSecurity>();
  const missing: string[] = [];
  for (const symbol of input.symbols) {
    const security = await lookup(symbol);
    if (security) {
      found.set(symbol, { symbol, security, origin: "CATALOG" });
    } else {
      missing.push(symbol);
    }
  }

  const outcomes = new Map<string, LiveFmpAdmissionOutcome>();
  if (missing.length > 0 && input.admit) {
    for (const outcome of await input.admit(missing)) {
      outcomes.set(outcome.symbol, outcome);
    }
    for (const symbol of missing) {
      const security = await lookup(symbol);
      if (security) {
        found.set(symbol, { symbol, security, origin: "ADMITTED" });
      }
    }
  }

  const resolved: LiveFmpResolvedSecurity[] = [];
  const unresolved: LiveFmpUnresolvedSymbol[] = [];
  for (const symbol of input.symbols) {
    const entry = found.get(symbol);
    if (!entry) {
      unresolved.push({
        symbol,
        reason: unresolvedReason(outcomes.get(symbol)),
      });
      continue;
    }
    if (entry.security.symbol.trim().toUpperCase() !== symbol) {
      unresolved.push({
        symbol,
        reason:
          `the catalog holds it as ${entry.security.symbol}, which is what the loader would ` +
          "ask the provider for and is not the approved symbol",
      });
      continue;
    }
    input.scope.bind({
      securityId: entry.security.id,
      providerSymbol: symbol,
    });
    resolved.push(entry);
  }
  return { resolved, unresolved };
}
