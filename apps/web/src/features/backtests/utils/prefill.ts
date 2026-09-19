import type { BacktestRunConfigurationResponse } from "@intrinsic/contracts";

/**
 * What a link into New Backtest may preselect.
 *
 * The one definition of the query the form reads, so an entity header, a Guest's sign-in return
 * and "Edit and run again" all speak the same language and cannot drift into three dialects. Every
 * field is optional and every value is re-checked by the form: an id the caller cannot choose is
 * ignored, and a malformed number or date is dropped rather than half-applied.
 */
export type BacktestPrefill = {
  readonly strategyId?: string;
  readonly stockListId?: string;
  readonly benchmarkCode?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly initialCapital?: number;
  readonly monthlyContribution?: number;
  readonly maximumPositions?: number;
  /** The run this configuration was copied from, for the form's "prefilled from" notice. */
  readonly fromRunId?: string;
};

const PARAMS = {
  strategyId: "strategyId",
  stockListId: "stockListId",
  benchmarkCode: "benchmark",
  startDate: "start",
  endDate: "end",
  initialCapital: "capital",
  monthlyContribution: "contribution",
  maximumPositions: "positions",
  fromRunId: "from",
} as const satisfies Record<keyof BacktestPrefill, string>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `/backtests/new`, preselecting whatever is given. */
export function newBacktestHref(prefill: BacktestPrefill = {}): string {
  const query = new URLSearchParams();
  for (const key of Object.keys(PARAMS) as (keyof BacktestPrefill)[]) {
    const value = prefill[key];
    if (value !== undefined && value !== "") {
      query.set(PARAMS[key], String(value));
    }
  }
  const search = query.toString();
  return search ? `/backtests/new?${search}` : "/backtests/new";
}

/**
 * "Edit and run again": New Backtest prefilled from a run's **immutable snapshot**, never from the
 * strategy or list as they stand today. Nothing about the original run changes; a Strategy or List
 * deleted since the run simply is not preselected, and the form asks for one.
 */
export function rerunHref(
  runId: string,
  configuration: BacktestRunConfigurationResponse,
): string {
  return newBacktestHref({
    ...(configuration.strategyId ? { strategyId: configuration.strategyId } : {}),
    ...(configuration.stockListId
      ? { stockListId: configuration.stockListId }
      : {}),
    benchmarkCode: configuration.benchmark.code,
    startDate: configuration.startDate,
    endDate: configuration.endDate,
    initialCapital: configuration.initialCapital,
    monthlyContribution: configuration.monthlyContribution,
    maximumPositions: configuration.maximumPositions,
    fromRunId: runId,
  });
}

function positiveNumber(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Reads a prefill from a URL's query, dropping anything malformed. */
export function readBacktestPrefill(
  params: Pick<URLSearchParams, "get"> | null | undefined,
): BacktestPrefill {
  if (!params) {
    return {};
  }
  const text = (key: string) => {
    const value = params.get(key);
    return value === null || value.trim() === "" ? undefined : value.trim();
  };
  const date = (key: string) => {
    const value = text(key);
    return value !== undefined && ISO_DATE.test(value) ? value : undefined;
  };
  const prefill: Record<string, string | number> = {};
  const assign = (key: keyof BacktestPrefill, value: string | number | undefined) => {
    if (value !== undefined) {
      prefill[key] = value;
    }
  };
  assign("strategyId", text(PARAMS.strategyId));
  assign("stockListId", text(PARAMS.stockListId));
  assign("benchmarkCode", text(PARAMS.benchmarkCode));
  assign("startDate", date(PARAMS.startDate));
  assign("endDate", date(PARAMS.endDate));
  assign("initialCapital", positiveNumber(params.get(PARAMS.initialCapital)));
  assign(
    "monthlyContribution",
    positiveNumber(params.get(PARAMS.monthlyContribution)),
  );
  assign("maximumPositions", positiveNumber(params.get(PARAMS.maximumPositions)));
  assign("fromRunId", text(PARAMS.fromRunId));
  return prefill as BacktestPrefill;
}
