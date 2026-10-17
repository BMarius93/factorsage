import {
  classifySecurityListing,
  SUPPORTED_EXCHANGE_CODES,
  type SecurityListingCandidate,
} from "@intrinsic/domain";
import type {
  FmpSecurityCatalogPort,
  MappedFmpSecurityListing,
} from "@intrinsic/fmp";
import {
  CanonicalSecurityCatalogService,
  type AdmissionOutcome,
  type IndexUniverseAdmitter,
  type IndexUniverseListing,
  type StockDataCache,
  type StockDataStore,
} from "@intrinsic/stock-data";

/**
 * Admits the securities an index resolution chose, through the catalog's one writer.
 *
 * In production a `Security` comes into existence through the exchange-wide catalog
 * synchronization. That synchronization cannot admit a former constituent: the screener lists what
 * trades today, and an index universe is mostly companies that no longer do. So the resolution's
 * chosen listings — from each symbol's own profile, or, for a delisted symbol the provider holds no
 * profile for, from its delisted directory row — are handed to the unchanged
 * `CanonicalSecurityCatalogService` as its provider port. The same admission rule applies (common
 * stock on a supported exchange) and the same writer creates the row, so a later catalog sync finds
 * rows it recognises. A symbol the catalog already holds is never re-admitted.
 */
class ChosenListings implements FmpSecurityCatalogPort {
  constructor(private readonly listings: readonly MappedFmpSecurityListing[]) {}

  async getStockUniverse(exchangeCode: string): Promise<MappedFmpSecurityListing[]> {
    const exchange = exchangeCode.trim().toUpperCase();
    return this.listings.filter(
      ({ listing }) => listing.exchangeCode.trim().toUpperCase() === exchange,
    );
  }
}

function candidateOf(listing: IndexUniverseListing): SecurityListingCandidate {
  return {
    symbol: listing.symbol,
    name: listing.name,
    exchangeCode: listing.exchangeCode ?? "",
    isEtf: listing.isEtf,
    isFund: listing.isFund,
    isActivelyTrading: listing.isActivelyTrading,
  };
}

export function catalogAdmitter(input: {
  readonly store: StockDataStore;
  readonly cache: Pick<StockDataCache, "setSecurity">;
}): IndexUniverseAdmitter {
  return async (listings) => {
    const outcomes: AdmissionOutcome[] = [];
    const toAdmit: MappedFmpSecurityListing[] = [];
    for (const listing of listings) {
      const existing = await input.store.findSecurityByProviderSymbol(listing.symbol);
      if (existing) {
        outcomes.push({ symbol: listing.symbol, securityId: existing.id });
        continue;
      }
      const candidate = candidateOf(listing);
      const decision = classifySecurityListing(candidate);
      if (!decision.supported) {
        outcomes.push({
          symbol: listing.symbol,
          securityId: null,
          reason: `the catalog does not admit it (${decision.reason}; listed on ${listing.exchangeCode ?? "an unknown exchange"} per the ${listing.source === "PROFILE" ? "profile" : "delisted directory"})`,
        });
        continue;
      }
      toAdmit.push({ providerSymbol: listing.symbol, listing: candidate });
    }
    if (toAdmit.length > 0) {
      const { failures } = await new CanonicalSecurityCatalogService(
        input.store,
        new ChosenListings(toAdmit),
        SUPPORTED_EXCHANGE_CODES,
        input.cache,
      ).sync();
      const failed = new Map(failures.map((failure) => [failure.providerSymbol, failure]));
      for (const { providerSymbol } of toAdmit) {
        const created = await input.store.findSecurityByProviderSymbol(providerSymbol);
        if (created) {
          outcomes.push({ symbol: providerSymbol, securityId: created.id });
        } else {
          const failure = failed.get(providerSymbol);
          outcomes.push({
            symbol: providerSymbol,
            securityId: null,
            reason: failure
              ? `the catalog could not persist it: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`
              : "the catalog did not create it",
          });
        }
      }
    }
    return outcomes;
  };
}
