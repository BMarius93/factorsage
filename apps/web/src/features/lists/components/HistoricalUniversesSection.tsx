"use client";

import type {
  HistoricalUniverseCatalogEntry,
  StockListSummaryResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { EmptyState } from "../../../components/ui/EmptyState";
import { SectionCard } from "../../../components/ui/SectionCard";
import { SkeletonList } from "../../../components/ui/Skeleton";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import {
  PremiumBadge,
  PremiumUpgradeHint,
} from "../../billing/components/PremiumContent";
import { useHistoricalUniverses } from "../hooks/use-historical-universes";
import forms from "../../../components/ui/forms.module.css";
import styles from "./HistoricalUniversesSection.module.css";
import {
  coverageSentences,
  RetrospectiveClassificationBadge,
} from "./UniverseClassification";

/**
 * FactorSage's historical universes, grouped as the catalog groups them
 * (`docs/decisions/historical-universes-v1.md` §6).
 *
 * Every catalog universe is shown, available or not, so two different facts never read as one:
 *
 * - **Requires Pro** — the universe exists and the viewer's plan does not include it: a lock and a
 *   "Pro" label, and the way to the plans under it.
 * - **Historical data unavailable** — the point-in-time data it needs does not exist or has not been
 *   validated, whatever the plan: no link, and the reason in words.
 *
 * A retrospectively classified universe (the economic supersectors) also carries a "Retrospective
 * classification" badge, its index, sectors and method, and its disclosure, so it never reads as a
 * point-in-time sector classification.
 *
 * Metadata only: the catalog and the summaries `GET /lists` already returned. Nothing here loads a
 * membership or stock data.
 */
export function HistoricalUniversesSection({
  lists,
}: {
  /** `GET /lists`, for each published universe's measured size. */
  readonly lists: readonly StockListSummaryResponse[];
}) {
  const state = useHistoricalUniverses();
  const sizeOf = new Map(
    lists
      .filter((list) => list.universe)
      .map((list) => [list.id, list.universe]),
  );

  if (state.status === "loading") {
    return (
      <SectionCard ariaLabel="Loading historical universes">
        <SkeletonList rows={4} />
      </SectionCard>
    );
  }
  if (state.status === "error") {
    return (
      <EmptyState
        variant="compact"
        testId="historical-universes-error"
        title="Historical universes could not be loaded"
        body={<p>This is usually temporary — try again in a moment.</p>}
        actions={
          <button
            type="button"
            className={forms.secondaryButton}
            onClick={state.retry}
          >
            Try again
          </button>
        }
      />
    );
  }

  return (
    <div className={styles.stack} data-testid="historical-universes">
      {state.catalog.categories
        .filter((category) => category.universes.length > 0)
        .map((category) => (
          <SectionCard
            key={category.key}
            density="compact"
            title={category.label}
            testId={`historical-universes-${category.key}`}
          >
            <ul className={styles.list}>
              {category.universes.map((universe) => (
                <UniverseRow
                  key={universe.key}
                  universe={universe}
                  size={
                    universe.listId ? sizeOf.get(universe.listId) : undefined
                  }
                />
              ))}
            </ul>
          </SectionCard>
        ))}
    </div>
  );
}

function UniverseRow({
  universe,
  size,
}: {
  readonly universe: HistoricalUniverseCatalogEntry;
  readonly size: StockListSummaryResponse["universe"] | undefined;
}) {
  const available =
    universe.availability === "AVAILABLE" && universe.listId !== null;
  const name = (
    <span className={styles.nameRow}>
      <span className={styles.name}>{universe.name}</span>
      <PremiumBadge
        locked={universe.locked}
        size="small"
        label="Pro"
        testId="universe-pro-badge"
      />
      {universe.classification ? <RetrospectiveClassificationBadge /> : null}
      {available ? null : (
        <StatusBadge
          tone="neutral"
          variant="outline"
          size="small"
          testId="universe-unavailable"
        >
          Historical data unavailable
        </StatusBadge>
      )}
    </span>
  );
  const classification = universe.classification;
  const coverage = classification
    ? coverageSentences(universe.coverage, classification.underlyingIndex)
    : [];
  return (
    <li
      className={styles.row}
      data-testid="historical-universe"
      data-universe-key={universe.key}
      data-availability={universe.availability}
      data-locked={universe.locked ? "true" : "false"}
    >
      {available ? (
        <Link className={styles.nameLink} href={`/lists/${universe.listId}`}>
          {name}
        </Link>
      ) : (
        <span className={styles.nameLink}>{name}</span>
      )}
      <span className={styles.description}>{universe.description}</span>
      {classification ? (
        <>
          <span
            className={styles.meta}
            data-testid="universe-classification-facts"
          >
            Underlying index: {universe.underlyingIndex} · Sectors:{" "}
            {universe.includedSectors.join(", ")}
          </span>
          <span
            className={styles.meta}
            data-testid="universe-classification-method"
          >
            Classification method: {classification.methodLabel}
          </span>
          <span
            className={styles.disclosure}
            data-testid="universe-classification-disclosure"
          >
            {classification.disclosure}
          </span>
        </>
      ) : null}
      {available && size ? (
        <span className={styles.meta} data-testid="universe-size">
          {classification ? "Membership point-in-time" : "Point-in-time"} from{" "}
          {universe.availableFrom?.slice(0, 4)} · {size.distinctSecurities}{" "}
          {classification ? "historical constituents" : "stocks over time"}, up
          to {size.peakSimultaneousMembers} at once
        </span>
      ) : null}
      {available && coverage.length > 0 ? (
        <span className={styles.meta} data-testid="universe-coverage">
          {coverage.join(" ")}
        </span>
      ) : null}
      {available ? null : (
        <span className={styles.meta} data-testid="universe-unavailable-reason">
          {universe.unavailableReason}
        </span>
      )}
      {/* "Requires Pro" is said only where there is something to unlock. */}
      {available && universe.locked ? (
        <span className={styles.meta} data-testid="universe-requires-pro">
          Requires Pro. <PremiumUpgradeHint />
        </span>
      ) : null}
    </li>
  );
}
