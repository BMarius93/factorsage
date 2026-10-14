import {
  findSelectableSeries,
  isFundamentalMetricId,
  isStrategyEtfSourceCode,
  isValuationRatioId,
  RELATIVE_VOLUME_PERIODS,
  strategyMetricSource,
  withoutMetricSource,
  type FundamentalMetricId,
  type RelativeVolumePeriod,
  type SelectableSeries,
  type SelectableSeriesId,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyEtfSourceCode,
  type StrategyMetric,
  type StrategyMetricSource,
  type StrategySignal,
  type StrategyTrigger,
  type StrategyValue,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import { alternativeDataMetricOperand } from "./alternative-data.js";

/**
 * Identity of one value column an evaluation frame carries.
 *
 * An operand is anything that resolves to `number | absent` on one eligible trading day. Keys are
 * opaque strings built here and nowhere else: a frame projector and the evaluator must agree on
 * them, and neither may parse one apart.
 */
export type OperandKey = string;

/** Canonical end-of-day close. Deliberately not a catalog series, so it has its own key. */
export const PRICE_OPERAND: OperandKey = "price";

const SERIES_PREFIX = "series:";

/** A catalog series read straight off the materialized daily derived state. */
export function seriesOperand(seriesId: SelectableSeriesId): OperandKey {
  return `${SERIES_PREFIX}${seriesId}`;
}

/**
 * The catalog series a key addresses, or null when it addresses something else.
 *
 * The inverse of {@link seriesOperand}, and it lives here for the same reason the builder does: the
 * encoding is this module's, and a caller that needs to know which series a key names must ask
 * rather than slice the string itself.
 */
export function operandSeriesId(key: OperandKey): SelectableSeriesId | null {
  return key.startsWith(SERIES_PREFIX)
    ? (key.slice(SERIES_PREFIX.length) as SelectableSeriesId)
    : null;
}

const RELATIVE_VOLUME_PREFIX = "relative-volume:";

/**
 * Relative Volume for one supported period, read straight off the materialized daily derived state.
 *
 * It is its own key family rather than a `series:` key because Relative Volume is not a catalog
 * series: it is parameterized by period, has no catalog id, and is never a comparison Value.
 */
export function relativeVolumeOperand(
  period: RelativeVolumePeriod,
): OperandKey {
  return `${RELATIVE_VOLUME_PREFIX}${period}`;
}

/**
 * The Relative Volume period a key addresses, or null when it addresses something else.
 *
 * The inverse of {@link relativeVolumeOperand}, here for the same reason the builder is: the
 * encoding is this module's, and a caller that needs the period must ask rather than slice the
 * string itself.
 */
export function operandRelativeVolumePeriod(
  key: OperandKey,
): RelativeVolumePeriod | null {
  if (!key.startsWith(RELATIVE_VOLUME_PREFIX)) {
    return null;
  }
  const period = Number(key.slice(RELATIVE_VOLUME_PREFIX.length));
  return (RELATIVE_VOLUME_PERIODS as readonly number[]).includes(period)
    ? (period as RelativeVolumePeriod)
    : null;
}

const FUNDAMENTAL_PREFIX = "fundamental:";

/**
 * One Fundamental Metric, read straight off the materialized daily derived state.
 *
 * Its own key family, like Relative Volume: a fundamental metric is not a catalog series and never a
 * comparison Value. It is keyed by the product catalog's stable identity — `fundamental:ROIC_TTM` —
 * never by its label and never by the storage field it happens to be materialized into, which only
 * the projector resolves, through the domain registry.
 */
export function fundamentalMetricOperand(
  metricId: FundamentalMetricId,
): OperandKey {
  return `${FUNDAMENTAL_PREFIX}${metricId}`;
}

/**
 * The fundamental metric a key addresses, or null when it addresses something else.
 *
 * The inverse of {@link fundamentalMetricOperand}, and it lives here for the same reason the builder
 * does: the encoding is this module's, and a caller that needs the metric must ask rather than slice
 * the string itself. A key in this family naming an identity the catalog does not define decodes to
 * null too, so it can never be projected as a metric that happens to be absent — the projector
 * refuses a key nothing decodes.
 */
export function operandFundamentalMetricId(
  key: OperandKey,
): FundamentalMetricId | null {
  if (!key.startsWith(FUNDAMENTAL_PREFIX)) {
    return null;
  }
  const metricId = key.slice(FUNDAMENTAL_PREFIX.length);
  return isFundamentalMetricId(metricId) ? metricId : null;
}

const VALUATION_PREFIX = "valuation:";

/**
 * One Valuation Ratio, projected when the frame is read (`docs/decisions/valuation-ratios-v1.md`).
 *
 * Its own key family: a ratio is neither a catalog series nor a stored field. It is keyed by the
 * product catalog's stable identity — `valuation:PRICE_TO_EARNINGS_TTM` — and the projector computes
 * its column from the security's statements, measured re-bases and split list; no stored column
 * stands behind it.
 */
export function valuationRatioOperand(ratioId: ValuationRatioId): OperandKey {
  return `${VALUATION_PREFIX}${ratioId}`;
}

/**
 * The valuation ratio a key addresses, or null when it addresses something else — including a key in
 * this family naming an identity the catalog does not define, so it is never projected as a ratio
 * that happens to be unavailable.
 */
export function operandValuationRatioId(
  key: OperandKey,
): ValuationRatioId | null {
  if (!key.startsWith(VALUATION_PREFIX)) {
    return null;
  }
  const ratioId = key.slice(VALUATION_PREFIX.length);
  return isValuationRatioId(ratioId) ? ratioId : null;
}

const ETF_PREFIX = "etf:";

/**
 * One ETF-sourced reading: the stock operand encoding, prefixed with the source's benchmark code.
 *
 * Its own key family — `etf:ETF_XLK:series:RSI_14D`, `etf:SP500:price`,
 * `etf:ETF_GLD:relative-volume:20` — so an ETF column can never be read as, loaded as, or counted
 * toward a security's own data: the per-security projectors refuse unknown families, and the
 * Monitor's warm-up sizing decodes only the stock families. ETF columns are computed once per
 * distinct ETF per backtest run or Monitor cycle from the benchmark's own finalized history
 * (`@intrinsic/stock-data`, `benchmark-technicals.ts`) and joined onto each security's frame by
 * exact session date.
 */
export function etfOperand(
  code: StrategyEtfSourceCode,
  base: OperandKey,
): OperandKey {
  return `${ETF_PREFIX}${code}:${base}`;
}

/**
 * The ETF source and underlying stock encoding one key addresses, or null when the key addresses
 * something else — including an `etf:` key naming a code the catalog does not define, so a forged
 * or drifted key can never be projected as an ETF that happens to be absent.
 */
export function decodeEtfOperand(
  key: OperandKey,
): { code: StrategyEtfSourceCode; base: OperandKey } | null {
  if (!key.startsWith(ETF_PREFIX)) {
    return null;
  }
  const rest = key.slice(ETF_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) {
    return null;
  }
  const code = rest.slice(0, separator);
  const base = rest.slice(separator + 1);
  if (!isStrategyEtfSourceCode(code) || base.length === 0) {
    return null;
  }
  return { code, base };
}

/** Whether a key belongs to the ETF family at all, decodable or not. */
export function isEtfOperand(key: OperandKey): boolean {
  return key.startsWith(ETF_PREFIX);
}

const SECTOR_PREFIX = "sector:";

/**
 * One Stock's Sector reading: the stock operand encoding under its own family —
 * `sector:series:RSI_14D`, `sector:price`. The key names no fund because a definition does not:
 * which sector ETF's column is joined under it is decided per security, from the security's own
 * sector, when the frame is assembled (`@intrinsic/stock-data`, `etf-frame-columns.ts`). Like the
 * ETF family it never reaches a per-security projector or the Monitor's warm-up sizing.
 */
export function sectorOperand(base: OperandKey): OperandKey {
  return `${SECTOR_PREFIX}${base}`;
}

/** The underlying stock encoding a Stock's Sector key addresses, or null for any other key. */
export function decodeSectorOperand(key: OperandKey): OperandKey | null {
  if (!key.startsWith(SECTOR_PREFIX)) {
    return null;
  }
  const base = key.slice(SECTOR_PREFIX.length);
  return base.length === 0 ? null : base;
}

/** Whether a key belongs to the Stock's Sector family at all, decodable or not. */
export function isSectorOperand(key: OperandKey): boolean {
  return key.startsWith(SECTOR_PREFIX);
}

/** The key one source reads a stock encoding under: the stock's own, an ETF's, or the sector's. */
function sourcedOperand(
  base: OperandKey,
  source: StrategyMetricSource | undefined,
): OperandKey {
  if (!source) {
    return base;
  }
  return source.kind === "ETF"
    ? etfOperand(source.code, base)
    : sectorOperand(base);
}

/**
 * Margin of Safety against one explicitly selected intrinsic-value source.
 *
 * It is its own column because the formula, the `intrinsicValue > 0` rule and the per-model /
 * per-blend provenance gate are applied exactly once, during projection.
 */
export function marginOfSafetyOperand(
  sourceId: SelectableSeriesId,
): OperandKey {
  return `margin-of-safety:${sourceId}`;
}

/**
 * Whether any of these operands reads financial statements — an intrinsic-value model or blend, a
 * Margin of Safety, a Fundamental Metric or a valuation ratio — and so needs the statements kept
 * current, not only the prices.
 *
 * The stock EOD preparation asks this per security, over the union of what every Monitor watching
 * it reads, so a security only price-and-technical strategies watch never spends a statement
 * request on a refresh it does not need.
 */
export function operandsReadStatements(operands: readonly OperandKey[]): boolean {
  return operands.some((key) => {
    if (
      key.startsWith("margin-of-safety:") ||
      operandFundamentalMetricId(key) !== null ||
      operandValuationRatioId(key) !== null
    ) {
      return true;
    }
    const seriesId = operandSeriesId(key);
    const kind = seriesId ? findSelectableSeries(seriesId)?.source.kind : undefined;
    return kind === "INTRINSIC_VALUE_MODEL" || kind === "INTRINSIC_VALUE_BLEND";
  });
}

/** Whether this metric needs simulated position state and therefore cannot be precomputed. */
export function isPositionDependentMetric(metric: StrategyMetric): boolean {
  return metric.kind === "GAIN" || metric.kind === "LOSS";
}

/**
 * The frame column a Metric reads, or null when the metric is position-dependent.
 *
 * Exhaustive over the metric kinds, with no fallback: a new kind must name its column here or fail
 * to compile. A `default` returning null would make it read as position-dependent — excluded from
 * the market gate and, through `evaluateMarketCondition`, permanently NOT_EVALUABLE — which is the
 * silent failure a new family must never have.
 */
export function metricOperand(metric: StrategyMetric): OperandKey | null {
  // An ETF-sourced metric reads its own key family, never the stock's column of the same identity:
  // the source is resolved here, in the one key builder, so no projector or evaluator can confuse
  // `XLK · RSI 14D` with the candidate stock's RSI however the frames are assembled.
  const source = strategyMetricSource(metric);
  if (source) {
    const base = metricOperand(withoutMetricSource(metric));
    return base === null ? null : sourcedOperand(base, source);
  }
  switch (metric.kind) {
    case "PRICE":
      return PRICE_OPERAND;
    case "MOVING_AVERAGE":
    case "OSCILLATOR":
      return seriesOperand(metric.seriesId);
    case "RELATIVE_VOLUME":
      return relativeVolumeOperand(metric.period);
    case "MARGIN_OF_SAFETY":
      return marginOfSafetyOperand(metric.sourceId);
    case "FUNDAMENTAL":
      return fundamentalMetricOperand(metric.metricId);
    case "VALUATION_RATIO":
      return valuationRatioOperand(metric.ratioId);
    case "INSIDER_ACTIVITY":
    case "CONGRESS_ACTIVITY":
      // Addressed by their whole configuration, which `alternative-data.ts` owns, so the signature is
      // encoded in one module rather than repeated here.
      return alternativeDataMetricOperand(metric);
    case "GAIN":
    case "LOSS":
      return null;
  }
}

/**
 * The frame column a Value reads, or null when the Value is a constant.
 *
 * A `SERIES` Value under an ETF-sourced metric resolves against the **same ETF** — the source lives
 * on the condition's metric and both sides of the comparison read from it — so a stock-versus-ETF
 * comparison is not representable here, exactly as the registry never offers one.
 */
export function valueOperand(
  value: StrategyValue,
  source?: StrategyMetricSource,
): OperandKey | null {
  if (value.kind !== "SERIES") {
    return null;
  }
  return sourcedOperand(seriesOperand(value.seriesId), source);
}

/** One walk over every predicate of a definition, shared by the two collectors below. */
function walkPredicates(
  definition: StrategyDefinition,
  visit: (predicate: StrategyCondition | StrategyTrigger) => void,
): void {
  const addSignal = (signal: StrategySignal): void => {
    for (const condition of signal.conditions) {
      visit(condition);
    }
    if (signal.trigger) {
      visit(signal.trigger);
    }
  };
  for (const level of definition.buyLevels) {
    addSignal(level.signal);
  }
  for (const level of definition.sellLevels) {
    addSignal(level.signal);
  }
  for (const rule of definition.finalExit?.rules ?? []) {
    addSignal(rule.signal);
  }
}

/**
 * Every **security-owned** frame column a strategy version references, ascending and deduplicated.
 *
 * Projecting only these columns is what keeps a long multi-security run in tens of megabytes
 * instead of gigabytes (`ai/architecture/strategy-evaluation.md` §2.5). The ordering is stable so
 * two runs of the same definition request identical projections.
 *
 * ETF-sourced predicates contribute **nothing** here, deliberately: their columns belong to the
 * ETF, are computed once per distinct ETF per run or cycle, and are collected by
 * {@link collectEtfOperands}. Keeping them out is what stops an ETF key reaching the per-security
 * projectors — which refuse unknown families — and what stops twenty conditions on one ETF
 * widening a Monitor's per-security load window.
 */
export function collectOperands(definition: StrategyDefinition): OperandKey[] {
  const keys = new Set<OperandKey>();
  // Price is always projected: portfolio valuation, execution and Gain/Loss all need the close,
  // whether or not a predicate names it.
  keys.add(PRICE_OPERAND);

  walkPredicates(definition, (predicate) => {
    const source = strategyMetricSource(predicate.metric);
    if (source) {
      return;
    }
    const metric = metricOperand(predicate.metric);
    if (metric) {
      keys.add(metric);
    }
    const value = valueOperand(predicate.value);
    if (value) {
      keys.add(value);
    }
  });

  return [...keys].sort();
}

/**
 * Every ETF-sourced frame column a strategy version references, grouped by source code, each list
 * ascending and deduplicated, the codes in ascending order.
 *
 * The one answer to "which ETF columns does this definition need, from which histories?": the
 * backtest's prepare phase and the Monitor cycle both read it, compute each named ETF's technicals
 * once, and join exactly these columns onto every security frame. Work therefore scales with the
 * distinct ETFs a definition names, never with securities × conditions.
 */
export function collectEtfOperands(
  definition: StrategyDefinition,
): ReadonlyMap<StrategyEtfSourceCode, readonly OperandKey[]> {
  const byCode = new Map<StrategyEtfSourceCode, Set<OperandKey>>();
  walkPredicates(definition, (predicate) => {
    const source = strategyMetricSource(predicate.metric);
    if (source?.kind !== "ETF") {
      return;
    }
    const keys = byCode.get(source.code) ?? new Set<OperandKey>();
    const metric = metricOperand(predicate.metric);
    if (metric) {
      keys.add(metric);
    }
    const value = valueOperand(predicate.value, source);
    if (value) {
      keys.add(value);
    }
    byCode.set(source.code, keys);
  });
  return new Map(
    [...byCode.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, keys]) => [code, [...keys].sort()]),
  );
}

/**
 * Every Stock's Sector frame column a strategy version references, ascending and deduplicated.
 *
 * One list for the whole definition, because the keys name no fund: each security's frame joins
 * them from the one sector ETF that security resolved to, so ten stocks of two sectors read two
 * histories however many Stock's Sector rules there are.
 */
export function collectSectorOperands(
  definition: StrategyDefinition,
): readonly OperandKey[] {
  const keys = new Set<OperandKey>();
  walkPredicates(definition, (predicate) => {
    const source = strategyMetricSource(predicate.metric);
    if (source?.kind !== "STOCK_SECTOR") {
      return;
    }
    const metric = metricOperand(predicate.metric);
    if (metric) {
      keys.add(metric);
    }
    const value = valueOperand(predicate.value, source);
    if (value) {
      keys.add(value);
    }
  });
  return [...keys].sort();
}

/**
 * The structured catalog identity behind an operand key, for a projector that has to decide which
 * `DailyDerivedState` field, intrinsic model or blend to read. Returns null for `PRICE`.
 *
 * The catalog stays the single source of that identity: nothing here re-derives a field name from
 * an id or a label.
 */
export function describeSeriesOperand(
  seriesId: SelectableSeriesId,
): SelectableSeries | undefined {
  return findSelectableSeries(seriesId);
}
