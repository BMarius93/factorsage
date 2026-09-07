import type { Metadata } from "next";
import { NewBacktestForm } from "../../../../features/backtests/components/NewBacktestForm";

export const metadata: Metadata = { title: "New backtest · FactorSage" };

export default function NewBacktestRoute() {
  return <NewBacktestForm />;
}
