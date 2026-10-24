import type { DemoBacktestResponse } from "@intrinsic/contracts";
import Link from "next/link";
import { PageContainer } from "../../components/layout/PageContainer";
import { EmptyState } from "../../components/ui/EmptyState";
import { PageHeader } from "../../components/ui/PageHeader";
import forms from "../../components/ui/forms.module.css";
import {
  formatHeadlinePercent,
  sharedBacktestPeriodLabel,
} from "../backtests/sharing/share-headline";
import { formatCount, formatPeriod } from "../backtests/utils/format";
import styles from "./DemoBacktestsPage.module.css";

type DemoBacktestsPageProps = {
  readonly demos: readonly DemoBacktestResponse[];
};

function signedPercent(value: number): string {
  const formatted = formatHeadlinePercent(value);
  return value > 0 && !formatted.startsWith("+") ? `+${formatted}` : formatted;
}

/**
 * The public demonstration shelf (`docs/decisions/entitlements-v2.md` §4).
 *
 * What a Guest can see of backtesting without an account: precomputed reports the operator chose to
 * feature. Each card links to the ordinary shared report, and nothing here runs, queues or prices a
 * backtest — the figures are the stored headline the report itself shows.
 */
export function DemoBacktestsPage({ demos }: DemoBacktestsPageProps) {
  return (
    <PageContainer>
      <div className={styles.page} data-testid="demo-backtests-page">
        <PageHeader
          title="Demo backtests"
          lead="Precomputed example backtests you can open without an account. They show what a FactorSage report looks like; reading one runs nothing."
          actions={
            <Link className={forms.secondaryButton} href="/pricing" data-testid="demo-pricing-link">
              See plans
            </Link>
          }
        />
        {demos.length === 0 ? (
          <EmptyState
            title="No demonstrations yet"
            body="Example backtests will appear here once they are published."
            testId="demo-backtests-empty"
          />
        ) : (
          <ul className={styles.grid} data-testid="demo-backtests-list">
            {demos.map((demo) => (
              <li key={demo.path} className={styles.card} data-testid="demo-backtest">
                <div className={styles.head}>
                  <h2 className={styles.title}>{demo.title}</h2>
                  <p className={styles.meta}>
                    {sharedBacktestPeriodLabel(
                      demo.configuration.startDate,
                      demo.configuration.endDate,
                    )}{" "}
                    · {formatPeriod(demo.configuration.startDate, demo.configuration.endDate)}
                  </p>
                </div>
                {demo.description ? <p className={styles.description}>{demo.description}</p> : null}
                <dl className={styles.figures}>
                  <div>
                    <dt>Strategy CAGR</dt>
                    <dd data-testid="demo-cagr">
                      {demo.headline.portfolioCagrPercent === null
                        ? "—"
                        : signedPercent(demo.headline.portfolioCagrPercent)}
                    </dd>
                  </div>
                  <div>
                    <dt>{demo.configuration.benchmark.name} CAGR</dt>
                    <dd>
                      {demo.headline.benchmarkCagrPercent === null
                        ? "—"
                        : signedPercent(demo.headline.benchmarkCagrPercent)}
                    </dd>
                  </div>
                  <div>
                    <dt>Max drawdown</dt>
                    <dd>{formatHeadlinePercent(demo.headline.maxDrawdownPercent)}</dd>
                  </div>
                  <div>
                    <dt>Universe</dt>
                    <dd>
                      {formatCount(demo.configuration.securityCount)}{" "}
                      {demo.configuration.securityCount === 1 ? "stock" : "stocks"}
                    </dd>
                  </div>
                </dl>
                <Link className={forms.secondaryButton} href={demo.path} data-testid="demo-open">
                  Open report
                </Link>
              </li>
            ))}
          </ul>
        )}
        <p className={styles.disclaimer}>
          Simulated results on historical data. Past performance does not guarantee future results.
        </p>
      </div>
    </PageContainer>
  );
}
