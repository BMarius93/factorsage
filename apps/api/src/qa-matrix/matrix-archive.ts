import type {
  BacktestRunSnapshot,
  ConditionOperator,
  StrategyCondition,
  StrategyMetric,
  StrategySignal,
  StrategyTrigger,
  StrategyValue,
  TriggerOperator,
} from "@intrinsic/contracts";
import { IS_CLOSE_TO_TOLERANCE } from "@intrinsic/contracts";
import type { InvariantResult } from "./matrix-invariants";

/**
 * The three invariants persisted results cannot settle, proven from the forensic archive.
 *
 * A run's stored numbers can say *what* the engine did. Whether it was entitled to depends on what
 * it actually saw, and the evaluation frames the day loop consumed are released at the end of each
 * calendar-year window and persisted nowhere. `BACKTEST_DEBUG_ARCHIVE=full` writes exactly those
 * frames, which is what makes this possible for the golden combinations.
 *
 * **Nothing here imports the evaluator.** The predicates below are re-derived from the product
 * grammar in `ai/product/strategies.md` — `is above`, `is below`, `is close to` at the fixed 2%
 * tolerance, `crosses above` and `crosses below` against the previous eligible row — reading only
 * the frame's own columns and the snapshot's normalized definition, which is data. Calling
 * `@intrinsic/strategy` here would ask the same code the same question and agree with every bug it
 * exists to find.
 *
 * The scope is BUY levels, and that boundary is the product's rather than a convenience: a BUY
 * Signal may not contain a position-dependent metric, so a BUY is decidable from market data alone.
 * SELL and FINAL EXIT signals may compare `Gain` or `Loss`, which need simulated position state and
 * are not re-derivable from a frame; they stay outside this check rather than being approximated.
 */

export type ArchiveFrame = {
  readonly securityId: string;
  readonly symbol: string;
  readonly window: {
    readonly year: string;
    readonly index: number;
    readonly firstSimulatedDate: string;
    readonly lastSimulatedDate: string;
  };
  readonly contextRowCount: number;
  readonly contextRowDates: readonly string[];
  readonly periodStartIndex: number;
  readonly dates: readonly string[];
  readonly closes: readonly number[];
  readonly operandKeys: readonly string[];
  readonly operands: Readonly<Record<string, readonly number[]>>;
};

export type ArchiveTrade = {
  readonly sequence: number;
  readonly date: string;
  readonly securityId: string;
  readonly symbol: string;
  readonly action: string;
  readonly levelId: string | null;
};

export type ArchiveContents = {
  readonly snapshot: BacktestRunSnapshot;
  /** Keyed `<securityId>|<year>`. */
  readonly frames: ReadonlyMap<string, ArchiveFrame>;
  readonly trades: readonly ArchiveTrade[];
};

const NUMBER = (value: unknown): number =>
  typeof value === "number" ? value : Number.NaN;

/** A frame column, or an all-`NaN` stand-in — absence is never a zero. */
function column(frame: ArchiveFrame, key: string): readonly number[] {
  return frame.operands[key] ?? frame.dates.map(() => Number.NaN);
}

function metricSeries(
  frame: ArchiveFrame,
  metric: StrategyMetric,
): readonly number[] | null {
  switch (metric.kind) {
    case "PRICE":
      return frame.closes;
    case "MOVING_AVERAGE":
    case "OSCILLATOR":
      return column(frame, `series:${metric.seriesId}`);
    case "MARGIN_OF_SAFETY":
      return column(frame, `margin-of-safety:${metric.sourceId}`);
    case "GAIN":
    case "LOSS":
      // Position-dependent: not decidable from a frame, and forbidden in a BUY Signal anyway.
      return null;
  }
}

function valueSeries(
  frame: ArchiveFrame,
  value: StrategyValue,
): readonly number[] {
  if (value.kind === "SERIES") {
    return column(frame, `series:${value.seriesId}`);
  }
  return frame.dates.map(() => value.value);
}

const usable = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value);

function conditionHolds(
  operator: ConditionOperator,
  metric: number,
  value: number,
): boolean {
  switch (operator) {
    case "IS_ABOVE":
      return metric > value;
    case "IS_BELOW":
      return metric < value;
    case "IS_CLOSE_TO":
      // `abs(metric - value) / abs(value) <= 0.02`; an unusable divisor is NOT_EVALUABLE.
      return (
        value !== 0 &&
        Math.abs(metric - value) / Math.abs(value) <= IS_CLOSE_TO_TOLERANCE
      );
  }
}

function triggerHolds(
  operator: TriggerOperator,
  metric: number,
  value: number,
  previousMetric: number,
  previousValue: number,
): boolean {
  switch (operator) {
    case "CROSSES_ABOVE":
      return metric > value && previousMetric <= previousValue;
    case "CROSSES_BELOW":
      return metric < value && previousMetric >= previousValue;
  }
}

type Evaluation = "TRUE" | "FALSE" | "NOT_EVALUABLE";

function evaluateCondition(
  frame: ArchiveFrame,
  condition: StrategyCondition,
  index: number,
): Evaluation {
  const metrics = metricSeries(frame, condition.metric);
  if (!metrics) {
    return "NOT_EVALUABLE";
  }
  const values = valueSeries(frame, condition.value);
  const metric = NUMBER(metrics[index]);
  const value = NUMBER(values[index]);
  if (!usable(metric) || !usable(value)) {
    return "NOT_EVALUABLE";
  }
  return conditionHolds(condition.operator, metric, value) ? "TRUE" : "FALSE";
}

function evaluateTrigger(
  frame: ArchiveFrame,
  trigger: StrategyTrigger,
  index: number,
): Evaluation {
  if (index < 1) {
    // No previous eligible row in this frame. That is precisely what the retained context row
    // exists to prevent at a year boundary, so its absence is itself a finding (invariant 37).
    return "NOT_EVALUABLE";
  }
  const metrics = metricSeries(frame, trigger.metric);
  if (!metrics) {
    return "NOT_EVALUABLE";
  }
  const values = valueSeries(frame, trigger.value);
  const metric = NUMBER(metrics[index]);
  const value = NUMBER(values[index]);
  const previousMetric = NUMBER(metrics[index - 1]);
  const previousValue = NUMBER(values[index - 1]);
  if (
    !usable(metric) ||
    !usable(value) ||
    !usable(previousMetric) ||
    !usable(previousValue)
  ) {
    return "NOT_EVALUABLE";
  }
  return triggerHolds(
    trigger.operator,
    metric,
    value,
    previousMetric,
    previousValue,
  )
    ? "TRUE"
    : "FALSE";
}

/** Conditions ANDed, with the optional Trigger ANDed for the same date. */
function evaluateSignal(
  frame: ArchiveFrame,
  signal: StrategySignal,
  index: number,
): Evaluation {
  let result: Evaluation = "TRUE";
  for (const condition of signal.conditions) {
    const outcome = evaluateCondition(frame, condition, index);
    if (outcome === "FALSE") {
      return "FALSE";
    }
    if (outcome === "NOT_EVALUABLE") {
      result = "NOT_EVALUABLE";
    }
  }
  if (signal.trigger) {
    const outcome = evaluateTrigger(frame, signal.trigger, index);
    if (outcome === "FALSE") {
      return "FALSE";
    }
    if (outcome === "NOT_EVALUABLE") {
      result = "NOT_EVALUABLE";
    }
  }
  return result;
}

const VIOLATION_CAP = 8;

function report(
  id: number,
  key: string,
  title: string,
  violations: readonly string[],
  passDetail: string,
): InvariantResult {
  if (violations.length === 0) {
    return { id, key, title, status: "PASS", detail: passDetail };
  }
  return {
    id,
    key,
    title,
    status: "FAIL",
    detail: `${violations.length} violation${violations.length === 1 ? "" : "s"}`,
    violations:
      violations.length <= VIOLATION_CAP
        ? violations
        : [
            ...violations.slice(0, VIOLATION_CAP),
            `… and ${violations.length - VIOLATION_CAP} more`,
          ],
  };
}

/**
 * Invariants 36, 37 and 38, from one attempt's archive.
 *
 * Returns replacements for the `NEEDS_ARCHIVE` placeholders the persisted-evidence validators emit,
 * so a golden combination's report carries a verdict where every other combination carries an
 * explanation of why there is none.
 */
export function verifyArchiveInvariants(
  archive: ArchiveContents,
): readonly InvariantResult[] {
  const definition = archive.snapshot.strategy.definition;
  const buyLevels = new Map(
    definition.buyLevels.map((level) => [level.id, level]),
  );
  const securities = new Map(
    archive.snapshot.securities.map((security) => [
      security.securityId,
      security,
    ]),
  );

  const signalViolations: string[] = [];
  const boundaryViolations: string[] = [];
  let verifiedBuys = 0;
  let boundaryBuys = 0;

  for (const trade of archive.trades) {
    if (trade.action !== "BUY" || trade.levelId === null) {
      continue;
    }
    const level = buyLevels.get(trade.levelId);
    if (!level) {
      signalViolations.push(
        `#${trade.sequence} ${trade.symbol} names BUY level \`${trade.levelId}\`, absent from the snapshot.`,
      );
      continue;
    }
    const frame = archive.frames.get(
      `${trade.securityId}|${trade.date.slice(0, 4)}`,
    );
    if (!frame) {
      signalViolations.push(
        `#${trade.sequence} ${trade.symbol} ${trade.date}: the archive holds no frame for that year.`,
      );
      continue;
    }
    const index = frame.dates.indexOf(trade.date);
    if (index < 0) {
      signalViolations.push(
        `#${trade.sequence} ${trade.symbol} traded on ${trade.date}, a date its evaluation frame does not contain.`,
      );
      continue;
    }
    const outcome = evaluateSignal(frame, level.signal, index);
    if (outcome !== "TRUE") {
      signalViolations.push(
        `#${trade.sequence} ${trade.symbol} ${trade.date} level ${level.percentage}%: the Signal ` +
          `re-derived from the consumed frame is ${outcome}, not TRUE.`,
      );
    } else {
      verifiedBuys += 1;
    }

    const security = securities.get(trade.securityId);
    if (security && security.buyWindowMode === "CUSTOM") {
      const inside = security.buyWindows.some(
        (range) =>
          trade.date >= range.startDate &&
          (range.endDate === null || trade.date <= range.endDate),
      );
      if (!inside) {
        boundaryViolations.push(
          `#${trade.sequence} ${trade.symbol} BUY on ${trade.date} lies outside every persisted window.`,
        );
      }
      if (
        security.buyWindows.some(
          (range) =>
            trade.date === range.startDate || trade.date === range.endDate,
        )
      ) {
        boundaryBuys += 1;
      }
    }
  }

  // Invariant 37: the row a Trigger reads as `t - 1` at a year boundary is the retained context
  // row, which no other artefact holds. The rule is conditional, and the condition matters: a
  // security that had no eligible row in any earlier window has nothing to retain, which is
  // exactly the case for a listing that opens mid-run. Requiring a context row there would report
  // correct behaviour as a defect — `AMZN` first trades in May 1997 and its 1997 window has no
  // 1996 row by construction.
  const contextViolations: string[] = [];
  const framesBySecurity = new Map<string, ArchiveFrame[]>();
  for (const frame of archive.frames.values()) {
    const list = framesBySecurity.get(frame.securityId) ?? [];
    list.push(frame);
    framesBySecurity.set(frame.securityId, list);
  }
  let boundariesChecked = 0;

  for (const frames of framesBySecurity.values()) {
    const ordered = [...frames].sort(
      (left, right) => left.window.index - right.window.index,
    );
    /** Last simulated date of the most recent earlier window that had one. */
    let previousSimulatedDate: string | null = null;

    for (const frame of ordered) {
      const simulatedRows = frame.dates.length - frame.contextRowCount;

      if (frame.periodStartIndex !== frame.contextRowCount) {
        contextViolations.push(
          `${frame.symbol} ${frame.window.year}: periodStartIndex ${frame.periodStartIndex} does ` +
            `not follow the ${frame.contextRowCount} retained context row(s).`,
        );
      }
      for (const date of frame.contextRowDates) {
        if (date >= frame.window.firstSimulatedDate) {
          contextViolations.push(
            `${frame.symbol} ${frame.window.year}: context row ${date} is inside the simulated ` +
              `window, which would re-simulate a date the run already had.`,
          );
          break;
        }
      }
      if (
        simulatedRows > 0 &&
        (frame.dates[frame.periodStartIndex] as string) <
          frame.window.firstSimulatedDate
      ) {
        contextViolations.push(
          `${frame.symbol} ${frame.window.year}: the first simulated row is dated ` +
            `${frame.dates[frame.periodStartIndex] as string}, before the window opens on ` +
            `${frame.window.firstSimulatedDate}.`,
        );
      }

      if (previousSimulatedDate === null) {
        // Nothing to carry yet. A context row here would be data from before the security had any.
        if (frame.contextRowCount > 0 && frame.window.index > 0) {
          contextViolations.push(
            `${frame.symbol} ${frame.window.year}: carries ${frame.contextRowCount} context row(s) ` +
              "although no earlier window held a single eligible row.",
          );
        }
      } else if (frame.window.index > 0 && simulatedRows > 0) {
        boundariesChecked += 1;
        if (frame.contextRowCount < 1) {
          contextViolations.push(
            `${frame.symbol} ${frame.window.year}: no row retained across the year boundary, so a ` +
              `Trigger on ${frame.dates[frame.periodStartIndex] as string} had no \`t - 1\` even ` +
              `though ${previousSimulatedDate} was simulated.`,
          );
        } else {
          const lastContext = frame.contextRowDates[
            frame.contextRowDates.length - 1
          ] as string;
          if (lastContext !== previousSimulatedDate) {
            contextViolations.push(
              `${frame.symbol} ${frame.window.year}: the retained context row is ${lastContext}, ` +
                `not ${previousSimulatedDate} — the security's own last eligible row of the ` +
                "previous window, which is what `t - 1` has to be.",
            );
          }
        }
      }

      if (simulatedRows > 0) {
        previousSimulatedDate = frame.dates[frame.dates.length - 1] as string;
      }
    }
  }

  return [
    report(
      36,
      "trade-signal-evidence",
      "Every trade maps to a level whose Signal was TRUE in the consumed frame",
      signalViolations,
      `${verifiedBuys} BUY(s) re-derived TRUE from the frame columns the day loop consumed; ` +
        "SELL and FINAL EXIT signals may read position state and are out of scope here",
    ),
    report(
      37,
      "trigger-previous-row",
      "Trigger previous-row semantics across annual windows",
      contextViolations,
      `${boundariesChecked} year boundaries carried the security's own previous eligible row as ` +
        "its `t - 1`; a later listing with no earlier row correctly carried none",
    ),
    report(
      38,
      "buy-window-boundaries",
      "Buy-window boundary inclusion",
      boundaryViolations,
      `${boundaryBuys} BUY(s) executed exactly on a window endpoint, every BUY inside a persisted window`,
    ),
  ];
}

/**
 * Reads one `.zip` archive.
 *
 * Only the four members this verification needs are extracted — the snapshot, the frames, the trade
 * log — so a thirty-year archive is not held in memory to check a handful of dates.
 */
export async function readArchive(path: string): Promise<ArchiveContents> {
  const { open } = (await import("yauzl")) as typeof import("yauzl");
  const entries = await new Promise<Map<string, Buffer>>((resolve, reject) => {
    open(path, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error(`Could not open ${path}`));
        return;
      }
      const collected = new Map<string, Buffer>();
      zip.on("entry", (entry) => {
        const name = entry.fileName as string;
        const wanted =
          name === "snapshot.json" ||
          name === "result/trades.ndjson" ||
          name.startsWith("frames/");
        if (!wanted) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error(`Could not read ${name}`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            collected.set(name, Buffer.concat(chunks));
            zip.readEntry();
          });
          stream.on("error", reject);
        });
      });
      zip.on("end", () => resolve(collected));
      zip.on("error", reject);
      zip.readEntry();
    });
  });

  const snapshotRaw = entries.get("snapshot.json");
  if (!snapshotRaw) {
    throw new Error(`${path} contains no snapshot.json`);
  }
  const snapshot = JSON.parse(
    snapshotRaw.toString("utf8"),
  ) as BacktestRunSnapshot;

  const frames = new Map<string, ArchiveFrame>();
  for (const [name, buffer] of entries) {
    if (!name.startsWith("frames/")) {
      continue;
    }
    const frame = JSON.parse(buffer.toString("utf8")) as ArchiveFrame;
    frames.set(`${frame.securityId}|${frame.window.year}`, frame);
  }

  const tradesRaw = entries.get("result/trades.ndjson");
  const trades: ArchiveTrade[] = [];
  if (tradesRaw) {
    for (const line of tradesRaw.toString("utf8").split("\n")) {
      if (line.trim()) {
        trades.push(JSON.parse(line) as ArchiveTrade);
      }
    }
  }
  return { snapshot, frames, trades };
}

/** Finds an attempt's archive by run id in a directory of them. */
/**
 * How many archives the directory actually holds.
 *
 * The plan says how many should exist; this says how many do. They were never compared, which is
 * how a sweep that produced ten archives where six were planned printed the plan and passed.
 */
export async function countArchives(directory: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  try {
    const names = await readdir(directory);
    return names.filter(
      (name) => name.startsWith("backtest-debug-") && name.endsWith(".zip"),
    ).length;
  } catch {
    return 0;
  }
}

export async function findArchive(
  directory: string,
  runId: string,
): Promise<string | null> {
  const { readdir } = await import("node:fs/promises");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return null;
  }
  const matches = names
    .filter(
      (name) =>
        name.startsWith(`backtest-debug-${runId}-`) && name.endsWith(".zip"),
    )
    .sort();
  const last = matches[matches.length - 1];
  return last ? `${directory}/${last}` : null;
}
