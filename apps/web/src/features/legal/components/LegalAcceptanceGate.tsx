"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useLegalAcceptance } from "../hooks/use-legal-acceptance";
import { AcceptTermsPanel } from "./AcceptTermsPanel";

/**
 * The routes that stay reachable for a signed-in user who has not accepted the Terms.
 *
 * This is the presentation half of the server's `@LegalAcceptanceExempt` allowlist, and the two
 * are deliberately about the same thing: a compliance gate that traps a paying customer is worse
 * than no gate. Somebody who declines must still be able to read the documents, cancel a
 * renewal, submit a statutory withdrawal or a privacy request, contact support and sign out.
 *
 * Signing out is not listed because it is not a route: it lives in the topbar's account menu,
 * which the shell renders outside this gate and which therefore stays available on every screen,
 * including the acceptance screen itself.
 */
const REACHABLE_WHILE_OUTSTANDING: readonly RegExp[] = [
  /^\/terms$/,
  /^\/privacy$/,
  /^\/cookies$/,
  /^\/risk-disclosure$/,
  /^\/cancellation-and-refunds$/,
  /^\/contact$/,
  // Billing is where a renewal is cancelled, through the hosted customer portal.
  /^\/billing$/,
  // The account's own legal surfaces: the acceptance screen and the request channels.
  /^\/legal(\/.*)?$/,
];

export function isReachableWhileTermsOutstanding(pathname: string): boolean {
  const path = pathname.split(/[?#]/, 1)[0]?.replace(/\/+$/, "") ?? "";
  return REACHABLE_WHILE_OUTSTANDING.some((pattern) => pattern.test(path));
}

/**
 * Shows the acceptance screen in place of a product route while an acceptance is outstanding.
 *
 * Presentation only. The server refuses every gated route on its own, so this exists to route a
 * user to the thing they need to do rather than to a wall of `403`s — and, just as importantly,
 * to keep the escape hatches above working while they decide.
 *
 * It renders the panel **in place of** the route rather than redirecting, which keeps the URL
 * intact: accepting returns the user to the page they were trying to reach instead of dumping
 * them on the Dashboard.
 *
 * `loading` and `error` both render the route. A user is never held behind a spinner waiting for
 * a compliance probe, and a failed probe must not lock them out — the server is the thing that
 * actually refuses, and it does not depend on this.
 */
export function LegalAcceptanceGate({
  children,
}: {
  readonly children: ReactNode;
}) {
  const { state, refresh } = useLegalAcceptance();
  const pathname = usePathname() ?? "";

  if (
    state.status !== "outstanding" ||
    isReachableWhileTermsOutstanding(pathname)
  ) {
    return <>{children}</>;
  }

  return <AcceptTermsPanel onAccepted={refresh} />;
}
