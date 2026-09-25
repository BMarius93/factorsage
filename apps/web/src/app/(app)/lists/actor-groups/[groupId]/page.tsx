import type { Metadata } from "next";
import { ActorGroupDetail } from "../../../../../features/alternative-data/components/ActorGroupDetail";

export const metadata: Metadata = { title: "Group · FactorSage" };

type ActorGroupPageProps = {
  readonly params: Promise<{ readonly groupId: string }>;
};

/**
 * Thin route boundary for one actor group.
 *
 * Nested under `/lists` because that is the product area the groups belong to — the segmented views on
 * the Lists page are the way in, and the back link points there. A static segment, so it can never be
 * confused with `/lists/[id]`.
 */
export default async function ActorGroupRoute({ params }: ActorGroupPageProps) {
  const { groupId } = await params;
  return <ActorGroupDetail groupId={groupId} />;
}
