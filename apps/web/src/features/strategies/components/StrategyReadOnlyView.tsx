"use client";

import type { StrategyDetailResponse } from "@intrinsic/contracts";
import { PageContainer } from "../../../components/layout/PageContainer";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { useDocumentTitle } from "../../../lib/use-document-title";
import page from "../../../components/ui/page.module.css";
import { useStrategyScopeNames } from "../../alternative-data/hooks/use-scope-names";
import { RunBacktestLink } from "../../backtests/components/RunBacktestLink";
import { LogicPreview } from "./LogicPreview";

/**
 * A strategy the viewer may read but not change — a built-in, for anyone but an administrator.
 *
 * The logic is shown with the same `LogicPreview` the Builder uses, so a built-in reads exactly
 * like a strategy the user wrote. The one action offered is the product's primary flow for it:
 * backtest the strategy — a prefilled link when signed in, an in-place sign-in prompt for a Guest.
 */
export function StrategyReadOnlyView({
  strategy,
}: {
  readonly strategy: StrategyDetailResponse;
}) {
  useDocumentTitle(strategy.name);
  // So a rule scoped to a group reads by name here too, exactly as it does in the Builder.
  const scopeNames = useStrategyScopeNames(strategy.definition);
  return (
    <PageContainer>
      <div className={page.stack} data-testid="strategy-read-only">
        <PageHeader
          // The owning collection (UI-016): a built-in is found on Strategies, not the Dashboard.
          back={{ href: "/strategies", label: "Strategies" }}
          title={strategy.name}
          {...(strategy.description ? { lead: strategy.description } : {})}
          badges={
            strategy.ownership === "SYSTEM" ? (
              <StatusBadge
                tone="neutral"
                variant="outline"
                testId="built-in-badge"
              >
                Built-in
              </StatusBadge>
            ) : undefined
          }
          actions={
            <RunBacktestLink
              prefill={{ strategyId: strategy.id }}
              testId="backtest-this-strategy"
            />
          }
        />
        <SectionCard
          id="strategy-logic"
          title="Logic"
          caption="Maintained by FactorSage. Conditions are combined with AND; a trigger must fire while they hold."
        >
          {/* Unframed: the section is already the surface, and a card titled "Strategy logic"
              inside one titled "Logic" was a card-in-card with a second heading (UI-016). */}
          <LogicPreview
            definition={strategy.definition}
            framed={false}
            scopeNames={scopeNames}
          />
        </SectionCard>
      </div>
    </PageContainer>
  );
}
