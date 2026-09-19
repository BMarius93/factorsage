import type { Metadata } from "next";
import { StrategyBuilder } from "../../../../features/strategies/components/StrategyBuilder";

export const metadata: Metadata = { title: "New strategy · FactorSage" };

export default function Page() {
  return <StrategyBuilder />;
}
