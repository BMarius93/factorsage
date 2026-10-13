import type { BacktestEtfConditionDiagnosticsResponse } from "@intrinsic/contracts";
import { Notice } from "../../../components/ui/Notice";
import { etfConditionsGuidance } from "../utils/etf-conditions";
import styles from "./BacktestRunView.module.css";

/**
 * Whether the ETFs a run's strategy reads could be evaluated, per fund.
 *
 * Rendered for a completed run whose strategy reads an ETF and absent for every other run. It is a
 * statement about the run's inputs, so it sits with the result rather than with the configuration:
 * a fund that could not be read is why its rules never matched, and that has to be visible next to
 * the numbers it explains rather than only in a log.
 */
export function BacktestEtfConditions({
  rows,
}: {
  readonly rows: readonly BacktestEtfConditionDiagnosticsResponse[] | undefined;
}) {
  const guidance = etfConditionsGuidance(rows);
  if (!guidance) {
    return null;
  }
  return (
    <Notice
      tone={guidance.tone}
      title={guidance.title}
      testId="backtest-etf-conditions"
    >
      <ul className={styles.etfConditions}>
        {guidance.lines.map((line) => (
          <li
            key={line.code}
            data-testid="backtest-etf-condition"
            data-ticker={line.ticker}
            data-ready={line.ready ? "true" : "false"}
          >
            <strong>{line.ticker}</strong> — {line.text}
          </li>
        ))}
      </ul>
      <p>{guidance.note}</p>
    </Notice>
  );
}
