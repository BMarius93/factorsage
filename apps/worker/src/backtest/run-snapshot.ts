import {
  ACTOR_SCOPE_KINDS,
  asAlternativeDataMetric,
  collectStrategyEtfSources,
  CONDITION_OPERATORS,
  ETF_COMPATIBLE_METRIC_KINDS,
  isActorScopeId,
  isBacktestSnapshotVersion,
  isStrategyEtfSourceCode,
  TRIGGER_OPERATORS,
  withExecutableStrategyDefinition,
  type BacktestRunSnapshot,
  type BacktestSnapshotSecurity,
  type StrategyDefinition,
  type StrategyMetric,
  type StrategySignal,
} from "@intrinsic/contracts";
import type { BuyWindowConfiguration } from "@intrinsic/domain";

/** A stored submission snapshot the worker cannot execute. */
export class BacktestSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacktestSnapshotError";
  }
}

/**
 * Reads the immutable submission document a claimed run carries, and returns the form the engine
 * executes.
 *
 * The API validated this document when it wrote it, so this is not a second validation layer: it
 * is the process boundary refusing to execute something it cannot interpret — a snapshot written
 * by an older version of the product, or a hand-edited row — rather than crashing halfway through
 * a run with an undefined property.
 *
 * It is also the **one** place a snapshot's frozen strategy definition is brought up to the
 * current document schema. A run queued before a release, or recovered or retried after one, still
 * carries the schema that was current at submission: a run submitted before FINAL EXIT gained Exit
 * Rules holds `schemaVersion: 1` with a flat `finalExit.signal`, which the current engine cannot
 * read. Upgrading here rather than at each consumer is what makes every downstream read correct by
 * construction — including consumers added later, which is exactly how this defect arose.
 *
 * The stored row is never touched: `withExecutableStrategyDefinition` returns a new document and
 * nothing writes the result back. `BacktestRun.snapshot` remains byte-for-byte what was submitted,
 * which is what `AGENTS.md` invariant 12 requires of the reproducibility authority.
 *
 * It stays a document *upcast* and not a revalidation. This function's contract is unchanged: the
 * API validated the definition when it wrote it, and re-validating here would let a snapshot the
 * worker has always executed start being refused because a later release tightened a rule — the
 * retroactive reinterpretation invariant 12 exists to prevent. The one thing it reads in a rule is
 * whether the engine still defines its operator (`refuseUndefinedOperators`), because a snapshot
 * whose meaning the engine no longer has cannot be executed faithfully under any reading. The same
 * goes for an actor scope the engine does not define (`refuseUndefinedScopes`).
 *
 * Both snapshot versions are read. Version 1 is everything submitted before a rule could select
 * members of Congress directly and is still what a run without such a rule is written as; version 2
 * carries a selection. They execute through the same code — the version exists so a worker built
 * *before* the selection refuses a run it would otherwise misread (`BACKTEST_SNAPSHOT_VERSIONS`).
 */
export function parseRunSnapshot(value: unknown): BacktestRunSnapshot {
  const document = record(value, "snapshot");

  if (!isBacktestSnapshotVersion(document.snapshotVersion)) {
    throw new BacktestSnapshotError(
      `Unsupported backtest snapshot version ${String(document.snapshotVersion)}`,
    );
  }

  const strategy = record(document.strategy, "snapshot.strategy");
  record(strategy.definition, "snapshot.strategy.definition");

  const period = record(document.period, "snapshot.period");
  localDate(period.startDate, "snapshot.period.startDate");
  localDate(period.endDate, "snapshot.period.endDate");

  const capital = record(document.capital, "snapshot.capital");
  finiteNumber(capital.initialCapital, "snapshot.capital.initialCapital");
  finiteNumber(
    capital.monthlyContribution,
    "snapshot.capital.monthlyContribution",
  );

  const allocation = record(document.allocation, "snapshot.allocation");
  finiteNumber(
    allocation.maximumPositions,
    "snapshot.allocation.maximumPositions",
  );

  const benchmark = record(document.benchmark, "snapshot.benchmark");
  nonEmptyString(benchmark.code, "snapshot.benchmark.code");
  nonEmptyString(benchmark.seriesId, "snapshot.benchmark.seriesId");

  // Required, and checked here rather than discovered halfway through preparation: the calendar
  // decides which dates are simulated, so a snapshot without it cannot be executed under the
  // methodology it records. Failing at the parse is what makes that a deterministic refusal
  // instead of a silently different run.
  const executionCalendar = record(
    document.executionCalendar,
    "snapshot.executionCalendar",
  );
  nonEmptyString(
    executionCalendar.seriesId,
    "snapshot.executionCalendar.seriesId",
  );

  if (!Array.isArray(document.securities) || document.securities.length === 0) {
    throw new BacktestSnapshotError("snapshot.securities is empty");
  }
  document.securities.forEach((security, index) => {
    const entry = record(security, `snapshot.securities[${index}]`);
    nonEmptyString(
      entry.securityId,
      `snapshot.securities[${index}].securityId`,
    );
    nonEmptyString(entry.symbol, `snapshot.securities[${index}].symbol`);
    if (entry.buyWindowMode !== "FULL" && entry.buyWindowMode !== "CUSTOM") {
      throw new BacktestSnapshotError(
        `snapshot.securities[${index}].buyWindowMode is not a buy-window mode`,
      );
    }
    if (!Array.isArray(entry.buyWindows)) {
      throw new BacktestSnapshotError(
        `snapshot.securities[${index}].buyWindows is not a list`,
      );
    }
  });

  // The returned snapshot is a copy whenever the upcast changed anything: `value` — the document
  // the claim carried, and the shape of the persisted row — is never written through.
  const executable = withExecutableStrategyDefinition(
    value as BacktestRunSnapshot,
  );
  refuseUndefinedOperators(executable.strategy.definition);
  refuseUndefinedScopes(executable.strategy.definition);
  refuseUndefinedSources(executable.strategy.definition);
  refuseUnpinnedEtfSeries(executable);
  return executable;
}

/**
 * Refuses a definition whose metric carries a data source this engine does not define — an unknown
 * source kind, an ETF code outside the catalog, a source on a metric kind that takes none, or a
 * source on a Trigger, which V1 deliberately does not evaluate.
 *
 * The same refusal `refuseUndefinedScopes` is: the worker does not revalidate a snapshot, so
 * without this a source the engine cannot read would fall through `metricOperand` to a column that
 * does not exist and the rule would silently never match — or, worse under a future encoding, be
 * evaluated against the candidate stock's own series, which is the exact misinterpretation the
 * source exists to prevent. Refusing stops the run before any data is prepared and names the rule.
 */
function refuseUndefinedSources(definition: StrategyDefinition): void {
  const refuse = (
    metric: StrategyMetric,
    at: string,
    part: "CONDITION" | "TRIGGER",
  ): void => {
    const raw = metric as unknown as Record<string, unknown>;
    if (raw.source === undefined) {
      return;
    }
    const source = raw.source as { kind?: unknown; code?: unknown };
    if (
      !(ETF_COMPATIBLE_METRIC_KINDS as readonly string[]).includes(
        metric.kind,
      ) ||
      source?.kind !== "ETF" ||
      !isStrategyEtfSourceCode(source.code)
    ) {
      throw new BacktestSnapshotError(
        `snapshot.strategy.definition.${at}.metric.source is not a source this engine defines`,
      );
    }
    if (part === "TRIGGER") {
      throw new BacktestSnapshotError(
        `snapshot.strategy.definition.${at}.metric.source: an ETF-sourced trigger is not part of V1`,
      );
    }
  };
  for (const [at, signal] of definitionSignals(definition)) {
    signal.conditions.forEach((condition, index) =>
      refuse(
        condition.metric,
        `${at}.signal.conditions[${index}]`,
        "CONDITION",
      ),
    );
    if (signal.trigger) {
      refuse(signal.trigger.metric, `${at}.signal.trigger`, "TRIGGER");
    }
  }
}

/**
 * Requires the snapshot's pinned ETF series and the definition's ETF sources to agree exactly.
 *
 * A definition reading an ETF nothing pinned must never execute by silently resolving the
 * catalog's current series — that would re-derive an input from mutable configuration, which
 * `AGENTS.md` invariant 12 forbids a run to do — and a pinned series nothing reads is a snapshot
 * that does not say what it means. Either way the run is refused at the parse, before any data.
 */
function refuseUnpinnedEtfSeries(snapshot: BacktestRunSnapshot): void {
  const named = collectStrategyEtfSources(snapshot.strategy.definition);
  const pinned = snapshot.etfSeries ?? [];
  for (const entry of pinned) {
    if (typeof entry.seriesId !== "string" || entry.seriesId.trim() === "") {
      throw new BacktestSnapshotError(
        `snapshot.etfSeries pins ${String(entry.code)} to no series`,
      );
    }
  }
  const pinnedCodes = new Set(pinned.map((entry) => entry.code));
  for (const code of named) {
    if (!pinnedCodes.has(code)) {
      throw new BacktestSnapshotError(
        `snapshot.strategy.definition reads ${code} but snapshot.etfSeries pins no series for it`,
      );
    }
  }
  for (const entry of pinned) {
    if (!(named as readonly string[]).includes(entry.code)) {
      throw new BacktestSnapshotError(
        `snapshot.etfSeries pins ${entry.code}, which the definition does not read`,
      );
    }
  }
}

/**
 * Refuses a definition whose alternative-data rule is scoped in a way this engine does not define.
 *
 * The worker does not revalidate a snapshot, so without this an actor scope written by a newer
 * build would reach the loader as whatever its unknown shape happened to serialize to. That is how
 * a run comes to count nobody and still complete: the rule reads zero on every session, and
 * `Congress sales is below 1` buys everything. Refusing here stops the run before any data is
 * prepared and says which rule it could not read.
 *
 * A selection that names nobody is refused for the same reason. The API never writes one — an empty
 * selection is not a valid rule — so a snapshot holding one is corrupt, not a quiet strategy.
 */
function refuseUndefinedScopes(definition: StrategyDefinition): void {
  const refuse = (metric: StrategyMetric, at: string): void => {
    const alternative = asAlternativeDataMetric(metric);
    if (alternative?.kind !== "CONGRESS_ACTIVITY") {
      return;
    }
    const scope = alternative.scope as { kind?: unknown; actorIds?: unknown };
    if (
      typeof scope?.kind !== "string" ||
      !(ACTOR_SCOPE_KINDS as readonly string[]).includes(scope.kind)
    ) {
      throw new BacktestSnapshotError(
        `snapshot.strategy.definition.${at}.metric.scope ${String(scope?.kind)} is not a scope this engine defines`,
      );
    }
    if (
      scope.kind === "ACTORS" &&
      (!Array.isArray(scope.actorIds) ||
        scope.actorIds.length === 0 ||
        !scope.actorIds.every(isActorScopeId))
    ) {
      throw new BacktestSnapshotError(
        `snapshot.strategy.definition.${at}.metric.scope selects no readable actor`,
      );
    }
  };
  for (const [at, signal] of definitionSignals(definition)) {
    signal.conditions.forEach((condition, index) =>
      refuse(condition.metric, `${at}.signal.conditions[${index}]`),
    );
    if (signal.trigger) {
      refuse(signal.trigger.metric, `${at}.signal.trigger`);
    }
  }
}

/** Every Signal of a definition with the path it sits at, for a refusal that names its rule. */
function definitionSignals(
  definition: StrategyDefinition,
): [string, StrategySignal][] {
  return [
    ...definition.buyLevels.map((level, index): [string, StrategySignal] => [
      `buyLevels[${index}]`,
      level.signal,
    ]),
    ...definition.sellLevels.map((level, index): [string, StrategySignal] => [
      `sellLevels[${index}]`,
      level.signal,
    ]),
    ...(definition.finalExit?.rules ?? []).map(
      (rule, index): [string, StrategySignal] => [
        `finalExit.rules[${index}]`,
        rule.signal,
      ],
    ),
  ];
}

/**
 * Refuses a definition naming an operator this engine does not define.
 *
 * The same kind of refusal as an unknown snapshot version, not a product rule judged again: the
 * product removed `is at least` / `is at most` on 2026-09-28, and `>= 2` is not `> 2`, so a snapshot
 * still naming one has no meaning the engine may assume and is never mapped onto a neighbour. The
 * evaluator would refuse it too, but only once it reached the rule; here the run stops before any
 * data is prepared, whatever that data would have been.
 */
function refuseUndefinedOperators(definition: StrategyDefinition): void {
  for (const [at, signal] of definitionSignals(definition)) {
    signal.conditions.forEach((condition, index) =>
      refuseUndefinedOperator(
        CONDITION_OPERATORS,
        condition.operator,
        `${at}.signal.conditions[${index}]`,
      ),
    );
    if (signal.trigger) {
      refuseUndefinedOperator(
        TRIGGER_OPERATORS,
        signal.trigger.operator,
        `${at}.signal.trigger`,
      );
    }
  }
}

function refuseUndefinedOperator(
  defined: readonly string[],
  operator: string,
  at: string,
): void {
  if (!defined.includes(operator)) {
    throw new BacktestSnapshotError(
      `snapshot.strategy.definition.${at}.operator ${operator} is not an operator this engine defines`,
    );
  }
}

/**
 * The stored document, typed but **not** upgraded — what forensics keep.
 *
 * `parseRunSnapshot` returns the executable projection, which is what the engine consumes. The
 * debug archive wants the opposite: the submission document exactly as stored, because that is the
 * reproducibility authority a reviewer re-runs from. The upcast is deterministic, so the executed
 * form is always derivable from the stored one; the reverse is not true.
 *
 * A cast rather than a copy: `parseRunSnapshot` has already proven this document's structure, and
 * this exists to make the stored-versus-executable distinction visible at the call site rather than
 * leaving it an anonymous `as`.
 */
export function storedRunSnapshot(value: unknown): BacktestRunSnapshot {
  return value as BacktestRunSnapshot;
}

/**
 * The frozen buy eligibility of one list member.
 *
 * Read from the snapshot rather than from `StockListBuyWindow`: editing the list after submission
 * must never change what a running or completed backtest was allowed to buy.
 */
export function snapshotBuyWindows(
  security: BacktestSnapshotSecurity,
): BuyWindowConfiguration {
  return {
    mode: security.buyWindowMode,
    ranges: security.buyWindows.map((range) => ({
      startDate: range.startDate,
      endDate: range.endDate,
    })),
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BacktestSnapshotError(`${path} is not an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BacktestSnapshotError(`${path} is missing`);
  }
}

function finiteNumber(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BacktestSnapshotError(`${path} is not a number`);
  }
}

function localDate(value: unknown, path: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BacktestSnapshotError(`${path} is not a calendar date`);
  }
}
