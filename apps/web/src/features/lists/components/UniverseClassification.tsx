import type {
  UniverseClassificationResponse,
  UniverseCoverageResponse,
} from "@intrinsic/contracts";
import { FactGrid } from "../../../components/ui/FactGrid";
import { Notice } from "../../../components/ui/Notice";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import styles from "./UniverseClassification.module.css";

/**
 * How a retrospectively classified universe says what it is, wherever it is shown
 * (`docs/decisions/historical-universes-v1.md` §2.1): its membership is the index's point-in-time
 * membership, its sectors are today's. The badge tells it apart from a point-in-time universe at a
 * glance; the notice states the disclosure, the method and the coverage it does not gate on.
 */

export function RetrospectiveClassificationBadge({
  testId = "universe-retrospective-badge",
}: {
  readonly testId?: string;
}) {
  return (
    <StatusBadge tone="warning" variant="outline" size="small" testId={testId}>
      Retrospective classification
    </StatusBadge>
  );
}

const yearOf = (date: string | null) => (date ? date.slice(0, 4) : null);

/**
 * The coverage a published classified universe discloses, in sentences: survivorship, the
 * universe's own price coverage, and the index stocks no group holds.
 */
export function coverageSentences(
  coverage: UniverseCoverageResponse | null | undefined,
  underlyingIndex: string,
): string[] {
  if (!coverage) {
    return [];
  }
  const sentences: string[] = [];
  const reliable = yearOf(coverage.reliableFrom);
  if (reliable) {
    sentences.push(
      `At least 90% of the ${underlyingIndex}'s constituents have price history from ${reliable}; before then, members that left without price history are missing, so early results lean toward survivors.`,
    );
  }
  const priced = yearOf(coverage.priceCoverageFrom);
  if (priced && priced !== reliable) {
    sentences.push(
      `At least 90% of this universe's own members have a price from ${priced}.`,
    );
  }
  if (
    coverage.unclassifiedSecurities !== null &&
    coverage.indexSecurities !== null &&
    coverage.unclassifiedSecurities > 0
  ) {
    sentences.push(
      `${coverage.unclassifiedSecurities} of ${coverage.indexSecurities} ${underlyingIndex} stocks have no available sector and are in no supersector.`,
    );
  }
  return sentences;
}

/** The disclosure, the classification facts and the coverage, as one warning notice. */
export function UniverseClassificationNotice({
  classification,
  coverage,
  testId = "universe-classification",
}: {
  readonly classification: UniverseClassificationResponse;
  readonly coverage?: UniverseCoverageResponse | null;
  readonly testId?: string;
}) {
  const sentences = coverageSentences(coverage, classification.underlyingIndex);
  return (
    <Notice
      tone="warning"
      title="Retrospective sector classification"
      testId={testId}
    >
      <p className={styles.disclosure} data-testid={`${testId}-disclosure`}>
        {classification.disclosure}
      </p>
      <FactGrid
        minColumnWidth="160px"
        facts={[
          {
            label: "Underlying index",
            value: classification.underlyingIndex,
          },
          {
            label: "Included sectors",
            value: classification.sectors.join(", "),
            testId: `${testId}-sectors`,
          },
          {
            label: "Classification method",
            value: classification.methodLabel,
            testId: `${testId}-method`,
          },
        ]}
      />
      {sentences.length > 0 ? (
        <p className={styles.coverage} data-testid={`${testId}-coverage`}>
          {sentences.join(" ")}
        </p>
      ) : null}
    </Notice>
  );
}

const percent = (value: number | null) =>
  value === null ? "—" : `${Math.round(value * 100)}%`;

/** A published classified universe's coverage, year by year, collapsed until asked for. */
export function UniverseCoverageByYear({
  coverage,
}: {
  readonly coverage: UniverseCoverageResponse;
}) {
  if (!coverage.byYear || coverage.byYear.length === 0) {
    return null;
  }
  return (
    <details className={styles.details} data-testid="universe-coverage-by-year">
      <summary className={styles.summary}>Data coverage by year</summary>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Year</th>
              <th scope="col">Index members with data</th>
              <th scope="col">Classified</th>
              <th scope="col">Unclassified</th>
              <th scope="col">In this universe</th>
              <th scope="col">Priced</th>
            </tr>
          </thead>
          <tbody>
            {coverage.byYear.map((row) => (
              <tr key={row.year}>
                <th scope="row">{row.year}</th>
                <td>
                  {row.indexMembers} of {row.indexLines} (
                  {percent(row.constituentCoverage)})
                </td>
                <td>{row.classified}</td>
                <td>{row.unclassified}</td>
                <td>{row.groupMembers}</td>
                <td>
                  {row.groupPriced} ({percent(row.priceCoverage)})
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
