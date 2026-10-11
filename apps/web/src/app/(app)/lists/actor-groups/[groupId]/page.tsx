import { redirect } from "next/navigation";

/**
 * Where a Congress group used to be.
 *
 * Groups left the product on 2026-10-11: a rule now selects the members it counts in the Strategy
 * Builder. A bookmark or an old link to a group lands on the Lists page instead of on a 404,
 * because the link was good when it was made and the reader did nothing wrong.
 */
export default function RetiredActorGroupRoute(): never {
  redirect("/lists");
}
