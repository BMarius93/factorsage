import type { Metadata } from "next";
import { BacktestsPage } from "../../../features/backtests/components/BacktestsPage";

export const metadata: Metadata = { title: "Backtests · FactorSage" };

/** Thin route boundary; the feature owns loading, empty and error states. */
export default function BacktestsRoute() {
  return <BacktestsPage />;
}
