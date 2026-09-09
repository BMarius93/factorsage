import type { Metadata } from "next";
import { BacktestRunView } from "../../../../features/backtests/components/BacktestRunView";

export const metadata: Metadata = { title: "Backtest · FactorSage" };

type BacktestRunPageProps = {
  readonly params: Promise<{ readonly id: string }>;
};

/** Thin route boundary; the feature resolves the run and owns running and completed modes alike. */
export default async function BacktestRunRoute({
  params,
}: BacktestRunPageProps) {
  const { id } = await params;
  return <BacktestRunView runId={id} />;
}
