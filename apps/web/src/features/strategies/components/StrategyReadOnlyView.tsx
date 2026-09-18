"use client";

import type { StrategyDetailResponse } from "@intrinsic/contracts";
import { PageContainer } from "../../../components/layout/PageContainer";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import forms from "../../../components/ui/forms.module.css";
import page from "../../../components/ui/page.module.css";
import { AccountActionLink } from "../../auth/components/AccountActionLink";
import { SIGN_IN_TO_BACKTEST } from "../../auth/utils/sign-in-prompts";
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
  return (
    <PageContainer>
      <div className={page.stack} data-testid="strategy-read-only">
        <PageHeader
          back={{ href: "/dashboard", label: "Dashboard" }}
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
            <AccountActionLink
              className={forms.tintedButton}
              href={`/backtests/new?strategyId=${encodeURIComponent(strategy.id)}`}
              prompt={SIGN_IN_TO_BACKTEST}
              testId="backtest-this-strategy"
            >
              Backtest this strategy
            </AccountActionLink>
          }
        />
        <SectionCard
          id="strategy-logic"
          title="Logic"
          caption="Maintained by FactorSage. Conditions are combined with AND; a trigger must fire while they hold."
        >
          <LogicPreview definition={strategy.definition} />
        </SectionCard>
      </div>
    </PageContainer>
  );
}
