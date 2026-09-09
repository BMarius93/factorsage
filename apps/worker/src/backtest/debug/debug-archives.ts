import type { StructuredLogger } from "@intrinsic/observability";
import type { ProviderRequestEvent } from "@intrinsic/stock-data";
import {
  BacktestDebugArchive,
  type BacktestDebugArchiveContext,
  type ProviderRequestCounts,
} from "./backtest-debug-archive.js";

/**
 * Opens one forensic capture per backtest attempt.
 *
 * A separate seam from the archive itself so the processor's dependency is `undefined` when the
 * feature is off. That is the strongest form of "no filesystem work happens when disabled": there
 * is no object to call, rather than an object that decides to do nothing.
 */
export interface BacktestDebugArchives {
  open(
    context: BacktestDebugArchiveContext,
  ): Promise<BacktestDebugArchive | null>;
}

export type FilesystemBacktestDebugArchivesOptions = {
  directory: string;
  mode: string;
  logger: StructuredLogger;
  now?: () => Date;
};

export class FilesystemBacktestDebugArchives implements BacktestDebugArchives {
  constructor(
    private readonly options: FilesystemBacktestDebugArchivesOptions,
  ) {}

  async open(
    context: BacktestDebugArchiveContext,
  ): Promise<BacktestDebugArchive | null> {
    return BacktestDebugArchive.open({
      directory: this.options.directory,
      mode: this.options.mode,
      context,
      logger: this.options.logger,
      now: this.options.now ?? (() => new Date()),
    });
  }
}

/**
 * Counts the provider requests this process made.
 *
 * Attribution to a run is honest here and only here: a worker child claims **at most one backtest
 * at a time**, so the requests between the start and end of a phase in this process are that run's.
 * It is a counter over the observer `@intrinsic/stock-data` already exposes — not a second gate, not
 * a second cache, and not a way around the shared FMP budget.
 */
export class ProviderRequestMeter {
  private total = 0;
  private readonly byDataset = new Map<string, number>();
  private readonly byReason = new Map<string, number>();

  observe(event: ProviderRequestEvent): void {
    this.total += 1;
    this.byDataset.set(
      event.dataset,
      (this.byDataset.get(event.dataset) ?? 0) + 1,
    );
    this.byReason.set(event.reason, (this.byReason.get(event.reason) ?? 0) + 1);
  }

  counts(): ProviderRequestCounts {
    return {
      total: this.total,
      byDataset: Object.fromEntries([...this.byDataset].sort()),
      byReason: Object.fromEntries([...this.byReason].sort()),
    };
  }
}

/** `after - before`, so a phase reports its own traffic rather than the process's lifetime total. */
export function providerRequestsSince(
  before: ProviderRequestCounts | null,
  after: ProviderRequestCounts | null,
): ProviderRequestCounts | null {
  if (!after) {
    return null;
  }
  if (!before) {
    return after;
  }
  return {
    total: after.total - before.total,
    byDataset: subtract(before.byDataset, after.byDataset),
    byReason: subtract(before.byReason, after.byReason),
  };
}

function subtract(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const [key, value] of Object.entries(after)) {
    const difference = value - (before[key] ?? 0);
    if (difference !== 0) {
      delta[key] = difference;
    }
  }
  return delta;
}
