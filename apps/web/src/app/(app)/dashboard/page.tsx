import type { Metadata } from "next";
import { DashboardPage } from "../../../features/dashboard/components/DashboardPage";

export const metadata: Metadata = { title: "Dashboard · FactorSage" };

export default function DashboardRoute() {
  return <DashboardPage />;
}
