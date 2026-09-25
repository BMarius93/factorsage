import type { Metadata } from "next";
import { Suspense } from "react";
import { ListsPage } from "../../../features/lists/components/ListsPage";

export const metadata: Metadata = { title: "Lists · FactorSage" };

/**
 * Thin route boundary; everything lives in the lists feature.
 *
 * The page reads `?view=` to choose between its two collections — stock lists and congress groups —
 * which needs a suspense boundary under the App Router, exactly as the new-backtest form's prefill
 * does.
 */
export default function ListsRoute() {
  return (
    <Suspense fallback={null}>
      <ListsPage />
    </Suspense>
  );
}
