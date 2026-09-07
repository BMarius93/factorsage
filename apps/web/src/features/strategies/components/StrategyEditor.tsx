"use client";

import Link from "next/link";
import { PageContainer } from "../../../components/layout/PageContainer";
import forms from "../../../components/ui/forms.module.css";
import { useStrategy } from "../hooks/use-strategy";
import { StrategyBuilder } from "./StrategyBuilder";
import styles from "./StrategyBuilder.module.css";

/**
 * Loads one strategy and hands it to the Builder.
 *
 * A 404 is a product state, not a failure: a deleted strategy, or one belonging to someone else,
 * gets its own surface rather than a retry button that can never succeed.
 */
export function StrategyEditor({ strategyId }: { readonly strategyId: string }) {
  const { status, strategy, retry } = useStrategy(strategyId);

  if (status === "loading") {
    return (
      <PageContainer>
        <div className={styles.skeleton} aria-hidden="true" />
      </PageContainer>
    );
  }

  if (status === "not-found") {
    return (
      <PageContainer>
        <div className={styles.statusPanel} data-testid="strategy-not-found">
          <h1 className={styles.statusTitle}>Strategy not found</h1>
          <p className={styles.statusBody}>
            It may have been deleted, or the link may point at someone else&apos;s
            strategy.
          </p>
          <Link className={forms.secondaryButton} href="/strategies">
            Back to strategies
          </Link>
        </div>
      </PageContainer>
    );
  }

  if (status === "error" || !strategy) {
    return (
      <PageContainer>
        <div className={styles.statusPanel} role="alert">
          <h1 className={styles.statusTitle}>
            This strategy could not be loaded
          </h1>
          <p className={styles.statusBody}>
            This is usually temporary — try again in a moment.
          </p>
          <button
            type="button"
            className={forms.secondaryButton}
            onClick={retry}
          >
            Try again
          </button>
        </div>
      </PageContainer>
    );
  }

  return <StrategyBuilder strategy={strategy} />;
}
