"use client";

import Link from "next/link";
import { useEffect } from "react";
import { PageContainer } from "../../components/layout/PageContainer";
import { EmptyState } from "../../components/ui/EmptyState";
import forms from "../../components/ui/forms.module.css";

/**
 * A render error inside a product page (UX-006).
 *
 * This boundary sits under the `(app)` layout, so the topbar, the search and the bottom
 * navigation keep working around it: one bad payload or chart exception costs the page, never the
 * application. The error itself is logged to the browser console for whoever is debugging and is
 * never rendered — a message or a stack is not something a user can act on, and may say more
 * about the system than it should.
 */
export default function AppError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PageContainer>
      <EmptyState
        as="h1"
        variant="error"
        testId="app-error"
        title="This page could not be shown"
        body={
          <p>
            Something unexpected went wrong while displaying it. Nothing you
            saved is affected. Try again, or carry on from the Dashboard.
          </p>
        }
        actions={
          <>
            <Link className={forms.secondaryButton} href="/">
              Go to the Dashboard
            </Link>
            <button
              type="button"
              className={forms.secondaryButton}
              onClick={() => reset()}
            >
              Try again
            </button>
          </>
        }
      />
    </PageContainer>
  );
}
