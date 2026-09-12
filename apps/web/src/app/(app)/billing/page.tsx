import type { Metadata } from "next";
import { Suspense } from "react";
import { BillingPage } from "../../../features/billing/components/BillingPage";

export const metadata: Metadata = { title: "Plan and billing · FactorSage" };

/**
 * Thin route boundary; the feature owns loading, empty and error states.
 *
 * The `Suspense` wrapper is required rather than stylistic: the page reads `?checkout=...` with
 * `useSearchParams`, and the App Router needs a suspense boundary around any client component that
 * does, or the whole route opts out of static rendering.
 */
export default function BillingRoute() {
  return (
    <Suspense fallback={null}>
      <BillingPage />
    </Suspense>
  );
}
