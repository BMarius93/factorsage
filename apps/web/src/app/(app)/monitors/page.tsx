import type { Metadata } from "next";
import { MonitorsPage } from "../../../features/monitors/components/MonitorsPage";

export const metadata: Metadata = { title: "Monitors · FactorSage" };

/** Thin route boundary; the feature owns loading, empty and error states. */
export default function MonitorsRoute() {
  return <MonitorsPage />;
}
