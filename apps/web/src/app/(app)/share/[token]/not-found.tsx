import Link from "next/link";
import { PageContainer } from "../../../../components/layout/PageContainer";
import { EmptyState } from "../../../../components/ui/EmptyState";
import forms from "../../../../components/ui/forms.module.css";

/**
 * A shared link that leads nowhere: mistyped, or its owner stopped sharing it.
 *
 * The two are told apart nowhere — not here, not by the API — so a link reveals nothing about
 * whether it ever worked. Rendered inside the product shell, with a way on for a visitor who came
 * to look at a backtest.
 */
export default function SharedBacktestNotFound() {
  return (
    <PageContainer>
      <EmptyState
        as="h1"
        testId="shared-backtest-not-found"
        title="This shared backtest is not available"
        body={
          <p>
            The link may be incorrect, or its owner may have stopped sharing it.
          </p>
        }
        actions={
          <Link className={forms.secondaryButton} href="/">
            Go to the Dashboard
          </Link>
        }
      />
    </PageContainer>
  );
}
