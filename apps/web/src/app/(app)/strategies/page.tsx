import type { Metadata } from "next";
import { StrategiesPage } from "../../../features/strategies/components/StrategiesPage";

export const metadata: Metadata = { title: "Strategies · FactorSage" };

export default function Page() {
  return <StrategiesPage />;
}
