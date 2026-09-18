import type { Page } from "@playwright/test";

/**
 * Answers every `/api/logo/*` request in the browser the way the real endpoint answers a security
 * with no upstream mark: `204 No Content`, cached for an hour (UX-005).
 *
 * The real route proxies the provider's image CDN from the web server, which a hermetic spec must
 * not reach. Fulfilling at the browser keeps the component's contract under test — the monogram
 * fallback and a clean console — without any provider traffic. The route's own miss/failure
 * behaviour is covered by `src/app/api/logo/[symbol]/route.test.ts`.
 */
export async function serveLogosAsMissing(page: Page): Promise<void> {
  await page.route("**/api/logo/**", (route) =>
    route.fulfill({
      status: 204,
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      },
      body: "",
    }),
  );
}
