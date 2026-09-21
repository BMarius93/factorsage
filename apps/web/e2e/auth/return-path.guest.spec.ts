import { expect, test, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";
import { qaPersona } from "../utils/env";
import { submitSignInForm } from "../utils/sign-in";

/**
 * Where password sign-in lands (UX-003): the page the visitor came from, never anywhere else.
 *
 * Signs in as an existing seeded persona through the real form. Creates no account and sends no
 * email. Needs `pnpm test:personas:seed` (for the built-in strategy the prefill names).
 */

const QA_STRATEGY = "QA Built-in Trend";

async function builtInStrategyId(page: Page): Promise<string> {
  const response = await page.request.get(`${apiBaseUrl()}/strategies`);
  const body = (await response.json()) as { id: string; name: string }[];
  const strategy = body.find((entry) => entry.name === QA_STRATEGY);
  if (!strategy) {
    throw new Error(`${QA_STRATEGY} is missing; run pnpm test:builtins:seed`);
  }
  return strategy.id;
}

test.describe("sign-in return destination", () => {
  test("returns a Guest bounced from a protected URL to that exact URL, prefill included", async ({
    page,
  }) => {
    const strategyId = await builtInStrategyId(page);
    const attempted = `/backtests/new?strategyId=${encodeURIComponent(strategyId)}`;

    await page.goto(attempted);
    // The route gate keeps the attempted URL, query and all.
    await expect(page).toHaveURL(
      `/login?next=${encodeURIComponent(attempted)}`,
    );

    await submitSignInForm(page, qaPersona("PRO_USER"));

    await expect(page).toHaveURL(attempted);
    await expect(page.getByTestId("account-menu-trigger")).toBeVisible();
  });

  for (const hostile of [
    "//evil.example",
    "/\\evil.example",
    "https://evil.example",
    "javascript:alert(1)",
    "/%2F%2Fevil.example",
    "/%252F%252Fevil.example",
  ]) {
    test(`lands on the Dashboard, on this origin, for next=${JSON.stringify(hostile)}`, async ({
      page,
      baseURL,
    }) => {
      const hosts = new Set<string>();
      page.on("request", (request) =>
        hosts.add(new URL(request.url()).hostname),
      );

      await page.goto(`/login?next=${encodeURIComponent(hostile)}`);
      await submitSignInForm(page, qaPersona("PRO_USER"));

      await expect(page).toHaveURL("/");
      expect(new URL(page.url()).origin).toBe(new URL(baseURL ?? "").origin);
      // The browser never so much as asked the hostile host for anything.
      expect(
        [...hosts].filter((host) => host.includes("evil.example")),
      ).toEqual([]);
    });
  }
});
