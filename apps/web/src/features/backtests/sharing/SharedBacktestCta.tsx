"use client";

import Link from "next/link";
import forms from "../../../components/ui/forms.module.css";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import { registerHref } from "../../auth/utils/guest-routes";

/** Where a reader goes to build their own: the existing New Backtest workflow. */
export const NEW_BACKTEST_PATH = "/backtests/new";

/**
 * "Create your own backtest", for whoever is reading a shared report.
 *
 * A signed-in reader goes straight to New Backtest; anybody else goes to the existing registration
 * flow and comes back to New Backtest afterwards. It never offers to run *this* backtest: the
 * strategy and the list behind it are private, and this is a report of results, not a template.
 * Until the session is known the link already points at registration's return path to New
 * Backtest, which is where a signed-in reader is sent anyway.
 */
export function SharedBacktestCta() {
  const { state } = useAuthSession();
  const href =
    state.status === "authenticated"
      ? NEW_BACKTEST_PATH
      : registerHref(NEW_BACKTEST_PATH);
  return (
    <Link
      className={forms.primaryButton}
      href={href}
      data-testid="shared-backtest-cta"
      data-audience={state.status === "authenticated" ? "member" : "guest"}
    >
      Create your own backtest
    </Link>
  );
}
