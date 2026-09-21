/**
 * Permanent home for routes the product has moved.
 *
 * The Dashboard is now served at `/` (`app/(app)/page.tsx`), so `/dashboard` — the address it
 * answered at before, and the one sitting in bookmarks, old links and anything a user typed — is
 * redirected rather than rendered. The redirect lives in the Next configuration rather than in a
 * page that calls `redirect()` so that the old address never renders the application shell first:
 * the browser is sent to `/` before any React runs, and the address bar only ever shows the
 * canonical route.
 *
 * `permanent: false` (307) on purpose. A 308 is cached by the browser for the life of the profile,
 * which would make re-pointing `/dashboard` at anything else — a settings page, a monitor
 * overview — undoable for every user who had visited it once.
 *
 * Imported by `next.config.ts`, so it depends on nothing but the language.
 */

export type RedirectRule = {
  readonly source: string;
  readonly destination: string;
  readonly permanent: boolean;
};

/** Where the Dashboard lives. Everything that needs to say so reads it from here or from `navigation.ts`. */
export const DASHBOARD_PATH = "/";

/** The address the Dashboard answered at before it became the product's home. */
export const LEGACY_DASHBOARD_PATH = "/dashboard";

export function webRedirectRules(): RedirectRule[] {
  return [
    {
      source: LEGACY_DASHBOARD_PATH,
      destination: DASHBOARD_PATH,
      permanent: false,
    },
  ];
}
