import type { LocalDate } from "@intrinsic/domain";
import { heldFromIndex } from "./price-basis.js";

/**
 * Re-base protection for benchmark series a provider can re-base: the ETF proxies
 * (`docs/decisions/etf-market-data-v1.md`; `historical-price-basis-v1.md` §7–§9, §12).
 *
 * The provider's daily series is split-adjusted: after a split it rescales **every** bar before the
 * ex-date, and it may publish the ex-date bar before it has rewritten the older ones. Saving a read
 * beside a history it no longer matches would leave two price bases side by side, which every
 * comparison the history is used for — a return, a moving average, a backtest — would then read as
 * a real move. These are the pure rules that decide when a read must be checked first; the loader
 * does the reading. Index series cannot split, so they never pass through here.
 */

type Bar = { date: LocalDate; close: number };

type StoredBar = Bar & {
  open: number;
  high: number;
  low: number;
  volume: number;
};

/**
 * Whether saving `loaded` would change the stored history: a session it does not hold yet, or one
 * whose bar differs in any field (`historical-price-basis-v1.md` §7, rule 2, as the stock loader's
 * `changesStoredRows` applies it).
 *
 * Only then must the earliest stored bars be checked before saving. A re-base rescales every bar
 * before its ex-date, so the earliest ones change whenever any re-base happened, however long ago —
 * including one the provider folded in weeks after the ex-date, which a check of only the newest
 * overlap would never see. A read that changes nothing is saved as it is and costs no check.
 */
export function changesStoredBenchmarkBars(
  stored: readonly StoredBar[],
  loaded: readonly StoredBar[],
): boolean {
  const byDate = new Map(stored.map((bar) => [bar.date, bar]));
  return loaded.some((bar) => {
    const existing = byDate.get(bar.date);
    return (
      existing === undefined ||
      !sameStoredValue(existing.open, bar.open) ||
      !sameStoredValue(existing.high, bar.high) ||
      !sameStoredValue(existing.low, bar.low) ||
      !sameStoredValue(existing.close, bar.close) ||
      existing.volume !== bar.volume
    );
  });
}

/** Prices are stored to eight decimals, so a value carrying more never compares equal to its save. */
function sameStoredValue(stored: number, loaded: number): boolean {
  return (
    stored === loaded ||
    Math.abs(stored - loaded) <= 5e-9 * (1 + Math.abs(loaded))
  );
}

/**
 * The ex-date hold for a benchmark read (`historical-price-basis-v1.md` §7, rule 3).
 *
 * Only bars **newer than every stored bar** are considered: the hold protects the newest edge, where
 * the provider may already show the ex-date bar on the new basis while the older ones are still on
 * the old one. A split-sized move into one of those bars, with fewer than four sessions standing
 * after it, is held — not saved — until a later read either finds the history rewritten (which a
 * full replacement then takes) or finds the move still standing, and genuine.
 */
export function benchmarkExDateHold<T extends Bar>(input: {
  /** The newest stored bar of the series, if any. */
  newestStored: Bar | undefined;
  loaded: readonly T[];
}): { rows: T[]; heldFrom?: LocalDate } {
  const newestDate = input.newestStored?.date;
  const newer = [...input.loaded]
    .filter((bar) => newestDate === undefined || bar.date > newestDate)
    .sort((left, right) => (left.date < right.date ? -1 : 1));
  const series: Bar[] = input.newestStored
    ? [input.newestStored, ...newer]
    : newer;
  const held = heldFromIndex(series, input.newestStored ? 1 : 0);
  if (held === undefined) {
    return { rows: [...input.loaded] };
  }
  const heldFrom = (series[held] as Bar).date;
  return {
    rows: input.loaded.filter((bar) => bar.date < heldFrom),
    heldFrom,
  };
}
