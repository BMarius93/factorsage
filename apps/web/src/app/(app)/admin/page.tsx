import type { Metadata } from "next";
import { AdminPage } from "../../../features/admin/components/AdminPage";

export const metadata: Metadata = { title: "Admin · FactorSage" };

/** Thin route boundary; the page lives in the admin feature. */
export default function AdminRoute() {
  return <AdminPage />;
}
