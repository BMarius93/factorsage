import type { Metadata } from "next";
import { Suspense } from "react";
import { BacktestRunView } from "../../../../features/backtests/components/BacktestRunView";

export const metadata: Metadata = { title: "Backtest · FactorSage" };

type BacktestRunPageProps = {
  readonly params: Promise<{ readonly id: string }>;
};

/**
 * Thin route boundary; the feature resolves the run and owns running and completed modes alike.
 *
 * The `Suspense` wrapper is required rather than stylistic: the trade log's page lives in the URL
 * (`?tradesPage=`) and is read with `useSearchParams`, and the App Router needs a suspense boundary
 * around any client component that does, or the whole route opts out of static rendering.
 */
export default async function BacktestRunRoute({
  params,
}: BacktestRunPageProps) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <BacktestRunView runId={id} />
    </Suspense>
  );
}
