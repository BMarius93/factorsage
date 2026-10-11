import type { Metadata } from "next";
import { ListsPage } from "../../../features/lists/components/ListsPage";

export const metadata: Metadata = { title: "Lists · FactorSage" };

/** Thin route boundary; everything lives in the lists feature. */
export default function ListsRoute() {
  return <ListsPage />;
}
