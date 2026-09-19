"use client";

import forms from "../../../components/ui/forms.module.css";
import { AccountActionLink } from "../../auth/components/AccountActionLink";
import { SIGN_IN_TO_BACKTEST } from "../../auth/utils/sign-in-prompts";
import { newBacktestHref, type BacktestPrefill } from "../utils/prefill";

/**
 * "Run backtest" from an entity's own page (UI-008): the same label, weight and prefill rule on
 * every List, Strategy and Monitor header, whoever owns the entity.
 *
 * It is a quiet secondary action — navigation to a form, not the commit that runs anything — and
 * it preselects exactly what the entity knows: a List preselects itself, a Strategy itself, a
 * Monitor both of the things it watches. A Guest is asked for an account in place, and signing in
 * lands on the prefilled form rather than back on the page they were reading.
 */
export function RunBacktestLink({
  prefill,
  testId = "run-backtest",
}: {
  readonly prefill: Pick<BacktestPrefill, "strategyId" | "stockListId">;
  readonly testId?: string;
}) {
  return (
    <AccountActionLink
      className={forms.secondaryButton}
      href={newBacktestHref(prefill)}
      prompt={SIGN_IN_TO_BACKTEST}
      testId={testId}
    >
      Run backtest
    </AccountActionLink>
  );
}
