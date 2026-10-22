import type { SharedBacktestReportResponse } from "@intrinsic/contracts";
import { PageContainer } from "../../../components/layout/PageContainer";
import { FactGrid } from "../../../components/ui/FactGrid";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { DisclosureNote } from "../../legal/components/DisclosureNote";
import { BacktestAnnualReturns } from "../components/BacktestAnnualReturns";
import { BacktestComparisonChart } from "../components/BacktestComparisonChart";
import { BacktestMetricsRow } from "../components/BacktestMetricsRow";
import runStyles from "../components/BacktestRunView.module.css";
import {
  formatCount,
  formatDerivedPercent,
  formatMoney,
  formatPeriod,
  formatTimestamp,
} from "../utils/format";
import { resultMetrics } from "../utils/metrics";
import { SharedBacktestCta } from "./SharedBacktestCta";
import styles from "./SharedBacktestReport.module.css";

export type SharedBacktestReportProps = {
  readonly report: SharedBacktestReportResponse;
};

/**
 * A shared backtest, as anyone holding the link reads it (`docs/decisions/backtest-sharing-v1.md`).
 *
 * It is the owner's completed result page with the private parts **absent**, not hidden: the same
 * chart, the same eight KPI tiles, the same annual returns and the same disclosure, rendered by the
 * same components from the allowlisted report. What the owner's page adds — the strategy and list
 * by name and link, the frozen configuration's provenance, "Edit and run again", Share and the
 * trade log — has no counterpart here, because the data it would need never reaches this page.
 *
 * Nothing is locked or teased: there is no blurred trade log and no upgrade prompt for another
 * person's trades. The one action is the reader's own next step — a backtest of their own.
 */
export function SharedBacktestReport({ report }: SharedBacktestReportProps) {
  const { configuration, result } = report;
  const benchmarkName = configuration.benchmark.name;
  const period = formatPeriod(configuration.startDate, configuration.endDate);

  return (
    <PageContainer>
      <div
        className={runStyles.page}
        data-testid="shared-backtest"
        data-run-id={report.runId}
      >
        <SectionCard
          hero
          ariaLabel="Shared backtest result"
          testId="shared-backtest-hero"
        >
          <PageHeader
            variant="hero"
            title="Shared backtest report"
            lead={`${period} · vs ${benchmarkName}`}
            badges={
              <StatusBadge tone="neutral" testId="shared-backtest-badge">
                Read-only
              </StatusBadge>
            }
            actions={<SharedBacktestCta />}
          />

          <p className={styles.intro} data-testid="shared-backtest-intro">
            A historical simulation run on FactorSage and shared by its owner.
            The strategy&apos;s rules, the stock list and its securities, and
            the individual trades are private and are not part of this report.
          </p>

          <div className={runStyles.chartFrame}>
            {result.curve.length === 0 ? (
              <p
                className={runStyles.chartPlaceholder}
                data-testid="backtest-chart-placeholder"
              >
                This run produced no comparison curve.
              </p>
            ) : (
              <BacktestComparisonChart
                points={result.curve}
                benchmarkName={benchmarkName}
                ariaLabel={`Strategy portfolio value against ${benchmarkName} and cash. The same money invested three ways: each scenario receives the same initial capital and the same monthly contributions.`}
                periodStart={configuration.startDate}
                periodEnd={configuration.endDate}
                populating={false}
                initialCapital={configuration.initialCapital}
                monthlyContribution={configuration.monthlyContribution}
              />
            )}
          </div>

          <BacktestMetricsRow
            metrics={resultMetrics(result.summary)}
            benchmarkName={benchmarkName}
          />

          <BacktestAnnualReturns years={result.annualReturns} />

          <DisclosureNote id="backtests" className={runStyles.disclosure} />
        </SectionCard>

        <SectionCard
          title="Simulation"
          caption="Read from the run's immutable submission snapshot."
          testId="shared-backtest-configuration"
        >
          <FactGrid
            facts={[
              { label: "Period", value: period },
              { label: "Benchmark", value: benchmarkName },
              {
                label: "Initial capital",
                value: formatMoney(configuration.initialCapital),
              },
              {
                label: "Monthly contribution",
                value:
                  configuration.monthlyContribution > 0
                    ? formatMoney(configuration.monthlyContribution)
                    : "None",
              },
              {
                label: "Max positions",
                value: formatCount(configuration.maximumPositions),
              },
              {
                label: "Full position",
                value: `${formatDerivedPercent(configuration.fullPositionPercent)}%`,
              },
              {
                label: "Securities in list",
                value: formatCount(configuration.securityCount),
                testId: "shared-backtest-security-count",
              },
              {
                label: "Strategy rules",
                value: formatCount(configuration.strategyRuleCount),
                testId: "shared-backtest-rule-count",
              },
              {
                label: "Completed",
                value: formatTimestamp(report.completedAt),
              },
              {
                label: "Run ID",
                value: (
                  <code
                    className={styles.runId}
                    data-testid="shared-backtest-run-id"
                  >
                    {report.runId}
                  </code>
                ),
              },
            ]}
          />
        </SectionCard>
      </div>
    </PageContainer>
  );
}
