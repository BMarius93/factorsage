import type { Metadata } from "next";
import { ListDetail } from "../../../../features/lists/components/ListDetail";

export const metadata: Metadata = { title: "List · FactorSage" };

type ListDetailPageProps = {
  readonly params: Promise<{ readonly id: string }>;
};

/** Thin route boundary; the feature resolves the list against the API and owns every state. */
export default async function ListDetailRoute({ params }: ListDetailPageProps) {
  const { id } = await params;
  return <ListDetail listId={id} />;
}
