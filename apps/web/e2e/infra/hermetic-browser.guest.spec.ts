import { expect, installBrowserStubs, test, type Page } from "../fixtures";
import { watchForIssues } from "../utils/page-issues";

/**
 * The shared Playwright infrastructure, tested on its own (E2E-006).
 *
 * Every other spec trusts two things: that `watchForIssues` really reports what a page does wrong,
 * and that the fixture's stubs keep logo traffic inside the browser. Both are proven here against a
 * page served entirely by Playwright — a made-up origin that never resolves — so the proof needs no
 * running application and cannot touch the network.
 */

const ORIGIN = "http://harness.e2e.invalid";

const PAGE = `<!doctype html>
<html>
  <body>
    <img id="logo" src="/api/logo/ZZLOGO" alt="">
    <button id="console" onclick="console.error('harness console error')">console</button>
    <button id="throw" onclick="setTimeout(() => { throw new Error('harness page error'); })">throw</button>
    <button id="missing" onclick="fetch('/missing')">missing</button>
    <button id="broken" onclick="fetch('/broken').catch(() => {})">broken</button>
    <button id="aborted" onclick="(() => { const c = new AbortController(); fetch('/slow', { signal: c.signal }).catch(() => {}); c.abort(); })()">aborted</button>
  </body>
</html>`;

/** A page that loads a provider image directly — the regression the context stub exists for. */
const PROVIDER_PAGE = `<!doctype html>
<html>
  <body>
    <img id="provider" src="https://images.financialmodelingprep.com/symbol/ZZLOGO.png" alt="">
  </body>
</html>`;

async function openHarness(page: Page, path = "/"): Promise<void> {
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") {
      return route.fulfill({ contentType: "text/html", body: PAGE });
    }
    if (path === "/provider") {
      return route.fulfill({ contentType: "text/html", body: PROVIDER_PAGE });
    }
    if (path === "/missing") {
      return route.fulfill({ status: 404, body: "not here" });
    }
    if (path === "/broken") {
      return route.abort("connectionreset");
    }
    if (path === "/slow") {
      // Never answered; the page aborts it itself.
      return undefined;
    }
    // Everything else — the logo, the provider image — is the shared context stubs' to answer.
    return route.fallback();
  });
  await page.goto(`${ORIGIN}${path}`);
}

test.describe("shared Playwright infrastructure", () => {
  test("answers every logo with the product's 204 miss and records the symbol", async ({
    page,
    logoRequests,
  }) => {
    const logo = page.waitForResponse("**/api/logo/ZZLOGO");
    await openHarness(page);

    const response = await logo;
    expect(response.status()).toBe(204);
    expect(response.headers()["cache-control"]).toBe("public, max-age=3600");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(logoRequests).toEqual(["ZZLOGO"]);
    // An empty 204 cannot decode, which is exactly what makes `StockLogo` fall back to a monogram.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const image = document.getElementById("logo") as HTMLImageElement;
          return image.complete && image.naturalWidth === 0;
        }),
      )
      .toBe(true);
  });

  test("blocks a direct provider image request inside the browser and records it", async ({
    page,
    context,
  }) => {
    const stubs = await installBrowserStubs(context);
    const issues = watchForIssues(page);
    await openHarness(page, "/provider");

    await expect
      .poll(() => stubs.providerRequests)
      .toEqual(["https://images.financialmodelingprep.com/symbol/ZZLOGO.png"]);
    // …and the page saw it fail, so a spec's own issue watcher reports it too.
    await expect
      .poll(() => issues.failedRequests)
      .toEqual([
        expect.stringMatching(
          /^GET https:\/\/images\.financialmodelingprep\.com\/symbol\/ZZLOGO\.png \(net::ERR_BLOCKED_BY_CLIENT/,
        ),
      ]);
    // Observed; now cleared so the fixture's own end-of-test check — which fails any other spec
    // that makes such a request — does not fail this one for the request it staged on purpose.
    stubs.providerRequests.length = 0;
  });

  test("reports console errors, page errors and failed requests, but not a cancellation", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    await openHarness(page);
    // Nothing is wrong with the page as loaded: the logo's 204 is a success, not a failure.
    await expect
      .poll(() =>
        page.evaluate(
          () => (document.getElementById("logo") as HTMLImageElement).complete,
        ),
      )
      .toBe(true);
    expect(issues).toEqual({
      consoleErrors: [],
      pageErrors: [],
      failedRequests: [],
    });

    await page.click("#aborted");
    await page.click("#console");
    await page.click("#throw");
    await page.click("#missing");
    await page.click("#broken");

    await expect.poll(() => issues.pageErrors).toEqual(["harness page error"]);
    await expect
      .poll(() => issues.consoleErrors)
      .toEqual(expect.arrayContaining(["harness console error"]));
    await expect
      .poll(() => [...issues.failedRequests].sort())
      .toEqual(
        [
          `404 ${ORIGIN}/missing`,
          `GET ${ORIGIN}/broken (net::ERR_CONNECTION_RESET)`,
        ].sort(),
      );
    // The page's own cancellation is not a failure.
    expect(issues.failedRequests.some((line) => line.includes("/slow"))).toBe(
      false,
    );
  });
});
