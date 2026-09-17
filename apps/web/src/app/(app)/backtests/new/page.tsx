import type { Metadata } from "next";
import { Suspense } from "react";
import { NewBacktestForm } from "../../../../features/backtests/components/NewBacktestForm";

export const metadata: Metadata = { title: "New backtest · FactorSage" };

/** The form reads `?strategyId=&stockListId=`, which needs a suspense boundary under the App Router. */
export default function NewBacktestRoute() {
  return (
    <Suspense fallback={null}>
      <NewBacktestForm />
    </Suspense>
  );
}
