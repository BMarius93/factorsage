import type { Metadata } from "next";
import { DemoBacktestsPage } from "../../../features/demo-backtests/DemoBacktestsPage";
import { loadDemoBacktests } from "../../../features/demo-backtests/demo-backtests-loader";

export const metadata: Metadata = {
  title: "Demo backtests · FactorSage",
  description: "Precomputed example backtests you can open without an account.",
};

/** Read per request: taking a demonstration off the shelf must show on the very next one. */
export const dynamic = "force-dynamic";

export default async function DemoBacktestsRoute() {
  const { demos } = await loadDemoBacktests();
  return <DemoBacktestsPage demos={demos} />;
}
