import Link from "next/link";
import type { ReactNode } from "react";
import { Notice } from "./Notice";
import forms from "./forms.module.css";

type EntitlementNoticeProps = {
  /** What the plan limit stopped, in product words — usually the API's own sentence. */
  readonly message: ReactNode;
  /**
   * The recovery that fits this refusal (UI-020): adjust the input, open the running work, save
   * without the capped part. Rendered before "See plans", which is always offered.
   */
  readonly recovery?: ReactNode;
  readonly title?: ReactNode;
  readonly announce?: "alert" | "status";
  readonly testId?: string;
};

/**
 * A plan limit, told with a way forward (cleanup plan §3.7).
 *
 * The API's refusal already names the limit and the count ("Your plan allows 10 stocks per list;
 * this change would make 11"). This adds what that sentence cannot: a next step that fits the
 * situation and a route to the plans, so a refusal is never a dead end.
 */
export function EntitlementNotice({
  message,
  recovery,
  title,
  announce = "alert",
  testId,
}: EntitlementNoticeProps) {
  return (
    <Notice
      tone="warning"
      announce={announce}
      {...(title ? { title } : {})}
      {...(testId ? { testId } : {})}
      actions={
        <>
          {recovery}
          <Link
            className={forms.secondaryButton}
            href="/billing"
            data-testid="entitlement-see-plans"
          >
            See plans
          </Link>
        </>
      }
    >
      <p>{message}</p>
    </Notice>
  );
}
