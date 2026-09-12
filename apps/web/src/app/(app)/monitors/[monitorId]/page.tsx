import type { Metadata } from "next";
import { MonitorDetail } from "../../../../features/monitors/components/MonitorDetail";

export const metadata: Metadata = { title: "Monitor · FactorSage" };

/** Thin route boundary; the feature owns loading, missing and error states. */
export default async function MonitorDetailRoute({
  params,
}: {
  readonly params: Promise<{ readonly monitorId: string }>;
}) {
  const { monitorId } = await params;
  return <MonitorDetail monitorId={monitorId} />;
}
