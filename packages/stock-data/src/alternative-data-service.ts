import { createHash } from "node:crypto";
import type {
  AlternativeDataFactFilter,
  AlternativeDataMetric,
} from "@intrinsic/contracts";
import {
  alternativeDataMeasureDefinition,
  alternativeDataScope,
} from "@intrinsic/contracts";
import {
  deriveInstitutionalPositionEvents,
  isCongressTradeStrategyEligible,
  type CongressChamber,
  type InstitutionalFilingWithHoldings,
  type InstitutionalPositionChange,
  type LocalDate,
  type Security,
} from "@intrinsic/domain";
import {
  FMP_CONGRESS_TRADING_MAX_PAGE_SIZE,
  FMP_INSIDER_TRADING_MAX_PAGE_SIZE,
  FMP_INSTITUTIONAL_MAX_PAGE_SIZE,
  FmpEntitlementError,
  type FmpCongressTradingPort,
  type FmpInsiderTradingPort,
  type FmpInstitutionalOwnershipPort,
  type MappedFmpCongressTrade,
  type MappedFmpInsiderTrade,
  type MappedFmpInstitutionalHolding,
} from "@intrinsic/fmp";
import {
  alternativeDataRequests,
  type AlternativeDataFacts,
  type AlternativeDataObservation,
  type OperandKey,
} from "@intrinsic/strategy";
import {
  ALTERNATIVE_DATA_DOMAINS,
  type AlternativeDataDomain,
  type AlternativeDataStore,
  type CongressTradeWrite,
  type InsiderTransactionWrite,
  type InstitutionalFilingWrite,
} from "./alternative-data-ports.js";

/**
 * Loading and ingesting the alternative-data domains.
 *
 * It sits beside `CanonicalStockDataService` rather than inside it, and is composed into it, for the
 * same reason `CanonicalBenchmarkDataService` is separate: it reads different tables from a different
 * provider surface, and neither should grow the other's freshness logic. What it shares is everything
 * that matters — the same `FmpClient`, and therefore the same Redis provider gate and the same
 * rate-limit budget as every other request this product makes.
 *
 * ## What ingestion can and cannot promise
 *
 * None of the three provider endpoints accepts a date range (verified live on 2026-09-25: `from` and
 * `to` are silently ignored by `insider-trading/search`, and the congressional endpoints take no such
 * parameter at all). A bounded historical read is therefore impossible: history is reached by paging
 * backwards from the newest row. That has three consequences the whole slice is built around:
 *
 * 1. **Coverage has a floor, not a beginning of time.** The earliest availability date actually
 *    ingested is the earliest date a metric may report for. Before it the column is NOT_EVALUABLE,
 *    because "the provider had no filing" and "the dataset does not reach that far" are
 *    indistinguishable from the payload, and reporting zero would be a claim the data does not make.
 * 2. **Writes are content-addressed.** Ordering inside one disclosure date is not stable between
 *    calls, so a position-based cursor would skip and duplicate rows. Every row carries a digest of
 *    its meaningful fields and a unique constraint, which makes reingestion a no-op and an amendment
 *    a new row.
 * 3. **Two indistinguishable disclosures collapse.** The payloads carry no per-line identity, so two
 *    genuinely separate same-day trades by one actor with identical size, price and amount band become
 *    one row. Collapsing is the deterministic choice: the alternative is a row count that grows on
 *    every reingest.
 */

export type AlternativeDataProvider = FmpInsiderTradingPort &
  FmpCongressTradingPort &
  FmpInstitutionalOwnershipPort;

/** Why an ingest reached the provider, for the same structured log every other loader writes. */
export type AlternativeDataRequestEvent = {
  domain: AlternativeDataDomain;
  symbol: string;
  reason: "COLD" | "STALE";
  page: number;
  rows: number;
};

/**
 * A dataset this subscription cannot read.
 *
 * Reported rather than thrown: an unavailable domain leaves its coverage absent, so every metric that
 * reads it is NOT_EVALUABLE and no strategy can act on it. Failing the caller instead would take down
 * a backtest whose other conditions are perfectly evaluable, and returning an empty result would be
 * worse still — it would read as "no institution bought".
 */
export type AlternativeDataUnavailableEvent = {
  domain: AlternativeDataDomain;
  symbol: string;
  statusCode?: number;
  message: string;
};

export type AlternativeDataServiceOptions = {
  /** How long an ingest is trusted before the newest pages are re-read. */
  freshnessMs: number;
  /**
   * Pages one ingest may read per domain.
   *
   * A bound rather than a limit on history: at the providers' page caps this reaches thousands of
   * insider filings and every congressional disclosure a symbol has. It exists so one mis-paginating
   * endpoint cannot spend the whole provider allowance in a loop.
   */
  maxPagesPerIngest: number;
  /** Report quarters of 13F history one ingest reads, newest first. */
  institutionalQuarters: number;
  now?: () => Date;
  onProviderRequest?: (event: AlternativeDataRequestEvent) => void;
  onDatasetUnavailable?: (event: AlternativeDataUnavailableEvent) => void;
};

/**
 * Resolves an actor group's membership to canonical actor ids.
 *
 * Injected rather than always read from the database, because a backtest must resolve a group from the
 * **frozen membership in its own snapshot**: editing a group later may never change a run that already
 * exists. A live surface passes nothing and gets the database-backed default.
 */
export type ActorGroupMembershipResolver = (
  groupId: string,
) => Promise<readonly string[]>;

export type AlternativeDataFactRequest = {
  security: Security;
  operands: readonly OperandKey[];
  /** The availability window the frame covers, widened by the caller for the longest lookback. */
  from: LocalDate;
  to: LocalDate;
  resolveGroupMembers?: ActorGroupMembershipResolver;
};

/** The domain one alternative-data metric reads. */
export function alternativeDataDomainOf(
  metric: AlternativeDataMetric,
): AlternativeDataDomain {
  switch (metric.kind) {
    case "INSIDER_ACTIVITY":
      return "INSIDER";
    case "CONGRESS_ACTIVITY":
      return "CONGRESS";
    case "INSTITUTIONAL_ACTIVITY":
      return "INSTITUTIONAL";
  }
}

/** Every domain a set of operands needs ingested, in canonical order. */
export function alternativeDataDomainsFor(
  operands: readonly OperandKey[],
): AlternativeDataDomain[] {
  const domains = new Set<AlternativeDataDomain>();
  for (const { metric } of alternativeDataRequests(operands)) {
    domains.add(alternativeDataDomainOf(metric));
  }
  return ALTERNATIVE_DATA_DOMAINS.filter((domain) => domains.has(domain));
}

/** The position-change states one institutional fact filter selects. */
const INSTITUTIONAL_CHANGES: Readonly<
  Partial<
    Record<AlternativeDataFactFilter, readonly InstitutionalPositionChange[]>
  >
> = {
  INSTITUTIONAL_ACQUIRING: ["NEW", "INCREASED"],
  INSTITUTIONAL_REDUCING: ["REDUCED", "EXITED"],
  INSTITUTIONAL_NEW: ["NEW"],
  INSTITUTIONAL_EXITED: ["EXITED"],
  INSTITUTIONAL_ANY_CHANGE: [
    "NEW",
    "INCREASED",
    "REDUCED",
    "EXITED",
    "UNCHANGED",
  ],
};

/**
 * Field separator for a content digest: ASCII unit separator, which no provider text carries.
 *
 * A printable separator would let a value containing it forge a different row's digest — a company
 * name with a pipe in it, say — which would make two distinct disclosures collapse into one.
 */
const DIGEST_SEPARATOR = String.fromCharCode(31);

function digest(
  parts: readonly (string | number | undefined | null)[],
): string {
  return createHash("sha256")
    .update(
      parts
        .map((part) => (part === undefined || part === null ? "" : String(part)))
        .join(DIGEST_SEPARATOR),
    )
    .digest("hex");
}

/**
 * The identity of one insider disclosure.
 *
 * Over the **normalized meaningful fields**, not the whole provider row: hashing the raw payload would
 * make a new provider field, or a whitespace change, look like a new filing and duplicate history on
 * the next ingest.
 */
function insiderContentHash(row: MappedFmpInsiderTrade): string {
  return digest([
    row.filingDate,
    row.transactionDate,
    row.reportingCik,
    row.transactionTypeRaw,
    row.securitiesTransacted,
    row.price,
    row.securitiesOwned,
    row.securityName,
    row.formType,
    row.acquisitionOrDisposition,
    row.directOrIndirect,
  ]);
}

function congressContentHash(row: MappedFmpCongressTrade): string {
  return digest([
    row.chamber,
    row.actorExternalId,
    row.disclosureDate,
    row.transactionDate,
    row.transactionTypeRaw,
    row.ownerRaw,
    row.assetTypeRaw,
    row.assetDescription,
    row.amountRangeRaw,
    row.sourceUrl,
  ]);
}

/**
 * The identity of one 13F filing.
 *
 * It covers the holdings as well as the filing header, because an amendment restating a share count is
 * a different statement about the same period and must be a new row rather than a silent no-op.
 */
function institutionalFilingContentHash(
  actorExternalId: string,
  reportPeriod: LocalDate,
  filingDate: LocalDate,
  amendmentType: string | undefined,
  holdings: readonly { securityId: string; shares: number }[],
): string {
  return digest([
    actorExternalId,
    reportPeriod,
    filingDate,
    amendmentType,
    ...[...holdings]
      .sort((left, right) => left.securityId.localeCompare(right.securityId))
      .flatMap((holding) => [holding.securityId, holding.shares]),
  ]);
}

export class CanonicalAlternativeDataService {
  private readonly now: () => Date;

  constructor(
    private readonly store: AlternativeDataStore,
    private readonly provider: AlternativeDataProvider,
    private readonly options: AlternativeDataServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Makes the alternative-data history one security needs resident, once per domain.
   *
   * Called from the same place a backtest's `PREPARING_DATA` phase hydrates prices, and from a Monitor
   * cycle's per-symbol preparation. A domain inside its freshness window is skipped entirely, so a
   * second run of one backtest makes no provider request at all.
   *
   * It never throws for a dataset this subscription cannot read: that is reported and the domain is
   * left without coverage, which makes its metrics NOT_EVALUABLE rather than zero.
   */
  async ensureIngested(
    security: Security,
    domains: readonly AlternativeDataDomain[],
  ): Promise<void> {
    for (const domain of domains) {
      const state = await this.store.getAlternativeDatasetState(
        security.id,
        domain,
      );
      const lastSync = state?.lastSuccessfulSyncAt ?? null;
      const fresh =
        lastSync !== null &&
        this.now().getTime() - Date.parse(lastSync) < this.options.freshnessMs;
      if (fresh) {
        continue;
      }
      const reason = lastSync === null ? "COLD" : "STALE";
      try {
        if (domain === "INSIDER") {
          await this.ingestInsider(security, reason);
        } else if (domain === "CONGRESS") {
          await this.ingestCongress(security, reason);
        } else {
          await this.ingestInstitutional(security, reason);
        }
      } catch (error) {
        if (error instanceof FmpEntitlementError) {
          this.options.onDatasetUnavailable?.({
            domain,
            symbol: security.symbol,
            ...(error.statusCode === undefined
              ? {}
              : { statusCode: error.statusCode }),
            message: error.message,
          });
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * The observations and coverage every alternative-data operand in a frame needs.
   *
   * One read per operand, each bounded to the frame's availability window and to the scope the metric
   * configured. Scope resolution happens here and not in the pure evaluator, because a group is either
   * a database read or a frozen snapshot and an evaluator must not be able to tell the difference.
   */
  async loadFacts(
    request: AlternativeDataFactRequest,
  ): Promise<Map<OperandKey, AlternativeDataFacts>> {
    const facts = new Map<OperandKey, AlternativeDataFacts>();
    const requests = alternativeDataRequests(request.operands);
    if (requests.length === 0) {
      return facts;
    }

    // One dataset-state read per domain, not per operand: a strategy naming four insider measures asks
    // the same coverage question four times otherwise.
    const coverageByDomain = new Map<
      AlternativeDataDomain,
      AlternativeDataFacts["coverage"]
    >();
    for (const domain of alternativeDataDomainsFor(request.operands)) {
      const state = await this.store.getAlternativeDatasetState(
        request.security.id,
        domain,
      );
      coverageByDomain.set(
        domain,
        state?.earliestAvailableDate && state.syncedThroughDate
          ? { from: state.earliestAvailableDate, to: state.syncedThroughDate }
          : null,
      );
    }

    const resolveGroup =
      request.resolveGroupMembers ??
      ((groupId: string) => this.store.getActorGroupMemberIds(groupId));
    const groupCache = new Map<string, readonly string[]>();

    for (const { key, metric } of requests) {
      const domain = alternativeDataDomainOf(metric);
      const coverage = coverageByDomain.get(domain) ?? null;
      const definition = alternativeDataMeasureDefinition(metric);

      let actorIds: readonly string[] | undefined;
      const scope = alternativeDataScope(metric);
      if (scope?.kind === "ACTOR") {
        actorIds = [scope.actorId];
      } else if (scope?.kind === "GROUP") {
        const cached = groupCache.get(scope.groupId);
        if (cached) {
          actorIds = cached;
        } else {
          const members = await resolveGroup(scope.groupId);
          groupCache.set(scope.groupId, members);
          actorIds = members;
        }
      }

      const observations = await this.readObservations({
        securityId: request.security.id,
        from: request.from,
        to: request.to,
        metric,
        filter: definition.filter,
        ...(actorIds === undefined ? {} : { actorIds }),
      });
      facts.set(key, { coverage, observations });
    }

    return facts;
  }

  private async readObservations(input: {
    securityId: string;
    from: LocalDate;
    to: LocalDate;
    metric: AlternativeDataMetric;
    filter: AlternativeDataFactFilter;
    actorIds?: readonly string[];
  }): Promise<AlternativeDataObservation[]> {
    const { securityId, from, to, metric, filter } = input;

    if (
      filter === "INSIDER_OPEN_MARKET_PURCHASE" ||
      filter === "INSIDER_OPEN_MARKET_SALE"
    ) {
      const roles =
        metric.kind === "INSIDER_ACTIVITY" ? metric.roles : undefined;
      const rows = await this.store.getInsiderObservations({
        securityId,
        from,
        to,
        category:
          filter === "INSIDER_OPEN_MARKET_PURCHASE"
            ? "OPEN_MARKET_PURCHASE"
            : "OPEN_MARKET_SALE",
        ...(roles === undefined ? {} : { roles }),
      });
      return rows.map((row) => ({
        observableFrom: row.availableFromDate,
        actorKey: row.actorKey,
        // Absent rather than zero: an award the form priced at zero contributes nothing to a purchase
        // value, and a zero would read as a real, tiny purchase.
        ...(row.transactionValue === null
          ? {}
          : { amount: row.transactionValue }),
      }));
    }

    if (filter === "CONGRESS_PURCHASE" || filter === "CONGRESS_SALE") {
      const chamber =
        metric.kind === "CONGRESS_ACTIVITY" && metric.chamber !== "ANY"
          ? (metric.chamber as CongressChamber)
          : undefined;
      const owners =
        metric.kind === "CONGRESS_ACTIVITY" ? metric.owners : undefined;
      const rows = await this.store.getCongressObservations({
        securityId,
        from,
        to,
        kind: filter === "CONGRESS_PURCHASE" ? "PURCHASE" : "SALE",
        ...(input.actorIds === undefined ? {} : { actorIds: input.actorIds }),
        ...(chamber === undefined ? {} : { chamber }),
        ...(owners === undefined ? {} : { owners }),
      });
      return rows.map((row) => ({
        observableFrom: row.availableFromDate,
        actorKey: row.actorKey,
        // The band's lower bound, which is what `Congress minimum disclosed purchase value` is named
        // for. A band with no readable figure contributes nothing rather than zero.
        ...(row.amountLowerBound === null
          ? {}
          : { amount: row.amountLowerBound }),
      }));
    }

    const changes = INSTITUTIONAL_CHANGES[filter] ?? [];
    const rows = await this.store.getInstitutionalObservations({
      securityId,
      from,
      to,
      changes,
      ...(input.actorIds === undefined ? {} : { actorIds: input.actorIds }),
    });
    return rows.map((row) => ({
      observableFrom: row.availableFromDate,
      actorKey: row.actorKey,
      shares: row.shares,
      ...(row.previousShares === null
        ? {}
        : { previousShares: row.previousShares }),
    }));
  }

  // -------------------------------------------------------------------------
  // Ingestion
  // -------------------------------------------------------------------------

  /**
   * Pages `insider-trading/search` for one symbol.
   *
   * A cold ingest walks to exhaustion, bounded by `maxPagesPerIngest`. A refresh stops as soon as a
   * page inserted nothing new, which is the cheapest correct rule for an endpoint that returns
   * newest-first and accepts no date range: everything older than the first fully-known page is
   * already persisted.
   */
  private async ingestInsider(
    security: Security,
    reason: "COLD" | "STALE",
  ): Promise<void> {
    const syncedAt = this.now().toISOString();
    const window = new AvailabilityWindow();

    for (let page = 0; page < this.options.maxPagesPerIngest; page += 1) {
      const rows = await this.provider.getInsiderTrades({
        symbol: security.symbol,
        page,
        limit: FMP_INSIDER_TRADING_MAX_PAGE_SIZE,
      });
      this.options.onProviderRequest?.({
        domain: "INSIDER",
        symbol: security.symbol,
        reason,
        page,
        rows: rows.length,
      });
      if (rows.length === 0) {
        break;
      }
      const writes: InsiderTransactionWrite[] = rows.map((row) => ({
        securityId: security.id,
        transactionDate: row.transactionDate,
        filingDate: row.filingDate,
        availableFromDate: row.availableFromDate,
        reportingCik: row.reportingCik,
        reportingName: row.reportingName,
        ...(row.companyCik === undefined ? {} : { companyCik: row.companyCik }),
        ...(row.typeOfOwner === undefined
          ? {}
          : { typeOfOwner: row.typeOfOwner }),
        roles: row.roles,
        ...(row.transactionCode === undefined
          ? {}
          : { transactionCode: row.transactionCode }),
        transactionTypeRaw: row.transactionTypeRaw,
        category: row.category,
        ...(row.acquisitionOrDisposition === undefined
          ? {}
          : { acquisitionOrDisposition: row.acquisitionOrDisposition }),
        ...(row.directOrIndirect === undefined
          ? {}
          : { directOrIndirect: row.directOrIndirect }),
        ...(row.formType === undefined ? {} : { formType: row.formType }),
        ...(row.securityName === undefined
          ? {}
          : { securityName: row.securityName }),
        ...(row.securitiesTransacted === undefined
          ? {}
          : { securitiesTransacted: row.securitiesTransacted }),
        ...(row.securitiesOwned === undefined
          ? {}
          : { securitiesOwned: row.securitiesOwned }),
        ...(row.price === undefined ? {} : { price: row.price }),
        ...(row.transactionValue === undefined
          ? {}
          : { transactionValue: row.transactionValue }),
        ...(row.sourceUrl === undefined ? {} : { sourceUrl: row.sourceUrl }),
        raw: row.raw,
        contentHash: insiderContentHash(row),
      }));
      const result = await this.store.saveInsiderTransactions(writes);
      window.observe(rows);
      if (rows.length < FMP_INSIDER_TRADING_MAX_PAGE_SIZE) {
        break;
      }
      if (reason === "STALE" && result.inserted === 0) {
        break;
      }
    }

    // A symbol with no insider filings at all still records a successful sync, but records no
    // availability window — so its coverage stays absent and its metrics stay NOT_EVALUABLE rather
    // than reporting a confident zero over history nobody has vouched for.
    await this.store.recordAlternativeDatasetSync({
      securityId: security.id,
      domain: "INSIDER",
      ...window.asRecord(),
      syncedAt,
    });
  }

  /** The same walk for both chambers, whose disclosures share one table and one coverage record. */
  private async ingestCongress(
    security: Security,
    reason: "COLD" | "STALE",
  ): Promise<void> {
    const syncedAt = this.now().toISOString();
    const window = new AvailabilityWindow();

    for (const chamber of ["SENATE", "HOUSE"] as const) {
      for (let page = 0; page < this.options.maxPagesPerIngest; page += 1) {
        const rows = await this.provider.getCongressTrades({
          chamber,
          symbol: security.symbol,
          page,
          limit: FMP_CONGRESS_TRADING_MAX_PAGE_SIZE,
        });
        this.options.onProviderRequest?.({
          domain: "CONGRESS",
          symbol: security.symbol,
          reason,
          page,
          rows: rows.length,
        });
        if (rows.length === 0) {
          break;
        }
        // Members are created on first sight, so the identity a group holds exists before any user can
        // select it. The canonical id then replaces the bioguide id on every trade row.
        const actorIds = await this.store.upsertActors(
          rows.map((row) => ({
            type: "CONGRESS_PERSON" as const,
            externalId: row.actorExternalId,
            displayName: row.actorDisplayName,
            chamber: row.chamber,
            ...(row.actorState ? { state: row.actorState } : {}),
            ...(row.actorDistrict ? { district: row.actorDistrict } : {}),
          })),
        );
        const writes: CongressTradeWrite[] = [];
        for (const row of rows) {
          const actorId = actorIds.get(
            `CONGRESS_PERSON:${row.actorExternalId}`,
          );
          if (!actorId) {
            continue;
          }
          writes.push({
            securityId: security.id,
            actorId,
            chamber: row.chamber,
            transactionDate: row.transactionDate,
            disclosureDate: row.disclosureDate,
            availableFromDate: row.availableFromDate,
            kind: row.kind,
            transactionTypeRaw: row.transactionTypeRaw,
            owner: row.owner,
            ...(row.ownerRaw === undefined ? {} : { ownerRaw: row.ownerRaw }),
            assetClass: row.assetClass,
            ...(row.assetTypeRaw === undefined
              ? {}
              : { assetTypeRaw: row.assetTypeRaw }),
            ...(row.assetDescription === undefined
              ? {}
              : { assetDescription: row.assetDescription }),
            ...(row.amountRangeRaw === undefined
              ? {}
              : { amountRangeRaw: row.amountRangeRaw }),
            ...(row.amountLowerBound === undefined
              ? {}
              : { amountLowerBound: row.amountLowerBound }),
            ...(row.amountUpperBound === undefined
              ? {}
              : { amountUpperBound: row.amountUpperBound }),
            ...(row.capitalGainsOver200Usd === undefined
              ? {}
              : { capitalGainsOver200Usd: row.capitalGainsOver200Usd }),
            ...(row.comment === undefined ? {} : { comment: row.comment }),
            ...(row.sourceUrl === undefined
              ? {}
              : { sourceUrl: row.sourceUrl }),
            raw: row.raw,
            contentHash: congressContentHash(row),
          });
        }
        const result = await this.store.saveCongressTrades(writes);
        // The availability window covers every ingested disclosure, including the non-stock asset
        // classes: coverage is a statement about what was read, not about what a metric counts.
        window.observe(rows);
        if (rows.length < FMP_CONGRESS_TRADING_MAX_PAGE_SIZE) {
          break;
        }
        if (reason === "STALE" && result.inserted === 0) {
          break;
        }
      }
    }

    await this.store.recordAlternativeDatasetSync({
      securityId: security.id,
      domain: "CONGRESS",
      ...window.asRecord(),
      syncedAt,
    });
  }

  /**
   * Ingests 13F holdings quarter by quarter, then re-derives this security's position events.
   *
   * The derivation is deliberately a **replacement** rather than an append: the events are a pure
   * function of the filings, so an amendment changes an existing period's comparison and appending
   * would leave the superseded one beside it. That also makes reingestion idempotent.
   *
   * Report quarters are walked newest-first from the last quarter that can plausibly have been filed.
   * A quarter the provider has nothing for is simply empty; it is not an error, and it does not stop
   * the walk, because a manager can miss a quarter.
   */
  private async ingestInstitutional(
    security: Security,
    reason: "COLD" | "STALE",
  ): Promise<void> {
    const syncedAt = this.now().toISOString();
    const window = new AvailabilityWindow();
    let sawAnyRow = false;

    const quarters = recentReportQuarters(
      this.now(),
      this.options.institutionalQuarters,
    );
    for (const { year, quarter } of quarters) {
      const holdings: MappedFmpInstitutionalHolding[] = [];
      for (let page = 0; page < this.options.maxPagesPerIngest; page += 1) {
        const rows = await this.provider.getInstitutionalHoldings({
          symbol: security.symbol,
          year,
          quarter,
          page,
          limit: FMP_INSTITUTIONAL_MAX_PAGE_SIZE,
        });
        this.options.onProviderRequest?.({
          domain: "INSTITUTIONAL",
          symbol: security.symbol,
          reason,
          page,
          rows: rows.length,
        });
        holdings.push(...rows);
        if (rows.length < FMP_INSTITUTIONAL_MAX_PAGE_SIZE) {
          break;
        }
      }
      if (holdings.length === 0) {
        continue;
      }
      sawAnyRow = true;

      const actorIds = await this.store.upsertActors(
        holdings.map((holding) => ({
          type: "INSTITUTION" as const,
          externalId: holding.actorExternalId,
          displayName: holding.actorDisplayName,
          cik: holding.actorExternalId,
        })),
      );

      const filings: InstitutionalFilingWrite[] = [];
      for (const holding of holdings) {
        const actorId = actorIds.get(`INSTITUTION:${holding.actorExternalId}`);
        if (!actorId) {
          continue;
        }
        const lines = [
          {
            securityId: security.id,
            shares: holding.shares,
            ...(holding.marketValue === undefined
              ? {}
              : { marketValue: holding.marketValue }),
            ...(holding.portfolioWeightPercent === undefined
              ? {}
              : { portfolioWeightPercent: holding.portfolioWeightPercent }),
            raw: holding.raw,
          },
        ];
        filings.push({
          actorId,
          reportPeriod: holding.reportPeriod,
          filingDate: holding.filingDate,
          availableFromDate: holding.availableFromDate,
          ...(holding.amendmentType === undefined
            ? {}
            : { amendmentType: holding.amendmentType }),
          ...(holding.providerFilingId === undefined
            ? {}
            : { providerFilingId: holding.providerFilingId }),
          raw: holding.raw,
          contentHash: institutionalFilingContentHash(
            holding.actorExternalId,
            holding.reportPeriod,
            holding.filingDate,
            holding.amendmentType,
            lines,
          ),
          holdings: lines,
        });
      }
      await this.store.saveInstitutionalFilings(filings);
      window.observe(holdings);
    }

    if (sawAnyRow) {
      await this.deriveInstitutionalPositions(security);
    }

    await this.store.recordAlternativeDatasetSync({
      securityId: security.id,
      domain: "INSTITUTIONAL",
      ...window.asRecord(),
      syncedAt,
    });
  }

  /**
   * Re-derives every manager's position changes for one security from the filings on record.
   *
   * The derivation itself lives in `@intrinsic/domain` and is pure; this only groups the filings per
   * manager and writes the result. Nothing here infers a trade date inside a quarter.
   */
  async deriveInstitutionalPositions(security: Security): Promise<void> {
    const rows = await this.store.getInstitutionalFilingsForSecurity({
      securityId: security.id,
    });
    const byActor = new Map<string, InstitutionalFilingWithHoldings[]>();
    for (const row of rows) {
      const list = byActor.get(row.actorId) ?? [];
      list.push({
        filing: {
          // The canonical actor id stands in for the external one here: the derivation only needs a
          // stable key to group by, and the id is the identity everything downstream is keyed by.
          actorExternalId: row.actorId,
          actorDisplayName: row.actorId,
          reportPeriod: row.reportPeriod,
          filingDate: row.filingDate,
          availableFromDate: row.availableFromDate,
          ...(row.amendmentType === undefined
            ? {}
            : { amendmentType: row.amendmentType }),
        },
        holdings:
          row.shares === null
            ? []
            : [
                {
                  securityId: security.id,
                  shares: row.shares,
                  ...(row.portfolioWeightPercent === null
                    ? {}
                    : { portfolioWeightPercent: row.portfolioWeightPercent }),
                },
              ],
      });
      byActor.set(row.actorId, list);
    }

    const events = [...byActor.entries()].flatMap(([actorId, filings]) =>
      deriveInstitutionalPositionEvents({
        securityId: security.id,
        actorExternalId: actorId,
        filings,
      }).map((event) => ({
        securityId: event.securityId,
        actorId,
        reportPeriod: event.reportPeriod,
        ...(event.previousReportPeriod === undefined
          ? {}
          : { previousReportPeriod: event.previousReportPeriod }),
        availableFromDate: event.availableFromDate,
        change: event.change,
        shares: event.shares,
        ...(event.previousShares === undefined
          ? {}
          : { previousShares: event.previousShares }),
        ...(event.changePercent === undefined
          ? {}
          : { changePercent: event.changePercent }),
        ...(event.portfolioWeightPercent === undefined
          ? {}
          : { portfolioWeightPercent: event.portfolioWeightPercent }),
        ...(event.previousPortfolioWeightPercent === undefined
          ? {}
          : {
              previousPortfolioWeightPercent:
                event.previousPortfolioWeightPercent,
            }),
      })),
    );

    await this.store.replaceInstitutionalPositionEvents({
      securityId: security.id,
      events,
    });
  }
}

/**
 * The availability window one ingest actually read.
 *
 * It accumulates the earliest and latest availability date across every page and chamber, so the
 * coverage recorded afterwards is a statement about what was read rather than about the last page.
 */
class AvailabilityWindow {
  private earliest: LocalDate | undefined;
  private latest: LocalDate | undefined;

  observe(rows: readonly { availableFromDate: LocalDate }[]): void {
    for (const row of rows) {
      if (this.earliest === undefined || row.availableFromDate < this.earliest) {
        this.earliest = row.availableFromDate;
      }
      if (this.latest === undefined || row.availableFromDate > this.latest) {
        this.latest = row.availableFromDate;
      }
    }
  }

  asRecord(): {
    earliestAvailableDate?: LocalDate;
    latestAvailableDate?: LocalDate;
  } {
    return {
      ...(this.earliest === undefined
        ? {}
        : { earliestAvailableDate: this.earliest }),
      ...(this.latest === undefined ? {} : { latestAvailableDate: this.latest }),
    };
  }
}

/**
 * The report quarters a 13F ingest reads, newest first.
 *
 * It starts from the **previous** calendar quarter rather than the current one: a quarter's holdings
 * cannot be reported until it has ended, so asking for the one in progress is guaranteed to be empty.
 */
export function recentReportQuarters(
  now: Date,
  count: number,
): { year: number; quarter: 1 | 2 | 3 | 4 }[] {
  const quarters: { year: number; quarter: 1 | 2 | 3 | 4 }[] = [];
  let year = now.getUTCFullYear();
  let quarter = Math.floor(now.getUTCMonth() / 3) + 1;
  for (let index = 0; index < Math.max(0, count); index += 1) {
    quarter -= 1;
    if (quarter < 1) {
      quarter = 4;
      year -= 1;
    }
    quarters.push({ year, quarter: quarter as 1 | 2 | 3 | 4 });
  }
  return quarters;
}

/** Whether one normalized congressional disclosure may feed a V1 metric. Re-exported for callers. */
export { isCongressTradeStrategyEligible };
