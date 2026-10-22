import { backtestPeriodYears } from "@intrinsic/contracts";
import { formatCount } from "../utils/format";

/**
 * The product name, as the topbar's `BRAND_NAME` spells it. Restated rather than imported: that
 * module renders images and styles, and the preview-image route must not pull either in.
 */
export const SHARE_BRAND_NAME = "FactorSage";

/**
 * The words a shared backtest is introduced with wherever it travels: the link preview's title
 * and description, the preview image's alt text and its headline figures.
 *
 * Every number is one the API read from the run's stored result — the annualized returns are the
 * summary's own, never recomputed here — and nothing private is reachable from these inputs: they
 * are the allowlisted report fields, so a preview cannot say what the report does not.
 */

/** The headline figures a preview is built from; a subset of both public payloads. */
export type SharedBacktestHeadlineInput = {
  readonly startDate: string;
  readonly endDate: string;
  readonly benchmarkName: string;
  readonly securityCount: number;
  readonly strategyRuleCount: number;
  readonly portfolioCagrPercent: number | null;
  readonly benchmarkCagrPercent: number | null;
  readonly portfolioReturnPercent: number;
  readonly benchmarkReturnPercent: number | null;
};

const HEADLINE_PERCENT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * A headline percentage: one decimal, signed only when negative — `18.4%`, `-3.1%`.
 *
 * Coarser than the KPI tiles' two decimals on purpose: a preview is read at a glance in a chat
 * thumbnail, and the exact figure is one tap away on the report itself.
 */
export function formatHeadlinePercent(value: number): string {
  // `-0.0%` would read as a loss that is not there.
  const rounded = Math.round(value * 10) / 10;
  return `${HEADLINE_PERCENT.format(rounded === 0 ? 0 : rounded)}%`;
}

function plural(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/**
 * How long the run covers, in the words a preview uses: `26-year backtest`.
 *
 * Years are counted with `backtestPeriodYears`, the product's one definition of "years of history"
 * — the same count the plan limits are stated in — so a preview can never call a period shorter or
 * longer than the product does elsewhere. A run shorter than a year is said in months.
 */
export function sharedBacktestPeriodLabel(
  startDate: string,
  endDate: string,
): string {
  const years = backtestPeriodYears(startDate, endDate);
  if (years > 1) {
    return `${years}-year backtest`;
  }
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth()) +
    (end.getUTCDate() >= start.getUTCDate() ? 0 : -1);
  return months >= 12 || months < 1
    ? "1-year backtest"
    : `${months}-month backtest`;
}

/**
 * `18.4% Annualized vs 10.2% SPY | FactorSage`.
 *
 * Annualized returns lead because they are what compares a thirty-year run with a three-year one.
 * A run too short to annualize falls back to its total returns, worded as such, and a run with no
 * benchmark figure states its own number alone rather than inventing a comparison.
 */
export function sharedBacktestTitle(
  input: SharedBacktestHeadlineInput,
): string {
  const annualized = input.portfolioCagrPercent !== null;
  const own = annualized
    ? `${formatHeadlinePercent(input.portfolioCagrPercent as number)} Annualized`
    : `${formatHeadlinePercent(input.portfolioReturnPercent)} Total return`;
  const benchmark = annualized
    ? input.benchmarkCagrPercent
    : input.benchmarkReturnPercent;
  const comparison =
    benchmark === null
      ? ""
      : ` vs ${formatHeadlinePercent(benchmark)} ${input.benchmarkName}`;
  return `${own}${comparison} | ${SHARE_BRAND_NAME}`;
}

/** `26-year backtest · 750 securities · 12 strategy rules`. */
export function sharedBacktestDescription(
  input: SharedBacktestHeadlineInput,
): string {
  return [
    sharedBacktestPeriodLabel(input.startDate, input.endDate),
    plural(input.securityCount, "security", "securities"),
    plural(input.strategyRuleCount, "strategy rule", "strategy rules"),
  ].join(" · ");
}

/** The preview image's text alternative: the same facts, as one sentence. */
export function sharedBacktestImageAlt(
  input: SharedBacktestHeadlineInput,
): string {
  return `${SHARE_BRAND_NAME} backtest chart. ${sharedBacktestTitle(
    input,
  ).replace(
    ` | ${SHARE_BRAND_NAME}`,
    "",
  )}. ${sharedBacktestDescription(input)}.`;
}
