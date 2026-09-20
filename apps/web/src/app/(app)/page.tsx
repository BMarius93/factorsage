import type { Metadata } from "next";
import { DashboardPage } from "../../features/dashboard/components/DashboardPage";

export const metadata: Metadata = { title: "Dashboard · FactorSage" };

/**
 * The application's canonical home.
 *
 * The Dashboard is served *at* `/` rather than redirected to from it: it is the first thing a
 * visitor meets and the destination every sign-in, brand mark and bottom-bar tap resolves to, and
 * a home page that bounced to a second URL put that second URL in the address bar of every one of
 * them. `/dashboard` stays a redirect here for links that predate this (`lib/route-redirects.ts`).
 */
export default function HomeRoute() {
  return <DashboardPage />;
}
