import {
  backtestRunLabel,
  type SharedBacktestReportResponse,
  type SharedDefinitionResponse,
} from "@intrinsic/contracts";
import { PageContainer } from "../../../components/layout/PageContainer";
import { FactGrid } from "../../../components/ui/FactGrid";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { DisclosureNote } from "../../legal/components/DisclosureNote";
import { BacktestAnnualReturns } from "../components/BacktestAnnualReturns";
import { BacktestResultOverview } from "../components/BacktestResultOverview";
import runStyles from "../components/BacktestRunView.module.css";
import {
  formatCount,
  formatDerivedPercent,
  formatMoney,
  formatPeriod,
  formatTimestamp,
} from "../utils/format";
import { resultMetrics } from "../utils/metrics";
import {
  definitionKindLabel,
  definitionOriginLabel,
  definitionWithheldText,
  type DefinitionKind,
} from "./definition-labels";
import { SharedBacktestCta } from "./SharedBacktestCta";
import styles from "./SharedBacktestReport.module.css";

export type SharedBacktestReportProps = {
  readonly report: SharedBacktestReportResponse;
};

/**
 * A shared backtest, as anyone holding the link reads it (`docs/decisions/backtest-sharing-v1.md`).
 *
 * It is the owner's completed result page with the private parts **absent**, not hidden: the same
 * Run ID title, the same overview — the chart and the eight KPI tiles side by side on a wide
 * desktop — the same Strategy vs benchmark annual-returns heatmap and the same disclosure,
 * rendered by the same components from the allowlisted report. What the owner's page adds — the
 * strategy and list by name and link, the frozen configuration's provenance, "Edit and run again",
 * Share and the trade log — has no counterpart here, because the data it would need never reaches
 * this page.
 *
 * Where the share recorded them (`docs/decisions/canonical-definitions-v1.md`), the report says
 * where the strategy and the list come from — built-in, custom or derived — and carries their
 * generated descriptions wherever the publication rule and the owner allow. Both were written when
 * the link was created, from the run's frozen inputs, and are only rendered here. A link created
 * before that keeps exactly the report it always had.
 *
 * Nothing is locked or teased: there is no blurred trade log and no upgrade prompt for another
 * person's trades. The one action is the reader's own next step — a backtest of their own.
 */
export function SharedBacktestReport({ report }: SharedBacktestReportProps) {
  const { configuration, result } = report;
  const benchmarkName = configuration.benchmark.name;
  const period = formatPeriod(configuration.startDate, configuration.endDate);
  const runLabel = backtestRunLabel(report.runNumber);
  const definitions = report.definitions;
  const rulesPublished =
    definitions?.strategy.description.status === "published";

  return (
    <PageContainer>
      <div className={runStyles.page} data-testid="shared-backtest">
        <SectionCard
          hero
          ariaLabel="Shared backtest result"
          testId="shared-backtest-hero"
        >
          {/* The run's own identity, as on its owner's page — the Run ID, never the strategy it
              executed — and, in the line under it, what this page is. The strategy and list the
              owner's line names are private, so the period and benchmark stand alone. */}
          <PageHeader
            variant="hero"
            title={
              <span data-testid="shared-backtest-run-title">{runLabel}</span>
            }
            lead={
              <span
                className={runStyles.meta}
                data-testid="shared-backtest-metadata"
              >
                <span className={runStyles.metaItem}>
                  Shared backtest report
                </span>
                <span className={runStyles.metaSeparator} aria-hidden="true">
                  ·
                </span>
                <span className={runStyles.metaItem}>{period}</span>
                <span className={runStyles.metaSeparator} aria-hidden="true">
                  ·
                </span>
                <span className={runStyles.metaItem}>
                  Benchmark: {benchmarkName}
                </span>
              </span>
            }
            leadWidth="full"
            badges={
              <StatusBadge tone="neutral" testId="shared-backtest-badge">
                Read-only
              </StatusBadge>
            }
            actions={<SharedBacktestCta />}
          />

          <p className={styles.intro} data-testid="shared-backtest-intro">
            A historical simulation run on FactorSage and shared by its owner.{" "}
            {rulesPublished
              ? "The stock list's securities and the individual trades are private and are not part of this report."
              : "The strategy's rules, the stock list and its securities, and the individual trades are private and are not part of this report."}
          </p>

          <BacktestResultOverview
            curve={result.curve}
            metrics={resultMetrics(result.summary)}
            benchmarkName={benchmarkName}
            periodStart={configuration.startDate}
            periodEnd={configuration.endDate}
            initialCapital={configuration.initialCapital}
            monthlyContribution={configuration.monthlyContribution}
            populating={false}
          />

          <BacktestAnnualReturns
            years={result.annualReturns}
            benchmarkName={benchmarkName}
          />

          <DisclosureNote id="backtests" className={runStyles.disclosure} />
        </SectionCard>

        {definitions ? (
          <SectionCard
            title="Strategy and list"
            caption="Recorded when this report was shared, from the backtest's own frozen inputs."
            testId="shared-backtest-definitions"
          >
            <div className={styles.definitions}>
              <SharedDefinition
                kind="strategy"
                definition={definitions.strategy}
              />
              <SharedDefinition kind="list" definition={definitions.list} />
            </div>
          </SectionCard>
        ) : null}

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
                value: runLabel,
                testId: "shared-backtest-run-id",
              },
            ]}
          />
        </SectionCard>
      </div>
    </PageContainer>
  );
}

/**
 * One of the run's two definitions: what it is, where it comes from, and — when published — what it
 * does, in the generated words. A customer's own name for their content is never shown; a built-in
 * is named by its official name.
 */
function SharedDefinition({
  kind,
  definition,
}: {
  readonly kind: DefinitionKind;
  readonly definition: SharedDefinitionResponse;
}) {
  const title =
    definition.origin === "built_in" && definition.builtInName
      ? `${definitionKindLabel(kind)} — ${definition.builtInName}`
      : definitionKindLabel(kind);
  const description = definition.description;
  return (
    <section
      className={styles.definition}
      data-testid={`shared-backtest-${kind}`}
      data-origin={definition.origin}
      aria-label={title}
    >
      <h3 className={styles.definitionTitle}>{title}</h3>
      <p
        className={styles.provenance}
        data-testid={`shared-backtest-${kind}-provenance`}
      >
        {definitionOriginLabel(kind, definition.origin, definition.builtInName)}
      </p>
      {description.status === "published" ? (
        <>
          <p
            className={styles.definitionShort}
            data-testid={`shared-backtest-${kind}-short`}
          >
            {description.short}
          </p>
          <div
            className={styles.definitionDetailed}
            data-testid={`shared-backtest-${kind}-detailed`}
          >
            {description.detailed.split("\n").map((line, index) => (
              <p key={index}>{line}</p>
            ))}
          </div>
        </>
      ) : (
        <p
          className={styles.withheld}
          data-testid={`shared-backtest-${kind}-withheld`}
        >
          {definitionWithheldText(kind, description.reason)}
        </p>
      )}
    </section>
  );
}
