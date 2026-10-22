import type { Metadata } from "next";
import { Suspense } from "react";
import { BacktestsPage } from "../../../features/backtests/components/BacktestsPage";

export const metadata: Metadata = { title: "Backtests · FactorSage" };

/**
 * Thin route boundary; the feature owns loading, empty and error states.
 *
 * The `Suspense` wrapper is required rather than stylistic: the collection's page, search, filter
 * and order live in the URL and are read with `useSearchParams`, and the App Router needs a
 * suspense boundary around any client component that does, or the whole route opts out of static
 * rendering.
 */
export default function BacktestsRoute() {
  return (
    <Suspense fallback={null}>
      <BacktestsPage />
    </Suspense>
  );
}
