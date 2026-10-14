import { Notice } from "../../../components/ui/Notice";
import type { EtfConditionsGuidance } from "../utils/etf-conditions";
import styles from "./BacktestRunView.module.css";

/**
 * Whether the ETFs a run's strategy reads could be evaluated, per fund.
 *
 * Rendered for a completed run whose strategy reads an ETF and absent for every other run. A fund
 * that could not be read is why its rules never matched, so its warning is placed by the run page
 * at the top of the result, above the chart and the numbers it qualifies — a zero-trade run must
 * never read as a strategy that simply found nothing. The information that every fund was read
 * sits beside the results instead, where it explains rather than interrupts.
 */
export function BacktestEtfConditions({
  guidance,
}: {
  readonly guidance: EtfConditionsGuidance;
}) {
  return (
    <div
      className={styles.etfConditionsFrame}
      data-testid="backtest-etf-conditions"
      data-tone={guidance.tone}
    >
      <Notice tone={guidance.tone} title={guidance.title}>
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
        <p data-testid="backtest-etf-conditions-note">{guidance.note}</p>
      </Notice>
    </div>
  );
}
