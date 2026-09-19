import {
  test as base,
  expect,
  type BrowserContext,
  type Route,
} from "@playwright/test";
import { LOGO_CONTENT_SECURITY_POLICY } from "../src/lib/security-headers";

/**
 * The one `test` every spec imports (E2E-006): Playwright's own, with the browser's external
 * traffic made hermetic for every page of every test.
 *
 * **Company logos.** `/api/logo/<symbol>` is the product's logo endpoint, and the web server
 * answers it by proxying the provider's image CDN — a live third-party call, and for the fictional
 * fixture tickers a guaranteed miss. Every context therefore answers it in the browser with the
 * **exact** miss response the real route gives since UX-005: `204 No Content`, cached for an hour,
 * with the logo route's own security headers. So the suite exercises the path a real user with a
 * logo-less ticker sees — the `StockLogo` monogram fallback, a clean console — and never reaches
 * the CDN. Each stubbed symbol is recorded (`logoRequests`), so a spec can prove the page really
 * asked.
 *
 * **Provider image hosts.** Nothing in the product loads a provider image directly; only the
 * server route knows its URL. A page that did would be a regression, so such a request is aborted
 * before it leaves the browser, recorded, and fails the test that made it — observable, and never
 * sent.
 *
 * Nothing here filters console errors or failed requests: `watchForIssues` (`utils/page-issues.ts`)
 * still sees everything the page does.
 */

export { expect };
export type { Browser, BrowserContext, Locator, Page } from "@playwright/test";

/** The miss contract of `src/app/api/logo/[symbol]/route.ts` (`missingLogo()`), byte for byte. */
export const MISSING_LOGO_RESPONSE = {
  status: 204,
  headers: {
    "Cache-Control": "public, max-age=3600",
    "Content-Security-Policy": LOGO_CONTENT_SECURITY_POLICY,
    "X-Content-Type-Options": "nosniff",
  },
  body: "",
} as const;

/** Hosts that serve provider imagery. The browser must never contact them. */
const PROVIDER_IMAGE_HOSTS =
  /^https?:\/\/([a-z0-9-]+\.)*financialmodelingprep\.com\//i;

export type BrowserStubs = {
  /** Symbols whose `/api/logo/<symbol>` the stub answered, in request order. */
  readonly logoRequests: string[];
  /** Provider URLs the browser tried to load directly. Always empty in a passing test. */
  readonly providerRequests: string[];
};

const stubsByContext = new WeakMap<BrowserContext, BrowserStubs>();

/**
 * Installs the shared stubs on a context. The `context` fixture does this for every test; a spec
 * that opens an extra context with `browser.newContext()` calls it on that one too.
 */
export async function installBrowserStubs(
  context: BrowserContext,
): Promise<BrowserStubs> {
  const existing = stubsByContext.get(context);
  if (existing) {
    return existing;
  }
  const stubs: BrowserStubs = { logoRequests: [], providerRequests: [] };
  stubsByContext.set(context, stubs);
  await context.route("**/api/logo/**", (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    stubs.logoRequests.push(decodeURIComponent(path.split("/").pop() ?? ""));
    return route.fulfill(MISSING_LOGO_RESPONSE);
  });
  await context.route(PROVIDER_IMAGE_HOSTS, (route: Route) => {
    stubs.providerRequests.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  return stubs;
}

/** Fails the test if any page in the context reached for a provider image directly. */
export function expectNoProviderRequests(stubs: BrowserStubs): void {
  expect(
    stubs.providerRequests,
    "The browser requested a provider image directly. Only /api/logo may know a provider URL; " +
      "the request was blocked before it left the browser.",
  ).toEqual([]);
}

export const test = base.extend<{ logoRequests: string[] }>({
  context: async ({ context }, use) => {
    const stubs = await installBrowserStubs(context);
    await use(context);
    expectNoProviderRequests(stubs);
  },
  logoRequests: async ({ context }, use) => {
    await use((await installBrowserStubs(context)).logoRequests);
  },
});
