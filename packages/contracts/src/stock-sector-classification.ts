import {
  type FmpStockSector,
  resolveStockSectorEtf,
} from "./stock-sector-etfs.js";

/**
 * A stock's sector in the product's GICS-named vocabulary, derived from the one canonical reading of
 * its FMP sector (`resolveStockSectorEtf`) — never a second parser. The same strings are recognized
 * as for a `Stock's Sector` condition: FMP's eleven names, insensitive to case and whitespace, and
 * nothing else. A value that resolves there classifies here; one that does not is unclassified,
 * with the reason, and never assigned another company's or a guessed sector.
 *
 * Like the condition, it is the company's **current** classification. A universe that groups
 * historical members by it is retrospectively classified and says so
 * (`docs/decisions/historical-universes-v1.md` §2.1).
 */

/** The GICS sector codes, as `@intrinsic/domain`'s `GICS_SECTORS` spells them. */
export type StockGicsSectorCode =
  | "INFORMATION_TECHNOLOGY"
  | "FINANCIALS"
  | "HEALTH_CARE"
  | "ENERGY"
  | "INDUSTRIALS"
  | "UTILITIES"
  | "COMMUNICATION_SERVICES"
  | "CONSUMER_DISCRETIONARY"
  | "CONSUMER_STAPLES"
  | "MATERIALS"
  | "REAL_ESTATE";

/**
 * Each FMP sector's GICS sector. FMP's names are aliases of the GICS ones: Technology is
 * Information Technology, Financial Services is Financials, Healthcare is Health Care, Consumer
 * Cyclical is Consumer Discretionary, Consumer Defensive is Consumer Staples and Basic Materials is
 * Materials; the other five are spelled alike.
 */
export const FMP_SECTOR_GICS = {
  Technology: "INFORMATION_TECHNOLOGY",
  "Financial Services": "FINANCIALS",
  Energy: "ENERGY",
  Healthcare: "HEALTH_CARE",
  Industrials: "INDUSTRIALS",
  "Consumer Cyclical": "CONSUMER_DISCRETIONARY",
  "Consumer Defensive": "CONSUMER_STAPLES",
  Utilities: "UTILITIES",
  "Basic Materials": "MATERIALS",
  "Real Estate": "REAL_ESTATE",
  "Communication Services": "COMMUNICATION_SERVICES",
} as const satisfies Record<FmpStockSector, StockGicsSectorCode>;

/**
 * Bumped whenever the mapping above or the recognized strings change: a classified universe's
 * generation records the version it ran.
 */
export const STOCK_SECTOR_CLASSIFICATION_VERSION = 1;

export type StockSectorClassification =
  | {
      readonly status: "CLASSIFIED";
      readonly fmpSector: FmpStockSector;
      readonly gicsSector: StockGicsSectorCode;
    }
  /**
   * `MISSING`: the provider reports no sector. `UNSUPPORTED`: a stored value that is not one of its
   * eleven, kept as stored.
   */
  | {
      readonly status: "UNCLASSIFIED";
      readonly reason: "MISSING" | "UNSUPPORTED";
      readonly stored: string | null;
    };

/** Classifies one stored FMP sector, or says why it cannot. */
export function classifyStockSector(
  sector: string | null | undefined,
): StockSectorClassification {
  const resolution = resolveStockSectorEtf(sector);
  switch (resolution.status) {
    case "RESOLVED":
      return {
        status: "CLASSIFIED",
        fmpSector: resolution.sector,
        gicsSector: FMP_SECTOR_GICS[resolution.sector],
      };
    case "MISSING":
      return { status: "UNCLASSIFIED", reason: "MISSING", stored: null };
    case "UNSUPPORTED":
      return {
        status: "UNCLASSIFIED",
        reason: "UNSUPPORTED",
        stored: resolution.sector,
      };
  }
}
