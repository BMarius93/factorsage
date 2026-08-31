import {
  classifySecurityListing,
  SECURITY_LISTING_REJECTIONS,
  securityCatalogFieldsChanged,
  SUPPORTED_EXCHANGE_CODES,
  type Security,
  type SecurityListingRejection,
} from "@intrinsic/domain";
import type { FmpSecurityCatalogPort } from "@intrinsic/fmp";
import type { SecurityCatalogEntry, StockDataStore } from "./ports.js";

/**
 * Rows inserted per `createMany`. Large enough that a full universe is a handful of statements,
 * small enough that isolating a failing row after a batch error re-tries only a bounded slice.
 */
const CATALOG_CREATE_CHUNK = 500;

export type SecurityCatalogSyncSummary = {
  /** Rows returned by the provider across every supported exchange. */
  received: number;
  created: number;
  /**
   * Rows whose catalog fields differed from what was persisted and were rewritten.
   * `deactivated` is a subset of this count, not a separate outcome.
   */
  updated: number;
  unchanged: number;
  /** Updated rows that went from actively trading to not actively trading. */
  deactivated: number;
  /** Rows the provider returned that this product does not support. */
  skipped: number;
  /** Rows that were supported but could not be persisted. */
  failed: number;
};

export type SecurityCatalogSyncFailure = {
  providerSymbol: string;
  error: unknown;
};

export type SecurityCatalogSyncResult = {
  summary: SecurityCatalogSyncSummary;
  /**
   * Per-row persistence failures, carrying the original error so the caller can log it without
   * this layer taking a dependency on a logger.
   */
  failures: SecurityCatalogSyncFailure[];
  /** Counts by rejection reason, so "skipped" is explainable rather than a bare number. */
  skippedByReason: Record<SecurityListingRejection, number>;
};

/** Every rejection reason starts at zero, so an absent reason reads as "none" rather than missing. */
function emptySkippedByReason(): Record<SecurityListingRejection, number> {
  return Object.fromEntries(
    SECURITY_LISTING_REJECTIONS.map((reason) => [reason, 0]),
  ) as Record<SecurityListingRejection, number>;
}

function emptySummary(): SecurityCatalogSyncSummary {
  return {
    received: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    deactivated: 0,
    skipped: 0,
    failed: 0,
  };
}

/**
 * Synchronizes the canonical `Security` catalog from the provider's bulk universe.
 *
 * This is the only way a `Security` comes into existence. It is identity-only: no prices, no
 * fundamentals, no derived state, no Redis history — admitting a stock to the catalog says the
 * product supports it, not that its history has been loaded.
 *
 * Persistence is deliberately incremental rather than one transaction. A universe sync touches
 * thousands of unrelated rows, and a single malformed listing must not roll back every other
 * correction; each row's outcome is reported instead.
 */
export class CanonicalSecurityCatalogService {
  constructor(
    private readonly store: StockDataStore,
    private readonly provider: FmpSecurityCatalogPort,
    private readonly exchangeCodes: readonly string[] = SUPPORTED_EXCHANGE_CODES,
  ) {}

  async sync(): Promise<SecurityCatalogSyncResult> {
    const summary = emptySummary();
    const failures: SecurityCatalogSyncFailure[] = [];
    const skippedByReason = emptySkippedByReason();

    const supported = new Map<string, SecurityCatalogEntry>();
    for (const exchangeCode of this.exchangeCodes) {
      const listings = await this.provider.getStockUniverse(exchangeCode);
      summary.received += listings.length;
      for (const { providerSymbol, listing } of listings) {
        const decision = classifySecurityListing(listing);
        if (!decision.supported) {
          skippedByReason[decision.reason] += 1;
          summary.skipped += 1;
          continue;
        }
        // A symbol listed twice upstream must not be counted twice or written twice; last wins.
        supported.set(providerSymbol, {
          providerSymbol,
          security: decision.security,
        });
      }
    }

    const entries = [...supported.values()];
    const persisted = new Map<string, Security>(
      (
        await this.store.findSecurityCatalogEntries(
          entries.map((entry) => entry.providerSymbol),
        )
      ).map((entry) => [entry.providerSymbol, entry.security]),
    );

    const toCreate: SecurityCatalogEntry[] = [];
    const toUpdate: SecurityCatalogEntry[] = [];
    for (const entry of entries) {
      const existing = persisted.get(entry.providerSymbol);
      if (!existing) {
        toCreate.push(entry);
        continue;
      }
      if (!securityCatalogFieldsChanged(existing, entry.security)) {
        summary.unchanged += 1;
        continue;
      }
      toUpdate.push(entry);
      if (existing.isActivelyTrading && !entry.security.isActivelyTrading) {
        summary.deactivated += 1;
      }
    }

    summary.created += await this.createEntries(toCreate, summary, failures);

    for (const entry of toUpdate) {
      try {
        await this.store.updateSecurityCatalogEntry(entry);
        summary.updated += 1;
      } catch (error) {
        summary.failed += 1;
        failures.push({ providerSymbol: entry.providerSymbol, error });
      }
    }

    return { summary, failures, skippedByReason };
  }

  private async createEntries(
    entries: readonly SecurityCatalogEntry[],
    summary: SecurityCatalogSyncSummary,
    failures: SecurityCatalogSyncFailure[],
  ): Promise<number> {
    let created = 0;
    for (let start = 0; start < entries.length; start += CATALOG_CREATE_CHUNK) {
      const chunk = entries.slice(start, start + CATALOG_CREATE_CHUNK);
      try {
        created += await this.store.createSecurityCatalogEntries(chunk);
      } catch {
        // The batch says nothing about which row was bad, so replay it one at a time. That turns
        // an opaque chunk failure into an exact list of failed symbols and keeps every healthy
        // row in the chunk.
        for (const entry of chunk) {
          try {
            created += await this.store.createSecurityCatalogEntries([entry]);
          } catch (error) {
            summary.failed += 1;
            failures.push({ providerSymbol: entry.providerSymbol, error });
          }
        }
      }
    }
    return created;
  }
}

/**
 * Catalog synchronization boundary. The API depends on this rather than on the concrete service so
 * logging can decorate it the same way the stock-data read boundary is decorated.
 */
export interface SecurityCatalogService {
  sync(): Promise<SecurityCatalogSyncResult>;
}
