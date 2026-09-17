"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { isGuestReadableRoute } from "../utils/guest-routes";
import { RequireAuth } from "./RequireAuth";

/**
 * Decides, per route, whether the application shell requires a session.
 *
 * Guest-readable routes render immediately for everyone; their features read the session
 * themselves where it changes what they show. Every other route stays behind `RequireAuth`.
 * Presentation only — the API authorizes every request on its own.
 */
export function RouteAccessGate({
  children,
}: {
  readonly children: ReactNode;
}) {
  const pathname = usePathname() ?? "";
  if (isGuestReadableRoute(pathname)) {
    return <>{children}</>;
  }
  return <RequireAuth>{children}</RequireAuth>;
}
