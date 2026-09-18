import type { Metadata } from "next";
import { PricingPage } from "../../../features/billing/components/PricingPage";

export const metadata: Metadata = { title: "Pricing · FactorSage" };

/**
 * Thin route boundary for the public price list (PRICING-001). Guest-readable through
 * `guest-routes.ts`; the feature owns every state.
 */
export default function PricingRoute() {
  return <PricingPage />;
}
