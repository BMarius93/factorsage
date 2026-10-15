import { normalizeStrategyDefinition } from "@intrinsic/contracts";
import { isOngoingListMember, type LocalDate } from "@intrinsic/domain";
import {
  collectOperands,
  operandsReadStatements,
  type OperandKey,
} from "@intrinsic/strategy";
import type { ActiveMonitor } from "../monitor/monitor-repository.js";

/**
 * Which securities the stock EOD preparation keeps current, and what each one is read for.
 *
 * The **deduplicated union** of the ongoing members of every running Monitor
 * (`docs/decisions/monitor-eod-v2-proposal.md` §2–§3): a hundred Monitors watching AAPL make one
 * AAPL target, carrying the union of every operand any of them reads. That union decides two things
 * and nothing else — whether the security's statements are kept current at all, and which
 * alternative-data and split-list inputs are ingested beside its prices.
 *
 * "Running" is `listActiveMonitors`'s answer: enabled and execution-eligible customer Monitors and
 * globally enabled built-ins. A member is in only while its membership is **ongoing** on the
 * session being prepared (`isOngoingListMember`): Always eligible, or an open-ended period that has
 * begun. Bounded and future periods are not watched, so nothing is prepared for them.
 */
export type StockEodTarget = {
  securityId: string;
  symbol: string;
  /** Every security-owned operand any watching Monitor reads, ascending. */
  operands: OperandKey[];
  /** Whether any of those operands reads financial statements. */
  readsStatements: boolean;
  /** How many running Monitors watch it — observability only. */
  monitors: number;
};

export type StockEodUniverse = {
  targets: StockEodTarget[];
  /** Monitors skipped because their stored definition no longer normalizes. */
  invalidMonitorIds: string[];
};

export function stockEodUniverse(
  monitors: readonly ActiveMonitor[],
  session: LocalDate,
): StockEodUniverse {
  const bySecurity = new Map<
    string,
    { symbol: string; operands: Set<OperandKey>; monitors: number }
  >();
  const invalidMonitorIds: string[] = [];
  for (const monitor of monitors) {
    let operands: OperandKey[];
    try {
      operands = collectOperands(normalizeStrategyDefinition(monitor.definition));
    } catch {
      invalidMonitorIds.push(monitor.monitorId);
      continue;
    }
    for (const member of monitor.members) {
      if (
        !isOngoingListMember(
          { mode: member.buyWindowMode, ranges: member.buyWindows },
          session,
        )
      ) {
        continue;
      }
      const target = bySecurity.get(member.securityId) ?? {
        symbol: member.symbol,
        operands: new Set<OperandKey>(),
        monitors: 0,
      };
      target.monitors += 1;
      for (const operand of operands) {
        target.operands.add(operand);
      }
      bySecurity.set(member.securityId, target);
    }
  }
  const targets = [...bySecurity.entries()]
    .map(([securityId, target]) => {
      const operands = [...target.operands].sort();
      return {
        securityId,
        symbol: target.symbol,
        operands,
        readsStatements: operandsReadStatements(operands),
        monitors: target.monitors,
      };
    })
    // A stable order, so a run's budget defers the same securities first only when it must, and
    // logs read the same way run to run.
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
  return { targets, invalidMonitorIds };
}
