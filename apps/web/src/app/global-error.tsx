"use client";

import { useEffect } from "react";
import forms from "../components/ui/forms.module.css";
import "./globals.css";
import styles from "./global-error.module.css";

/**
 * The failure of last resort: an error in the root layout itself (UX-006).
 *
 * Next renders this *instead of* the root layout, so it owns its `<html>` and `<body>` and depends
 * on as little as possible — no shell, no session, no fonts, no image optimiser — because any of
 * those could be what failed. The error goes to the browser console only; nothing about it is
 * rendered. The Dashboard link is a plain anchor, a full document load, which is the most likely
 * thing to recover a broken client.
 */
export default function GlobalError({
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
    <html lang="en">
      <head>
        <title>Something went wrong · FactorSage</title>
      </head>
      <body>
        <main className={styles.shell}>
          <div className={styles.panel} role="alert" data-testid="global-error">
            <p className={styles.brand}>FactorSage</p>
            <h1 className={styles.title}>FactorSage could not load</h1>
            <p className={styles.body}>
              Something unexpected went wrong. Nothing you saved is affected.
              Try again, or reload from the Dashboard.
            </p>
            <div className={styles.actions}>
              <a className={forms.secondaryButton} href="/">
                Go to the Dashboard
              </a>
              <button
                type="button"
                className={forms.secondaryButton}
                onClick={() => reset()}
              >
                Try again
              </button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
