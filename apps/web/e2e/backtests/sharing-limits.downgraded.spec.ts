import type { BacktestRunSummaryResponse } from "@intrinsic/contracts";
import { expect, test } from "../fixtures";
import { apiBaseUrl, fixtureName } from "../utils/entitlements";
import {
  closeReaderContext,
  enableShareThroughDialog,
  readerContext,
  revokeShareIfPresent,
} from "../utils/sharing";

/**
 * Reading a shared backtest never depends on the reader's plan
 * (`docs/decisions/backtest-sharing-v1.md`).
 *
 * DOWNGRADED_USER owns the entitlement fixtures' "historic" run: twenty years over eighty-three
 * securities, completed while the account was on a larger plan. Starter allows fifteen years and
 * fifty securities, Free five and ten — so neither could run it, or rebuild it. The owner shares
 * it; a Starter user, a Free user and a Guest all read it in full. Sharing a completed run is open
 * to every plan, including one the run no longer fits.
 *
 * The run is left unshared afterwards, so the fixture is exactly what the seeder wrote.
 */

const HISTORIC_RUN = fixtureName("Historic Run");

test.describe("a shared run beyond the reader's plan", () => {
  let runId = "";

  test.afterEach(async ({ page }) => {
    if (runId) {
      await revokeShareIfPresent(page.request, runId);
    }
  });

  test("is read in full by Starter, Free and Guest readers alike", async ({
    page,
    browser,
  }) => {
    const runs = (await (
      await page.request.get(`${apiBaseUrl()}/backtests`)
    ).json()) as BacktestRunSummaryResponse[];
    const historic = runs.find(
      (run) => run.strategyName === HISTORIC_RUN && run.status === "COMPLETED",
    );
    test.skip(
      !historic,
      "The entitlement fixtures' historic run is missing. Run `pnpm test:personas:seed`.",
    );
    runId = historic?.id ?? "";

    const shareUrl = await enableShareThroughDialog(page, runId);

    for (const persona of ["STARTER_USER", "FREE_USER", "GUEST"] as const) {
      const context = await readerContext(browser, persona);
      const reader = await context.newPage();
      expect((await reader.goto(shareUrl))?.status(), persona).toBe(200);
      await expect(
        reader.getByTestId("shared-backtest"),
        persona,
      ).toBeVisible();
      await expect(
        reader.getByTestId("shared-backtest-security-count"),
        persona,
      ).toHaveText("83");
      await expect(reader.getByRole("heading", { level: 1 })).toHaveText(
        /^Run #\d{4,}$/,
      );
      await expect(
        reader.getByTestId("shared-backtest-metadata"),
        persona,
      ).toContainText("Shared backtest report");
      // Every figure is there; nothing is locked, blurred or offered as an upgrade.
      await expect(reader.getByTestId("metric-cagr"), persona).toContainText(
        "+3.20%",
      );
      await expect(reader.getByText(/upgrade|unlock/i)).toHaveCount(0);
      await expect(
        reader.getByTestId("entitlement-see-plans"),
        persona,
      ).toHaveCount(0);
      // And reading it started nothing on the reader's account.
      if (persona !== "GUEST") {
        const own = (await (
          await reader.request.get(`${apiBaseUrl()}/backtests`)
        ).json()) as BacktestRunSummaryResponse[];
        expect(
          own.some((run) => run.id === runId),
          `${persona} now lists the shared run as their own`,
        ).toBe(false);
      }
      await closeReaderContext(context);
    }
  });
});
