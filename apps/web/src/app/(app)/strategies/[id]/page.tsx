import type { Metadata } from "next";
import { StrategyEditor } from "../../../../features/strategies/components/StrategyEditor";

export const metadata: Metadata = { title: "Strategy · FactorSage" };

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <StrategyEditor strategyId={id} />;
}
