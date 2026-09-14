"use client";

import Link from "next/link";
import { PageContainer } from "../../../components/layout/PageContainer";
import { EmptyState } from "../../../components/ui/EmptyState";
import { SectionCard } from "../../../components/ui/SectionCard";
import { SkeletonList } from "../../../components/ui/Skeleton";
import forms from "../../../components/ui/forms.module.css";
import { useStrategy } from "../hooks/use-strategy";
import { StrategyBuilder } from "./StrategyBuilder";

/**
 * Loads one strategy and hands it to the Builder.
 *
 * A 404 is a product state, not a failure: a deleted strategy, or one belonging to someone else,
 * gets its own surface rather than a retry button that can never succeed.
 */
export function StrategyEditor({
  strategyId,
}: {
  readonly strategyId: string;
}) {
  const { status, strategy, retry } = useStrategy(strategyId);

  if (status === "loading") {
    return (
      <PageContainer>
        <SectionCard ariaLabel="Loading strategy">
          <SkeletonList rows={5} />
        </SectionCard>
      </PageContainer>
    );
  }

  if (status === "not-found") {
    return (
      <PageContainer>
        <EmptyState
          as="h1"
          testId="strategy-not-found"
          title="Strategy not found"
          body={
            <p>
              It may have been deleted, or the link may point at someone
              else&apos;s strategy.
            </p>
          }
          actions={
            <Link className={forms.secondaryButton} href="/strategies">
              Back to strategies
            </Link>
          }
        />
      </PageContainer>
    );
  }

  if (status === "error" || !strategy) {
    return (
      <PageContainer>
        <EmptyState
          as="h1"
          variant="error"
          title="This strategy could not be loaded"
          body={<p>This is usually temporary — try again in a moment.</p>}
          actions={
            <button
              type="button"
              className={forms.secondaryButton}
              onClick={retry}
            >
              Try again
            </button>
          }
        />
      </PageContainer>
    );
  }

  return <StrategyBuilder strategy={strategy} />;
}
